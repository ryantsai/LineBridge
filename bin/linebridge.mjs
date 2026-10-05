#!/usr/bin/env node
import {parseArgs} from 'node:util';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {access} from 'node:fs/promises';
import {VERSION} from '../server/version.mjs';

const help=`LineBridge ${VERSION} — local LINE MCP / HTTP gateway

Usage: linebridge [serve|tray|status|stop] [options]
       linebridge discover|version|accounts|chats|read|refresh|search|events|send|auth [options]

  serve                    Run in the foreground without a tray icon (default)
  tray                     Open the portable Windows/macOS tray launcher
  status                   Inspect the service for this data directory
  stop                     Gracefully stop that service
  --data-dir DIR           Persistent SQLite and encrypted vault directory
  --admin-port PORT        Local dashboard (default 3210)
  --gateway-port PORT      Local AI gateway (default 3211)
  --require-token          Require a Bearer token even for direct localhost
  --trust-local            Opt in to token-free direct loopback development
  --version                Print the installed CLI version
  --help                   Print this help

Data client: linebridge accounts --help (JSON stdout, diagnostics on stderr).
Local AI setup: linebridge discover [--data-dir DIR] (no profile required).
Gateway app version: linebridge version [--profile NAME].
See CLI.md for scoped credentials, pagination and explicit sends.

Portable archives bundle Node. npm/source installs need Node.js 24+.
Environment: LINE_BRIDGE_DATA, LINE_BRIDGE_ADMIN_PORT, LINE_BRIDGE_GATEWAY_PORT,
             LINE_BRIDGE_TRUST_LOCAL=1 (development only).
Both listeners bind to 127.0.0.1. Scoped Bearer tokens are required by default.
Run on your PC and expose only the AI gateway through a tunnel.
`;
async function main(){
  const {values,positionals}=parseArgs({allowPositionals:true,options:{'data-dir':{type:'string'},'admin-port':{type:'string'},'gateway-port':{type:'string'},'require-token':{type:'boolean'},'trust-local':{type:'boolean'},version:{type:'boolean'},help:{type:'boolean'}}});
  if(values.help){console.log(help);return;}if(values.version){console.log(VERSION);return;}
  if(!['win32','darwin'].includes(process.platform))throw new Error('LineBridge supports Windows and macOS only.');
  if(Number(process.versions.node.split('.')[0])<24)throw new Error('LineBridge requires Node.js 24 or newer.');
  const command=positionals[0]??'serve';if(positionals.length>1||!['serve','tray','status','stop'].includes(command))throw new Error('Use linebridge serve, tray, status or stop. See --help.');
  if(command==='tray'){
    if(values['trust-local'])throw new Error('The tray starts services with authentication required.');
    if(!['win32','darwin'].includes(process.platform))throw new Error('The tray is available in Windows/macOS portable bundles. Linux is unsupported.');
    const bundle=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
    const binary=join(bundle,process.platform==='win32'?'LineBridge.exe':'LineBridge.app/Contents/MacOS/LineBridge');
    try{await access(binary);}catch{throw new Error('Tray launcher not found. Use a complete Windows/macOS portable bundle.');}
    const args=['data-dir','admin-port','gateway-port'].flatMap(key=>values[key]?['--'+key,key==='data-dir'?resolve(values[key]):values[key]]:[]);
    const child=spawn(binary,args,{detached:true,stdio:'ignore',windowsHide:true});
    await new Promise((ok,fail)=>{child.once('spawn',ok);child.once('error',fail);});child.unref();
    console.log('Tray launched. It will verify or start the service and open your default browser.');return;
  }
  const {startService,defaultDataDirectory,metadata,validPort}=await import('../server/main.mjs');
  const dataDir=values['data-dir']?resolve(values['data-dir']):defaultDataDirectory();
  if(command==='serve'){
    if(values['trust-local']&&values['require-token'])throw new Error('Use either --trust-local or --require-token.');
    const requireToken=values['require-token']===true||process.env.LINE_BRIDGE_REQUIRE_TOKEN==='1'||!(values['trust-local']===true||process.env.LINE_BRIDGE_TRUST_LOCAL==='1');
    const service=await startService({dataDir,requireToken,...(values['admin-port']?{adminPort:Number(values['admin-port'])}:{}),...(values['gateway-port']?{gatewayPort:Number(values['gateway-port'])}:{})});
    const local=!requireToken&&service.tunnels.config().provider==='local';
    console.log(`LineBridge ${VERSION}\nDashboard: http://127.0.0.1:${service.adminPort}\nMCP: http://127.0.0.1:${service.gatewayPort}/mcp\nHTTP API: http://127.0.0.1:${service.gatewayPort}/api/v1\nAI access: ${local?'explicit local trust; no token required':'scoped Bearer token required'}\nSetup: bind your LINE account in the dashboard. Configure chats and API keys in their own pages; cloud connections are optional.\nData: ${service.dataDir}`);return;
  }
  const m=await metadata(dataDir);
  if(!m||m.runtime!=='node'||!validPort(m.adminPort)||typeof m.instance!=='string'||m.dataDir!==dataDir){console.log(JSON.stringify({status:'stopped',dataDir}));return;}
  const base=`http://127.0.0.1:${m.adminPort}`;
  const request=(path,options={})=>fetch(`${base}${path}`,{...options,headers:{Connection:'close',...options.headers},redirect:'error',signal:AbortSignal.timeout(7000)});
  let cookie,state;
  try{
    const index=await request('/');cookie=index.headers.getSetCookie()[0]?.split(';')[0];if(!index.ok||!cookie)throw new Error('No dashboard session.');
    const response=await request('/admin/state',{headers:{Cookie:cookie}});if(!response.ok)throw new Error('No service state.');state=await response.json();
  }catch{console.log(JSON.stringify({status:'unavailable',dataDir,pid:m.pid}));process.exitCode=1;return;}
  if(state.instance!==m.instance)throw new Error('The service instance has changed. Refusing to stop an unrelated process.');
  if(command==='status'){console.log(JSON.stringify({status:'running',version:state.version,backend:state.backend,pid:m.pid,adminPort:m.adminPort,gatewayPort:m.gatewayPort,dataDir,authentication:state.gateway.authentication,mcpUrl:`http://127.0.0.1:${m.gatewayPort}/mcp`,apiUrl:`http://127.0.0.1:${m.gatewayPort}/api/v1`,dashboardUrl:base,accounts:state.accounts.length}));return;}
  const response=await request('/admin/shutdown',{method:'POST',headers:{Cookie:cookie,Origin:base,'X-Line-Bridge':'dashboard','Content-Type':'application/json'},body:JSON.stringify({instance:m.instance})});
  if(!response.ok)throw new Error('The service could not be stopped.');
  console.log(JSON.stringify({status:'stopping',dataDir}));
}
if(!['win32','darwin'].includes(process.platform)) {
  console.error('LineBridge supports Windows and macOS only.');process.exitCode=1;
} else if(['discover','version','accounts','chats','read','refresh','search','events','send','auth'].includes(process.argv[2])) {
  const {runCli}=await import('../client/cli.mjs');process.exitCode=await runCli(process.argv.slice(2));
} else {
  try{await main();}catch(error){console.error(error?.code==='EADDRINUSE'?`Port ${error.port??'requested'} is already in use. Check linebridge status. Choose free --admin-port and --gateway-port values; also leave gateway + 1 free for connector health. No ports were changed automatically.`:error?.status?`${error.code}: ${error.message}`:error.message??'LineBridge could not complete the command.');process.exitCode=1;}
}
