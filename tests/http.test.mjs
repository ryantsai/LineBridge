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
  assert.equal((await fetch(`${base}/api/v1/accounts`)).status,200);
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
  const toolList=await client.listTools();assert.equal(toolList.tools.length,5);
  const result=await client.callTool({name:'line_read_messages',arguments:{accountId:a.id,chatId:'demo-group',limit:10}});
  assert.equal(JSON.parse(result.content[0].text).untrustedContent,true);
  const denied=await client.callTool({name:'line_read_messages',arguments:{accountId:a.id,chatId:'demo-openchat'}});assert.equal(denied.isError,true);
  const local=`http://127.0.0.1:${adminPort}`;
  assert.equal((await fetch(`${local}/admin/state`)).status,401);
  const index=await fetch(`${local}/`),cookie=index.headers.getSetCookie()[0].split(';')[0];assert.equal(index.status,200);
  assert.equal((await fetch(`${local}/admin/pause`,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:'{"enabled":false}'})).status,403);
  assert.equal(await rawStatus(`${local}/admin/state`,{Cookie:cookie,Host:'evil.example'}),403);
  const badCallback=await fetch(`${local}/oauth/cloudflare/callback?state=wrong&code=untrusted-secret`,{headers:{'Sec-Fetch-Site':'cross-site'}});
  assert.equal(badCallback.status,400);assert.equal(badCallback.headers.getSetCookie().length,0);assert.ok(!(await badCallback.text()).includes('untrusted-secret'));
  assert.equal(await rawStatus(`${local}/oauth/cloudflare/callback`,{Host:'evil.example','Sec-Fetch-Site':'cross-site'}),403);
  store.setSetting('tunnel',{provider:'cloudflare_quick',hostname:'',teamDomain:'',audience:''});tunnels.quickHost='test-tunnel.trycloudflare.com';
  assert.equal(await rawStatus(`${base}/api/v1/accounts`,{...headers,Host:tunnels.quickHost}),200);
  assert.equal(await rawStatus(`${base}/api/v1/accounts`,{Host:tunnels.quickHost}),401);
  tunnels.quickHost=null;assert.equal(await rawStatus(`${base}/api/v1/accounts`,{...headers,Host:'test-tunnel.trycloudflare.com'}),403);
  store.setSetting('tunnel',{provider:'cloudflare',hostname:'line.example.com',teamDomain:'example.cloudflareaccess.com',audience:'test-audience'});
  // A localhost or forwarded-host header cannot disable the configured Access requirement.
  assert.equal((await fetch(`${base}/api/v1/accounts`,{headers})).status,401);
  assert.equal((await fetch(`${base}/api/v1/accounts`,{headers:{...headers,'CF-Access-Jwt-Assertion':'fake'}})).status,401);
  assert.equal((await fetch(`${base}/health`)).status,200);
});

async function localGateway(t,requireToken=false){
  const store=new Store(':memory:'),vault=new Vault(randomBytes(32),'test'),hub=new Hub(store,vault),adminPort=await freePort(),gatewayPort=await freePort(),root=resolve('.'),tunnels=new Tunnels(store,vault,root,gatewayPort);
  const apps=createApps({hub,tunnels,root,adminPort,gatewayPort,requireToken}),admin=apps.admin.listen(adminPort,'127.0.0.1'),gateway=apps.gateway.listen(gatewayPort,'127.0.0.1');
  t.after(()=>{hub.close();tunnels.close();for(const s of [admin,gateway]){s.closeAllConnections();s.close();}store.close();});
  return {store,hub,base:`http://127.0.0.1:${gatewayPort}`,adminBase:`http://127.0.0.1:${adminPort}`};
}
test('same-VM HTTP and official MCP clients read/send without minting a token',async t=>{
  const {hub,store,base,adminBase}=await localGateway(t);
  assert.deepEqual(await (await fetch(`${base}/api/v1/accounts`)).json(),[]);
  const setup=await (await fetch(`${base}/api/v1/status`)).json();assert.equal(setup.authentication,'local');assert.equal(setup.setup.mcp,`${base}/mcp`);
  const a=await hub.addAccount({label:'Local sandbox',kind:'demo'});hub.designate(a.id,'demo-group',true);
  const endpoint=`${base}/api/v1/accounts/${a.id}/chats/demo-group/messages`;
  const sent=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'local-http-001'},body:JSON.stringify({text:'local synthetic message'})});assert.equal(sent.status,200);
  const client=new Client({name:'same-VM-agent',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));t.after(()=>client.close());
  assert.equal((await client.listTools()).tools.length,5);
  const read=await client.callTool({name:'line_read_messages',arguments:{accountId:a.id,chatId:'demo-group'}});assert.ok(JSON.parse(read.content[0].text).messages.some(m=>m.text==='local synthetic message'));
  const mcpSent=await client.callTool({name:'line_send_message',arguments:{accountId:a.id,chatId:'demo-group',text:'MCP synthetic message',idempotencyKey:'local-mcp-001'}});assert.equal(JSON.parse(mcpSent.content[0].text).delivery,'sandbox_only');
  const index=await fetch(adminBase),cookie=index.headers.getSetCookie()[0].split(';')[0];
  const update=await fetch(`${adminBase}/admin/accounts/${a.id}/local-access`,{method:'PUT',headers:{Cookie:cookie,Origin:adminBase,'X-Line-Bridge':'dashboard','Content-Type':'application/json'},body:JSON.stringify({read:true,send:false})});assert.equal(update.status,200);
  const denied=await client.callTool({name:'line_send_message',arguments:{accountId:a.id,chatId:'demo-group',text:'forbidden',idempotencyKey:'local-mcp-002'}});assert.equal(denied.isError,true);assert.equal(JSON.parse(denied.content[0].text).error,'scope_denied');
  assert.equal(hub.tokens().length,0);
  for(const headers of [{Authorization:'Bearer wrong'},{Authorization:'Basic anything'},{Forwarded:'for=203.0.113.9'},{'X-Forwarded-For':'203.0.113.9'},{'CF-Connecting-IP':'203.0.113.9'}])assert.equal((await fetch(`${base}/api/v1/accounts`,{headers})).status,401);
  for(const headers of [{Origin:'http://localhost'},{Referer:'https://attacker.example/'},{'Sec-Fetch-Site':'cross-site'},{'Sec-Fetch-Mode':'navigate'},{'Sec-Fetch-Dest':'document'}])assert.equal(await rawStatus(`${base}/api/v1/accounts`,headers),403);
  const token=hub.createToken({name:'Reader only',grants:[{accountId:a.id,read:true,send:false}]});
  assert.equal((await fetch(endpoint,{method:'POST',headers:{Authorization:`Bearer ${token.token}`,'Content-Type':'application/json','Idempotency-Key':'token-local-001'},body:'{"text":"forbidden"}'})).status,403);
  store.revoke(token.id);assert.equal((await fetch(`${base}/api/v1/accounts`,{headers:{Authorization:`Bearer ${token.token}`}})).status,401);
  store.setSetting('aiEnabled',false);assert.equal((await fetch(`${base}/api/v1/accounts`)).status,503);store.setSetting('aiEnabled',true);
  for(const provider of ['cloudflare_quick','tailscale','cloudflare']){store.setSetting('tunnel',{provider,hostname:'',teamDomain:'',audience:''});assert.equal((await fetch(`${base}/api/v1/accounts`)).status,401,provider);}
  store.setSetting('tunnel',{provider:'local',hostname:'',teamDomain:'',audience:''});assert.equal((await fetch(`${base}/api/v1/accounts`)).status,200);
});
test('strict token mode keeps localhost authenticated',async t=>{
  const {hub,base}=await localGateway(t,true),a=await hub.addAccount({label:'Strict sandbox',kind:'demo'});
  assert.equal((await fetch(`${base}/api/v1/accounts`)).status,401);
  const token=hub.createToken({name:'Strict reader',grants:[{accountId:a.id,read:true,send:false}]});
  const state=await (await fetch(`${base}/api/v1/status`,{headers:{Authorization:`Bearer ${token.token}`}})).json();assert.equal(state.authentication,'token');
});
