// Run from the cloud VM. Node 18+; no LINE calls, npm dependencies or sends.
import {lookup} from 'node:dns/promises';
const input=process.argv[2]??process.env.LINE_BRIDGE_URL;if(!input)throw Error('Usage: node probe-connection.mjs URL (optional LINE_BRIDGE_TOKEN environment)');
const url=new URL(input);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw Error('Use a gateway origin without credentials or query parameters');url.pathname='/';
const headers={'ngrok-skip-browser-warning':'LineBridge'};
const checks=[];function report(check,ok,detail){checks.push({check,ok,detail});console.log(JSON.stringify({check,ok,detail}));}
async function request(path,options={}){return fetch(new URL(path,url),{headers,...options,redirect:'error',signal:AbortSignal.timeout(15000)});}
try{await lookup(url.hostname);report('dns',true,'Resolved');}catch(e){report('dns',false,e.code??'resolution_failed');process.exitCode=1;}
let ready=false;
try{const response=await request('/health');const body=await response.json();ready=response.ok&&body.service==='LineBridge';report('health',ready,{status:response.status,service:body.service,version:body.version});}catch(e){report('health',false,e.cause?.code??e.name);}
if(ready){
  const anonymous=await request('/api/v1/accounts');report('anonymous_denied',anonymous.status===401,{status:anonymous.status});
  if(process.env.LINE_BRIDGE_TOKEN){
    headers.Authorization='Bearer '+process.env.LINE_BRIDGE_TOKEN;
    const accounts=await request('/api/v1/accounts');report('scoped_api',accounts.ok,{status:accounts.status});
    const admin=await request('/admin/state');report('admin_unavailable',admin.status===404,{status:admin.status});
    const rpc=async(method,params,id)=>{const response=await request('/mcp',{method:'POST',headers:{...headers,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',method,params,...(id?{id}:{})})});if(!response.ok)throw Error('MCP HTTP '+response.status);return response.status===202?null:response.json();};
    try{const init=await rpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'LineBridge cloud probe',version:'1.0'}},1);if(init.error)throw Error('MCP initialize rejected');await rpc('notifications/initialized',{});const tools=await rpc('tools/list',{},2);report('mcp',Array.isArray(tools.result?.tools),{tools:tools.result?.tools?.map(t=>t.name)});}catch(e){report('mcp',false,e.message);}
  }else report('token_checks',true,'Skipped: set LINE_BRIDGE_TOKEN to test scoped API and MCP.');
}
if(checks.some(c=>!c.ok))process.exitCode=1;
