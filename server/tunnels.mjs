import {spawn,execFile} from 'node:child_process';
import {accessSync,constants,writeFileSync} from 'node:fs';
import {join,delimiter,isAbsolute} from 'node:path';
import {promisify} from 'node:util';
import {createInterface} from 'node:readline';
import {z} from 'zod';
import {fail} from './errors.mjs';

const exec=promisify(execFile);
const configSchema=z.object({provider:z.enum(['local','cloudflare','cloudflare_quick','tailscale']),hostname:z.string().trim().max(253).default(''),teamDomain:z.string().trim().max(253).default(''),audience:z.string().trim().max(512).default('')}).strict();
export const validHostname=host=>typeof host==='string'&&host.length<=253&&host.split('.').every(s=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(s));
export function findExecutable(name,candidates=[]){
  const files=[...candidates,...(process.env.PATH??'').split(delimiter).map(p=>join(p,process.platform==='win32'?`${name}.exe`:name))];
  return files.find(p=>{if(!p||!isAbsolute(p))return false;try{accessSync(p,process.platform==='win32'?constants.F_OK:constants.X_OK);return true;}catch{return false;}})??null;
}
export function quickHostname(line){const url=line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com(?=[\s|]|$)/)?.[0];return url?new URL(url).hostname:null;}
export function tailscaleAuth(value){try{const u=new URL(value);return value.length<=8192&&u.protocol==='https:'&&u.hostname==='login.tailscale.com'&&!u.port&&!u.username&&!u.password&&u.pathname.startsWith('/a/')?u.href:null;}catch{return null;}}
export class Tunnels {
  constructor(store,vault,root,gatewayPort,metricsPort=gatewayPort+1,data=join(root,'data')){
    Object.assign(this,{store,vault,root,gatewayPort,metricsPort,data});this.state={status:'not_started'};this.busy=false;
    this.cloudflare=findExecutable('cloudflared',[process.env.LINE_BRIDGE_CLOUDFLARED,join(root,'tools',process.platform==='win32'?'cloudflared.exe':'cloudflared')]);
    this.tailscale=findExecutable('tailscale',[process.env.LINE_BRIDGE_TAILSCALE,process.platform==='win32'?'C:\\Program Files\\Tailscale\\tailscale.exe':'/Applications/Tailscale.app/Contents/MacOS/Tailscale']);
  }
  config(){return this.store.setting('tunnel',{provider:'local',hostname:'',teamDomain:'',audience:''});}
  idle(){if(this.child||this.config().provider==='tailscale'&&this.state.status==='running')fail(409,'tunnel_running','Stop the tunnel before changing its configuration.');}
  available(){if(this.busy)fail(409,'tunnel_busy','Wait for the current connection operation to finish.');}
  async operation(job){this.available();this.busy=true;try{return await job();}finally{this.busy=false;}}
  configure(input){
    this.available();this.idle();const c=configSchema.parse(input),previous=this.config();
    if(c.provider!=='cloudflare')c.hostname=c.teamDomain=c.audience='';
    for(const host of [c.hostname,c.teamDomain])if(host&&!validHostname(host))fail(400,'invalid_hostname','Enter a DNS hostname without a URL scheme, path or spaces.');
    if(c.teamDomain&&!/^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(c.teamDomain))fail(400,'invalid_team_domain','Use your-team.cloudflareaccess.com as the Access team domain.');
    c.hostname=c.hostname.toLowerCase();c.teamDomain=c.teamDomain.toLowerCase();
    if(previous.provider==='cloudflare')this.store.setSetting('cloudflareNamed',previous);
    this.store.setSetting('tunnel',c);if(c.provider==='cloudflare')this.store.setSetting('cloudflareNamed',c);
    this.quickHost=null;this.state={status:'configured'};return c;
  }
  gatewayHostname(){const c=this.config();return c.provider==='cloudflare_quick'?this.quickHost??'':c.hostname;}
  async ts(args,timeout=5000){
    if(!this.tailscale)fail(409,'tailscale_missing','Install Tailscale first.');
    try{const {stdout}=await exec(this.tailscale,args,{windowsHide:true,timeout,maxBuffer:1024*1024,env:{...process.env,TAILSCALE_BE_CLI:'1'}});return args.includes('--json')&&stdout.trim()?JSON.parse(stdout):{};}
    catch{fail(502,'tailscale_unavailable','Tailscale could not complete the operation.');}
  }
  async connectTailscale(){
    if(this.loginBusy)fail(409,'tailscale_busy','Tailscale sign-in is already in progress.');
    this.loginBusy=true;try{
      const before=await this.ts(['status','--json']);if(before.BackendState==='Running')return {connected:true,state:'Running'};
      let stdout='';try{({stdout}=await exec(this.tailscale,['up','--json','--timeout=4s'],{windowsHide:true,timeout:7000,maxBuffer:1024*1024,env:{...process.env,TAILSCALE_BE_CLI:'1'}}));}catch(e){stdout=e.stdout??'';}
      const after=await this.ts(['status','--json']);if(after.BackendState==='Running')return {connected:true,state:'Running'};
      let authUrl=tailscaleAuth(after.AuthURL);
      if(!authUrl){for(const line of stdout.split('\n'))try{authUrl=tailscaleAuth(JSON.parse(line).AuthURL);if(authUrl)break;}catch{}}
      if(authUrl)return {connected:false,state:after.BackendState,authUrl};
      if(after.BackendState==='NeedsMachineAuth')return {connected:false,state:'NeedsMachineAuth'};
      fail(502,'tailscale_unavailable','Open the installed Tailscale client to complete sign-in.');
    }finally{this.loginBusy=false;}
  }
  async status(){
    const c={...this.config()};let connected=c.provider==='local';
    if(c.provider==='cloudflare_quick')c.hostname=this.quickHost??'';
    if(this.child)try{connected=(await fetch(`http://127.0.0.1:${this.metricsPort}/ready`,{signal:AbortSignal.timeout(1200),redirect:'error'})).ok&&(c.provider!=='cloudflare_quick'||!!c.hostname);if(connected)this.state.status='running';}catch{}
    const tailscale={installed:!!this.tailscale,state:'unknown'};
    if(this.tailscale)try{
      const s=await this.ts(['status','--json'],2500);tailscale.state=s.BackendState;
      if(c.provider==='tailscale'){const serve=await this.ts(['serve','status','--json'],2500);connected=s.BackendState==='Running'&&!serve.AllowFunnel?.[c.hostname]&&serve.Web?.[c.hostname]?.Handlers?.['/']?.Proxy===`http://127.0.0.1:${this.gatewayPort}`;}
    }catch{tailscale.state='unavailable';}
    return {...c,...this.state,status:c.provider==='local'?'running':this.state.status,connected,cloudflaredInstalled:!!this.cloudflare,hasConnectorToken:!!this.store.setting('cloudflareConnector',null),tailscale,
      url:c.provider==='local'?`http://127.0.0.1:${this.gatewayPort}`:c.hostname?`https://${c.hostname}`:null,
      accessConfigured:c.provider==='cloudflare'&&!!c.hostname&&!!c.teamDomain&&!!c.audience,accessLastValidated:this.accessLastValidated??null,
      namedConfig:this.store.setting('cloudflareNamed',c.provider==='cloudflare'?c:{}),scope:c.provider==='local'?'same VM':c.provider==='cloudflare_quick'?'temporary HTTPS':c.provider==='cloudflare'?'Access-protected HTTPS':'private tailnet'};
  }
  setConnectorToken(token){
    if(typeof token!=='string'||token.length<30||token.length>16000||/\s/.test(token))fail(400,'invalid_connector_token','Paste a valid Cloudflare connector token.');
    this.store.setSetting('cloudflareConnector',this.vault.seal(token,'cloudflare.connector'));
  }
  async start(token){return this.operation(async()=>{
    const c=this.config();this.idle();
    if(c.provider==='local')return {status:'running',url:`http://127.0.0.1:${this.gatewayPort}`};
    if(c.provider==='tailscale'){
      const login=await this.connectTailscale();if(!login.connected)return login;
      const s=await this.ts(['status','--json']),dns=s.Self?.DNSName?.replace(/\.$/,'');if(!validHostname(dns))fail(502,'tailscale_unavailable','Tailscale did not return a DNS name.');
      const host=`${dns}:8443`,existing=await this.ts(['serve','status','--json']),proxy=`http://127.0.0.1:${this.gatewayPort}`,handler=existing.Web?.[host]?.Handlers?.['/'];
      if(existing.AllowFunnel?.[host])fail(409,'public_route_exists','Port 8443 has a public Funnel route.');
      if(handler&&handler.Proxy!==proxy)fail(409,'serve_conflict','Tailscale port 8443 already serves another application.');
      await this.ts(['serve','--bg','--https=8443',proxy],15000);this.store.setSetting('tunnel',{provider:'tailscale',hostname:host,teamDomain:'',audience:''});this.state={status:'running'};return {status:'running',url:`https://${host}`};
    }
    if(!this.cloudflare)fail(409,'cloudflared_missing','Install cloudflared on this machine first.');
    const env={...process.env};delete env.TUNNEL_TOKEN;delete env.TUNNEL_TOKEN_FILE;
    let args;
    if(c.provider==='cloudflare_quick'){
      const config=join(this.data,'linebridge-quick.yml');writeFileSync(config,'no-autoupdate: true\n',{mode:0o600});
      args=['tunnel','--config',config,'--no-autoupdate','--metrics',`127.0.0.1:${this.metricsPort}`,'--url',`http://127.0.0.1:${this.gatewayPort}`];
    }else{
      if(!c.hostname||!c.teamDomain||!c.audience)fail(409,'access_setup_required','Configure the hostname, Access team domain and application AUD first.');
      if(token)this.setConnectorToken(token);const cipher=this.store.setting('cloudflareConnector',null);if(!cipher)fail(409,'connector_token_required','A Cloudflare connector token is required.');
      env.TUNNEL_TOKEN=this.vault.unseal(cipher,'cloudflare.connector');args=['tunnel','--no-autoupdate','--metrics',`127.0.0.1:${this.metricsPort}`,'run'];
    }
    const child=spawn(this.cloudflare,args,{windowsHide:true,env,stdio:['ignore','ignore','pipe']});this.child=child;this.quickHost=null;this.state={status:'starting'};
    const lines=createInterface({input:child.stderr});lines.on('line',line=>{if(this.child===child&&c.provider==='cloudflare_quick'){const host=quickHostname(line);if(host)this.quickHost=host;}});
    const failed=()=>{if(this.child===child){this.child=null;this.quickHost=null;this.state={status:'connector_failed'};}};child.on('error',failed);child.on('exit',failed);
    return {status:'starting'};
  });}
  async stop(){return this.operation(async()=>{
    await this.close();
    if(this.config().provider==='tailscale'){
      const current=await this.ts(['serve','status','--json']);if(current.Web?.[this.config().hostname]?.Handlers?.['/']?.Proxy===`http://127.0.0.1:${this.gatewayPort}`)await this.ts(['serve','--https=8443','off']);
    }
    this.state={status:'stopped'};return this.state;
  });}
  async close(){const child=this.child;this.child=null;this.quickHost=null;if(child){child.kill();await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>{const timer=setTimeout(r,2000);timer.unref();})]);}}
}
