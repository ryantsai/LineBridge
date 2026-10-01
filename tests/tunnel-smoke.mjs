// Explicit live Cloudflare smoke check. Uses a disposable, synthetic-only database.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {once} from 'node:events';
import {lookup,Resolver} from 'node:dns/promises';
import {request as httpsRequest} from 'node:https';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const root=process.cwd(),data=mkdtempSync(join(tmpdir(),'linebridge-tunnel-test-'));
const admin='http://127.0.0.1:4520',gateway='http://127.0.0.1:4521';
const service=spawn(process.execPath,[join(root,'bin/linebridge.mjs'),'serve'],{cwd:root,env:{...process.env,LINE_BRIDGE_DATA:data,LINE_BRIDGE_ADMIN_PORT:'4520',LINE_BRIDGE_GATEWAY_PORT:'4521'},stdio:'ignore',windowsHide:true});
let call,client;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function dohFetchFor(hostname) {
  let address;
  for(let i=0;i<40;i++){
    const result=await fetch(`https://cloudflare-dns.com/dns-query?name=${hostname}&type=A`,{headers:{Accept:'application/dns-json'}}).then(r=>r.json());
    address=result.Answer?.find(a=>a.type===1)?.data;if(address)break;await wait(2000);
  }
  assert.match(address||'',/^\d+\.\d+\.\d+\.\d+$/,'DoH did not resolve the Quick Tunnel');
  // Test-only resolver override. TLS still verifies the original hostname; no OS DNS changes.
  return async(input,init={})=>{
    const url=new URL(input instanceof Request?input.url:input);assert.equal(url.hostname,hostname);assert.equal(url.protocol,'https:');
    const reqInput=input instanceof Request?input:null;
    const headers=Object.fromEntries(new Headers(init.headers||reqInput?.headers));
    const body=init.body??(reqInput&&reqInput.body?await reqInput.arrayBuffer():null);
    return new Promise((resolve,reject)=>{
      const req=httpsRequest(url,{method:init.method||reqInput?.method||'GET',headers,signal:init.signal||reqInput?.signal,lookup:(_host,opts,cb)=>cb(null,opts.all?[{address,family:4}]:address,4)},res=>{
        const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{const status=res.statusCode;resolve(new Response([204,205,304].includes(status)?null:Buffer.concat(chunks),{status,headers:res.headers}));});res.on('error',reject);
      });req.on('error',reject);if(body)req.write(typeof body==='string'?body:Buffer.from(body));req.end();
    });
  };
}
try {
  for(let i=0;i<100;i++){try{if((await fetch(`${gateway}/health`)).ok)break;}catch{}await wait(100);}
  const page=await fetch(admin),cookie=page.headers.get('set-cookie').split(';')[0];
  call=async(path,method='GET',value)=>{const res=await fetch(`${admin}/admin${path}`,{method,headers:{Cookie:cookie,Origin:admin,'X-Line-Bridge':'dashboard','Content-Type':'application/json'},...(value?{body:JSON.stringify(value)}:{})});const result=await res.json();assert.equal(res.ok,true,JSON.stringify(result));return result;};
  const account=await call('/accounts','POST',{label:'synthetic tunnel check',kind:'demo'});
  const token=await call('/tokens','POST',{name:'synthetic reader',days:1,grants:[{accountId:account.id,read:true,send:false}]});
  await call('/tunnel','PUT',{provider:'cloudflare_quick'});
  await call('/tunnel/start','POST',{});
  let tunnel;
  for(let i=0;i<60;i++){tunnel=(await call('/state')).tunnel;if(tunnel.connected&&tunnel.url)break;if(tunnel.status==='failed')throw new Error('cloudflared exited before connecting');await wait(1000);}
  assert.equal(tunnel.connected,true,'Quick Tunnel did not become ready');assert.match(tunnel.url,/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/);
  if(process.env.LINE_BRIDGE_DNS_DIAGNOSTIC){
    const hostname=new URL(tunnel.url).hostname,resolver=new Resolver();resolver.setServers(['1.1.1.1']);
    const checks=await Promise.allSettled([lookup(hostname),resolver.resolve4(hostname)]);
    console.log('Synthetic Quick Tunnel DNS diagnostics:',hostname,checks.map(r=>r.status==='fulfilled'?r.value:r.reason.code));
  }
  const tunnelFetch=process.env.LINE_BRIDGE_TUNNEL_DOH?await dohFetchFor(new URL(tunnel.url).hostname):fetch;
  let health,lastError;
  for(let i=0;i<45;i++){try{health=await tunnelFetch(`${tunnel.url}/health`,{signal:AbortSignal.timeout(6000)});if(health.ok)break;lastError=`HTTP ${health.status}`;}catch(error){lastError=error.cause?.code||error.message;}await wait(2000);}
  assert.equal(health?.status,200,`Public endpoint did not respond: ${lastError}`);assert.equal((await health.json()).service,'LineBridge');
  assert.equal((await tunnelFetch(`${tunnel.url}/api/v1/accounts`)).status,401);
  const headers={Authorization:`Bearer ${token.token}`};
  const accounts=await tunnelFetch(`${tunnel.url}/api/v1/accounts`,{headers});assert.equal(accounts.status,200);assert.equal((await accounts.json()).length,1);
  assert.equal((await tunnelFetch(`${tunnel.url}/admin/state`,{headers})).status,404);
  client=new Client({name:'Quick Tunnel JSON MCP check',version:'1.0'});
  await client.connect(new StreamableHTTPClientTransport(new URL(`${tunnel.url}/mcp`),{requestInit:{headers},fetch:tunnelFetch}));
  assert.equal((await client.listTools()).tools.length,5);
  await client.close();client=null;
  await call('/tunnel/stop','POST',{});const stopped=(await call('/state')).tunnel;
  assert.equal(stopped.connected,false);assert.equal(stopped.url,null);assert.equal(stopped.hostname,'');
  console.log('Live Quick Tunnel: HTTPS ready, unauthenticated API denied, scoped API and JSON MCP work, dashboard unavailable, stop clears URL. Synthetic accounts only.');
} finally {
  await client?.close().catch(()=>{});if(call)await call('/tunnel/stop','POST',{}).catch(()=>{});
  service.kill();if(service.exitCode===null)await once(service,'exit');
  const target=resolve(data),parent=resolve(tmpdir())+sep;if(!target.startsWith(parent)||!target.slice(parent.length).startsWith('linebridge-tunnel-test-'))throw new Error('Refusing unsafe cleanup');rmSync(target,{recursive:true,force:true});
}
