#!/usr/bin/env node
import {parseArgs} from 'node:util';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {access,realpath} from 'node:fs/promises';
import {VERSION} from '../server/version.mjs';

const help=`LineBridge ${VERSION} — local LINE MCP / HTTP gateway

Usage: linebridge [serve|tray|status|stop|shutdown] [options]
       linebridge discover|version|accounts|chats|read|refresh|search|events|send|send-flex|media|auth [options]
       linebridge codex preview|install|uninstall|verify [options]
       linebridge mcp --profile NAME --url GATEWAY [--tools read|read-send]

  serve                    Run in the foreground without a tray icon (default)
  tray                     Open the portable Windows/macOS tray launcher
  status                   Inspect the service for this data directory
  stop                     Gracefully stop that service
  shutdown                 維護關閉：退出桌面／系統匣及此資料目錄的服務，等待釋放
  --instance ID            shutdown: require the service instance shown by status
  --timeout-ms MS          shutdown: total wait budget, 1000–120000 (default 30000)
  --resume                 serve: 更新後明確解除維護並啟動；保留原資料目錄及連接埠
  --data-dir DIR           Persistent SQLite and encrypted vault directory
  --admin-port PORT        Local dashboard (default 3210)
  --gateway-port PORT      Local AI gateway (default 3211)
  --require-token          Require a Bearer token even for direct localhost
  --trust-local            Opt in to token-free direct loopback development
  --version                Print the installed CLI version
  --help                   Print this help

Data client: linebridge accounts --help (JSON stdout, diagnostics on stderr).
Local AI setup: linebridge discover [--data-dir DIR] (no profile required).
Codex MCP setup: linebridge codex --help (explicit preview and consent).
Gateway app version: linebridge version [--profile NAME].
See CLI.md for scoped credentials, pagination and explicit sends.

Portable archives bundle Node. npm/source installs need Node.js 24+.
Environment: LINE_BRIDGE_DATA, LINE_BRIDGE_ADMIN_PORT, LINE_BRIDGE_GATEWAY_PORT,
             LINE_BRIDGE_TRUST_LOCAL=1 (development only).
Both listeners bind to 127.0.0.1. Scoped Bearer tokens are required by default.
Run on your PC and expose only the AI gateway through a tunnel.
`;
async function main(){
  const {values,positionals}=parseArgs({allowPositionals:true,options:{'data-dir':{type:'string'},'admin-port':{type:'string'},'gateway-port':{type:'string'},'require-token':{type:'boolean'},'trust-local':{type:'boolean'},instance:{type:'string'},'timeout-ms':{type:'string'},resume:{type:'boolean'},version:{type:'boolean'},help:{type:'boolean'}}});
  if(values.help){console.log(help);return;}if(values.version){console.log(VERSION);return;}
  if(!['win32','darwin'].includes(process.platform))throw new Error('LineBridge supports Windows and macOS only.');
  if(Number(process.versions.node.split('.')[0])<24)throw new Error('LineBridge requires Node.js 24 or newer.');
  const command=positionals[0]??'serve';if(positionals.length>1||!['serve','tray','status','stop','shutdown'].includes(command))throw new Error('Use linebridge serve, tray, status, stop or shutdown. See --help.');
  if(values.resume&&command!=='serve'||command!=='shutdown'&&(values.instance!==undefined||values['timeout-ms']!==undefined))throw new Error('--resume is for serve; --instance and --timeout-ms are for shutdown.');
  if(command==='shutdown'&&['admin-port','gateway-port','require-token','trust-local'].some(key=>values[key]!==undefined))throw new Error('shutdown uses verified instance metadata. Use --data-dir, --instance and --timeout-ms only.');
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
  let dataDir=values['data-dir']?resolve(values['data-dir']):defaultDataDirectory();
  try{dataDir=await realpath(dataDir);}catch(error){if(error.code!=='ENOENT')throw error;}
  if(command==='shutdown'){
    const {shutdownDesktop}=await import('../server/maintenance.mjs');
    console.log(JSON.stringify(await shutdownDesktop({dataDir,instance:values.instance,timeoutMs:values['timeout-ms']===undefined?30000:Number(values['timeout-ms'])})));return;
  }
  if(command==='serve'){
    if(values['trust-local']&&values['require-token'])throw new Error('Use either --trust-local or --require-token.');
    const requireToken=values['require-token']===true||process.env.LINE_BRIDGE_REQUIRE_TOKEN==='1'||!(values['trust-local']===true||process.env.LINE_BRIDGE_TRUST_LOCAL==='1');
    const service=await startService({dataDir,requireToken,resume:values.resume===true,...(values['admin-port']?{adminPort:Number(values['admin-port'])}:{}),...(values['gateway-port']?{gatewayPort:Number(values['gateway-port'])}:{})});
    const local=!requireToken&&service.tunnels.config().provider==='local';
    console.log(`LineBridge ${VERSION}\nDashboard: http://127.0.0.1:${service.adminPort}\nMCP: http://127.0.0.1:${service.gatewayPort}/mcp\nHTTP API: http://127.0.0.1:${service.gatewayPort}/api/v1\nAI access: ${local?'explicit local trust; no token required':'scoped Bearer token required'}\nSetup: bind your LINE account in the dashboard. Configure chats and API keys in their own pages; cloud connections are optional.\nData: ${service.dataDir}`);return;
  }
  const {maintenance}=await import('../server/maintenance.mjs'),marker=await maintenance(dataDir),maintenanceState=marker?{maintenance:true,instance:marker.service?.instance??null}:{};
  const m=await metadata(dataDir);
  if(!m||m.runtime!=='node'||!validPort(m.adminPort)||typeof m.instance!=='string'||m.dataDir!==dataDir){console.log(JSON.stringify({status:'stopped',dataDir,...maintenanceState}));return;}
  const base=`http://127.0.0.1:${m.adminPort}`;
  const request=(path,options={})=>fetch(`${base}${path}`,{...options,headers:{Connection:'close',...options.headers},redirect:'error',signal:AbortSignal.timeout(7000)});
  let cookie,state;
  try{
    const index=await request('/');cookie=index.headers.getSetCookie()[0]?.split(';')[0];await index.body?.cancel();if(!index.ok||!cookie)throw new Error('No dashboard session.');
    let response=await request('/admin/status',{headers:{Cookie:cookie}});
    if(response.status===404){
      // Older services expose only the full dashboard state.
      await response.body?.cancel();response=await request('/admin/state',{headers:{Cookie:cookie}});if(!response.ok)throw new Error('No service state.');
      const full=await response.json();state={version:full.version,backend:full.backend,instance:full.instance,authentication:full.gateway?.authentication,accounts:full.accounts?.length};
    }else{if(!response.ok)throw new Error('No service state.');state=await response.json();}
  }catch{console.log(JSON.stringify({status:'unavailable',dataDir,pid:m.pid,...maintenanceState}));process.exitCode=1;return;}
  if(state.instance!==m.instance)throw new Error('The service instance has changed. Refusing to stop an unrelated process.');
  if(command==='status'){console.log(JSON.stringify({status:'running',version:state.version,backend:state.backend,instance:state.instance,pid:m.pid,adminPort:m.adminPort,gatewayPort:m.gatewayPort,dataDir,authentication:state.authentication,mcpUrl:`http://127.0.0.1:${m.gatewayPort}/mcp`,apiUrl:`http://127.0.0.1:${m.gatewayPort}/api/v1`,dashboardUrl:base,accounts:state.accounts,...maintenanceState}));return;}
  const response=await request('/admin/shutdown',{method:'POST',headers:{Cookie:cookie,Origin:base,'X-Line-Bridge':'dashboard','Content-Type':'application/json'},body:JSON.stringify({instance:m.instance})});
  if(!response.ok)throw new Error('The service could not be stopped.');
  console.log(JSON.stringify({status:'stopping',dataDir}));
}
if(!['win32','darwin'].includes(process.platform)) {
  console.error('LineBridge supports Windows and macOS only.');process.exitCode=1;
} else if(process.argv[2]==='codex') {
  const {runCodex}=await import('../client/codex.mjs');process.exitCode=await runCodex(process.argv.slice(3));
} else if(process.argv[2]==='mcp') {
  const {runMcp}=await import('../client/mcp.mjs');process.exitCode=await runMcp(process.argv.slice(3));
} else if(['discover','version','accounts','chats','read','refresh','search','events','send','send-flex','media','auth'].includes(process.argv[2])) {
  const {runCli}=await import('../client/cli.mjs');process.exitCode=await runCli(process.argv.slice(2));
} else {
  try{await main();}catch(error){console.error(error?.code==='EADDRINUSE'?`Port ${error.port??'requested'} is already in use. Check linebridge status. Choose free --admin-port and --gateway-port values; also leave gateway + 1 free for connector health. No ports were changed automatically.`:error?.status?`${error.code}: ${error.message}`:error.message??'LineBridge could not complete the command.');process.exitCode=1;}
}
