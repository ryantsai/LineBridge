#!/usr/bin/env node
import {parseArgs} from 'node:util';
import {resolve} from 'node:path';
import {VERSION} from '../server/version.mjs';

const help=`LineBridge ${VERSION} — headless LINE MCP / HTTP gateway

Usage: linebridge [serve|status|stop] [options]

  serve                    Run in the foreground (default)
  status                   Inspect the service for this data directory
  stop                     Gracefully stop that service
  --data-dir DIR           Persistent SQLite and encrypted vault directory
  --admin-port PORT        Local dashboard (default 3210)
  --gateway-port PORT      Local AI gateway (default 3211)
  --version                Print version
  --help                   Print this help

Node.js 24+ required. No desktop runtime, Rust or compiler.
Environment: LINE_BRIDGE_DATA, LINE_BRIDGE_ADMIN_PORT, LINE_BRIDGE_GATEWAY_PORT.
Both listeners bind to 127.0.0.1. AI requests require a scoped Bearer token.
`;
async function main(){
  const {values,positionals}=parseArgs({allowPositionals:true,options:{'data-dir':{type:'string'},'admin-port':{type:'string'},'gateway-port':{type:'string'},version:{type:'boolean'},help:{type:'boolean'}}});
  if(values.help){console.log(help);return;}if(values.version){console.log(VERSION);return;}
  if(Number(process.versions.node.split('.')[0])<24)throw new Error('LineBridge requires Node.js 24 or newer.');
  const command=positionals[0]??'serve';if(positionals.length>1||!['serve','status','stop'].includes(command))throw new Error('Use linebridge serve, status or stop. See --help.');
  const {startService,defaultDataDirectory,metadata,validPort}=await import('../server/main.mjs');
  const dataDir=values['data-dir']?resolve(values['data-dir']):defaultDataDirectory();
  if(command==='serve'){
    const service=await startService({dataDir,...(values['admin-port']?{adminPort:Number(values['admin-port'])}:{}),...(values['gateway-port']?{gatewayPort:Number(values['gateway-port'])}:{})});
    console.log(`LineBridge ${VERSION}\nDashboard: http://localhost:${service.adminPort}\nAI gateway: http://127.0.0.1:${service.gatewayPort}\nData: ${service.dataDir}`);return;
  }
  const m=await metadata(dataDir);
  if(!m||m.runtime!=='node'||!validPort(m.adminPort)||typeof m.instance!=='string'||m.dataDir!==dataDir){console.log(JSON.stringify({status:'stopped',dataDir}));return;}
  const base=`http://127.0.0.1:${m.adminPort}`;
  const request=(path,options={})=>fetch(`${base}${path}`,{...options,redirect:'error',signal:AbortSignal.timeout(7000)});
  let cookie,state;
  try{
    const index=await request('/');cookie=index.headers.getSetCookie()[0]?.split(';')[0];if(!index.ok||!cookie)throw new Error('No dashboard session.');
    const response=await request('/admin/state',{headers:{Cookie:cookie}});if(!response.ok)throw new Error('No service state.');state=await response.json();
  }catch{console.log(JSON.stringify({status:'unavailable',dataDir,pid:m.pid}));process.exitCode=1;return;}
  if(state.instance!==m.instance)throw new Error('The service instance has changed. Refusing to stop an unrelated process.');
  if(command==='status'){console.log(JSON.stringify({status:'running',version:state.version,backend:state.backend,pid:m.pid,adminPort:m.adminPort,gatewayPort:m.gatewayPort,dataDir,accounts:state.accounts.length}));return;}
  const response=await request('/admin/shutdown',{method:'POST',headers:{Cookie:cookie,Origin:base,'X-Line-Bridge':'dashboard','Content-Type':'application/json'},body:JSON.stringify({instance:m.instance})});
  if(!response.ok)throw new Error('The service could not be stopped.');
  console.log(JSON.stringify({status:'stopping',dataDir}));
}
try{await main();}catch(error){console.error(error?.code==='EADDRINUSE'?'A LineBridge port is already in use.':error?.status?`${error.code}: ${error.message}`:error.message??'LineBridge could not complete the command.');process.exitCode=1;}
