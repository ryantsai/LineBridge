import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../server/store.mjs';
import { Vault } from '../server/vault.mjs';
import { Hub } from '../server/hub.mjs';
import { Tunnels } from '../server/tunnels.mjs';
import { createApps } from '../server/app.mjs';

async function freePort(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port;}
async function rawStatus(url,headers){return new Promise((resolve,reject)=>{const req=request(url,{headers},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});}
test('HTTP and MCP share scopes; the gateway cannot expose dashboard routes or bypass Cloudflare Access',async t=>{
  const store=new Store(':memory:'),vault=new Vault(randomBytes(32),'test'),hub=new Hub(store,vault);
  const adminPort=await freePort(),gatewayPort=await freePort(),root=resolve('.'),tunnels=new Tunnels(store,vault,root,gatewayPort);
  const apps=createApps({hub,tunnels,root,adminPort,gatewayPort});
  const adminServer=apps.admin.listen(adminPort,'127.0.0.1'),gatewayServer=apps.gateway.listen(gatewayPort,'127.0.0.1');
  t.after(()=>{hub.close();tunnels.close();adminServer.closeAllConnections();gatewayServer.closeAllConnections();adminServer.close();gatewayServer.close();store.close();});
  const a=await hub.addAccount({label:'Test sandbox',kind:'demo'});hub.designate(a.id,'demo-group',true);
  const token=hub.createToken({name:'AI',grants:[{accountId:a.id,read:true,send:true}]});
  const base=`http://127.0.0.1:${gatewayPort}`,headers={Authorization:`Bearer ${token.token}`};
  assert.equal((await fetch(`${base}/api/v1/accounts`)).status,401);
  assert.equal((await fetch(`${base}/api/v1/accounts`,{headers:{...headers,Origin:'https://attacker.example'}})).status,403);
  assert.equal(await rawStatus(`${base}/api/v1/accounts`,{...headers,Host:'attacker.example'}),403);
  assert.equal((await fetch(`${base}/admin/state`,{headers})).status,404);
  const endpoint=`${base}/api/v1/accounts/${a.id}/chats/demo-group/messages`;
  assert.equal((await fetch(endpoint,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{"text":"hello"}'})).status,400);
  const first=await fetch(endpoint,{method:'POST',headers:{...headers,'Content-Type':'application/json','Idempotency-Key':'http-send-001'},body:'{"text":"hello"}'});
  assert.equal(first.status,200);assert.equal((await first.json()).delivery,'sandbox_only');
  const read=await (await fetch(endpoint,{headers})).json();assert.ok(read.messages.some(m=>m.text==='hello'));
  const client=new Client({name:'integration-test',version:'1.0.0'});
  const transport=new StreamableHTTPClientTransport(new URL(`${base}/mcp`),{requestInit:{headers}});
  await client.connect(transport);t.after(()=>client.close());
  const toolList=await client.listTools();assert.equal(toolList.tools.length,4);
  const result=await client.callTool({name:'line_read_messages',arguments:{accountId:a.id,chatId:'demo-group',limit:10}});
  assert.equal(JSON.parse(result.content[0].text).untrustedContent,true);
  const denied=await client.callTool({name:'line_read_messages',arguments:{accountId:a.id,chatId:'demo-openchat'}});assert.equal(denied.isError,true);
  const local=`http://127.0.0.1:${adminPort}`;
  assert.equal((await fetch(`${local}/admin/state`)).status,401);
  const index=await fetch(`${local}/`),cookie=index.headers.getSetCookie()[0].split(';')[0];assert.equal(index.status,200);
  assert.equal((await fetch(`${local}/admin/pause`,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:'{"enabled":false}'})).status,403);
  assert.equal(await rawStatus(`${local}/admin/state`,{Cookie:cookie,Host:'evil.example'}),403);
  store.setSetting('tunnel',{provider:'cloudflare',hostname:'line.example.com',teamDomain:'example.cloudflareaccess.com',audience:'test-audience'});
  // A localhost or forwarded-host header cannot disable the configured Access requirement.
  assert.equal((await fetch(`${base}/api/v1/accounts`,{headers})).status,401);
  assert.equal((await fetch(`${base}/api/v1/accounts`,{headers:{...headers,'CF-Access-Jwt-Assertion':'fake'}})).status,401);
  assert.equal((await fetch(`${base}/health`)).status,200);
});
