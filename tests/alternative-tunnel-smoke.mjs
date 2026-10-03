import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {startService} from '../server/main.mjs';
import {adminActor} from '../server/hub.mjs';
import {forwardFetch,publicFetch} from './tunnel-transport.mjs';

const provider=process.argv[2];assert.ok(['tailcat','tailscale_funnel','ngrok'].includes(provider),'Choose tailcat, tailscale_funnel or ngrok');
const data=await mkdtemp(join(tmpdir(),'linebridge-alternative-')),port=23841,wait=ms=>new Promise(r=>setTimeout(r,ms));
let service,forward,client;
try{
  await mkdir(data,{recursive:true});service=await startService({root:process.cwd(),dataDir:data,adminPort:port-1,gatewayPort:port});
  const {hub,tunnels}=service,account=await hub.addAccount({label:'Synthetic connection test',kind:'demo'});hub.designate(account.id,'demo-group',true);await hub.monitor(account.id,true);
  hub.capture(account.id,'demo-group',{id:'alternative-check',text:'test 會議 مرحبا 🦜'});
  const token=hub.createToken({name:'Synthetic reader',grants:[{accountId:account.id,read:true,send:false}]});
  tunnels.configure({provider,...(provider==='tailscale_funnel'?{httpsPort:443}:{})});
  if(provider==='ngrok'){assert.ok(process.env.LINE_BRIDGE_TEST_NGROK_TOKEN,'Provide the test ngrok token via environment');tunnels.setNgrokToken(process.env.LINE_BRIDGE_TEST_NGROK_TOKEN);}
  const start=await tunnels.start();if(start.authUrl)throw new Error('Tailscale Funnel needs device authorization; open its consent link from the dashboard.');
  let status;for(let i=0;i<60;i++){status=await tunnels.status();if(status.connected)break;if(status.status==='connector_failed')throw new Error('Connector failed to start');await wait(1000);}
  assert.equal(status.connected,true,'Connector did not become ready');
  let base=status.url,transport=provider==='tailscale_funnel'?await publicFetch(new URL(status.url).hostname):fetch,headers=provider==='ngrok'?{'ngrok-skip-browser-warning':'LineBridge'}:{};
  if(provider==='tailcat'){
    forward=spawn(tunnels.tailcat,['forward','--bind=127.0.0.1',status.tailcat.address,`${port+5}:${port}`],{stdio:['ignore','ignore','pipe'],windowsHide:true});forward.on('error',()=>{});
    base=`http://127.0.0.1:${port+5}`;transport=forwardFetch(port);
  }
  let health;for(let i=0;i<45;i++){try{health=await transport(base+'/health',{headers,signal:AbortSignal.timeout(4000)});if(health.ok)break;}catch{}await wait(1000);}
  assert.equal(health?.status,200,'Tunnel health not reachable');assert.equal((await health.json()).service,'LineBridge');
  assert.equal((await transport(base+'/api/v1/accounts',{headers})).status,401);
  headers.Authorization=`Bearer ${token.token}`;assert.equal((await transport(base+'/api/v1/accounts',{headers})).status,200);assert.equal((await transport(base+'/admin/state',{headers})).status,404);
  client=new Client({name:'Alternative tunnel check',version:'1.0'});await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers},fetch:transport}));assert.equal((await client.listTools()).tools.length,6);
  const result=await client.callTool({name:'line_search_messages',arguments:{query:'會議 مرحبا'}});assert.equal(result.isError,undefined);assert.equal(JSON.parse(result.content[0].text).results.length,1);
  await client.close();client=null;await tunnels.stop();assert.equal((await tunnels.status()).connected,false);
  console.log(provider+': live transport, token enforcement, scoped HTTP/MCP multilingual search, admin isolation and owned connector cleanup passed. Synthetic data only.');
}finally{
  await client?.close().catch(()=>{});if(forward&&forward.exitCode===null&&forward.signalCode===null){forward.kill();await once(forward,'exit').catch(()=>{});}
  await service?.shutdown();const target=resolve(data);if(!target.startsWith(resolve(tmpdir())+sep)||!target.split(sep).at(-1).startsWith('linebridge-alternative-'))throw Error('Unsafe test cleanup');await rm(target,{recursive:true,force:true});
}
