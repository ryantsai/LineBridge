import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { fail } from './errors.mjs';

const exec=promisify(execFile);
const configSchema=z.object({provider:z.enum(['cloudflare','tailscale']),hostname:z.string().trim().max(253).default(''),teamDomain:z.string().trim().max(253).default(''),audience:z.string().trim().max(512).default('')}).strict();
const dns=/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i;
export class Tunnels {
  constructor(store,vault,root,gatewayPort,metricsPort=3212) {
    Object.assign(this,{store,vault,root,gatewayPort,metricsPort});
    this.cloudflare=join(root,'tools','cloudflared.exe');
    this.tailscale=process.platform==='win32' ? 'C:\\Program Files\\Tailscale\\tailscale.exe' : 'tailscale';
    this.state={status:'not_started',connected:false};
  }
  config() {return this.store.setting('tunnel',{provider:'cloudflare',hostname:'',teamDomain:'',audience:''});}
  configure(input) {
    const c=configSchema.parse(input);
    if(this.child || (this.config().provider==='tailscale' && this.state.status==='running'))fail(409,'tunnel_running','Stop the tunnel before changing its configuration.');
    for(const host of [c.hostname,c.teamDomain])if(host && (!dns.test(host)||host.includes('..')||host.includes('://')))fail(400,'invalid_hostname','Enter a DNS hostname without a URL scheme, path or spaces.');
    if(c.teamDomain && !/^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(c.teamDomain))fail(400,'invalid_team_domain','Use your-team.cloudflareaccess.com as the Access team domain.');
    c.hostname=c.hostname.toLowerCase();c.teamDomain=c.teamDomain.toLowerCase();
    this.store.setSetting('tunnel',c);this.state={status:'configured',connected:false};return c;
  }
  async status() {
    const c=this.config();let ready=false;
    if(this.child && this.state.status==='running') {try{ready=(await fetch(`http://127.0.0.1:${this.metricsPort}/ready`,{signal:AbortSignal.timeout(1200)})).ok;}catch{}}
    let tailscale={installed:existsSync(this.tailscale),state:'unknown'};
    if(c.provider==='tailscale' && tailscale.installed) {
      try {
        const {stdout}=await exec(this.tailscale,['status','--json'],{windowsHide:true,timeout:2500});
        const s=JSON.parse(stdout);tailscale.state=s.BackendState;
        const {stdout:serve}=await exec(this.tailscale,['serve','status','--json'],{windowsHide:true,timeout:2500});
        const config=JSON.parse(serve),handlers=Object.values(config.Web ?? {}).flatMap(v=>Object.values(v.Handlers ?? {}));
        const host=s.Self?.DNSName?.replace(/\.$/,'');
        ready=s.BackendState==='Running' && !config.AllowFunnel?.[`${host}:8443`] && handlers.some(h=>h.Proxy===`http://127.0.0.1:${this.gatewayPort}`);
      }catch{tailscale.state='unavailable';}
    }
    return {...c,...this.state,connected:ready,cloudflaredInstalled:existsSync(this.cloudflare),hasConnectorToken:!!this.store.setting('cloudflareConnector',null),tailscale,
      url:c.hostname?`https://${c.hostname}`:null,accessConfigured:c.provider==='cloudflare' && !!c.hostname && !!c.teamDomain && !!c.audience,
      accessLastValidated:this.accessLastValidated ?? null,scope:c.provider==='cloudflare'?'Access-protected HTTPS':'private tailnet'};
  }
  setConnectorToken(token) {
    if(typeof token!=='string'||token.length<30||token.length>16000||/\s/.test(token))fail(400,'invalid_connector_token','Paste the connector token from the Cloudflare tunnel installation command.');
    this.store.setSetting('cloudflareConnector',this.vault.seal(token,'cloudflare.connector'));
  }
  async start(token) {
    const c=this.config();
    if(c.provider==='tailscale')return this.startTailscale();
    if(!existsSync(this.cloudflare))fail(409,'cloudflared_missing','Install cloudflared in tools/cloudflared.exe first.');
    if(!c.hostname||!c.teamDomain||!c.audience)fail(409,'access_setup_required','Configure the hostname, Access team domain and application AUD before starting the tunnel.');
    if(this.child)fail(409,'tunnel_running','The connector is already running.');
    if(token)this.setConnectorToken(token);
    const cipher=this.store.setting('cloudflareConnector',null);
    if(!cipher)fail(409,'connector_token_required','A Cloudflare tunnel connector token is required.');
    const credential=this.vault.unseal(cipher,'cloudflare.connector');
    const child=spawn(this.cloudflare,['tunnel','--no-autoupdate','--metrics',`127.0.0.1:${this.metricsPort}`,'run'],{
      windowsHide:true,env:{...process.env,TUNNEL_TOKEN:credential},stdio:['ignore','ignore','pipe']});
    this.child=child;this.state={status:'starting',connected:false};
    // Raw cloudflared logs can contain setup details. Expose only fixed status labels.
    child.stderr.on('data',data=>{if(data.toString().includes('Registered tunnel connection'))this.state.status='running';});
    child.on('error',()=>{this.state={status:'connector_failed',connected:false};if(this.child===child)this.child=null;});
    child.on('exit',()=>{if(this.child===child){this.child=null;this.state={status:'stopped',connected:false};}});
    return {status:'starting'};
  }
  async startTailscale() {
    if(!existsSync(this.tailscale))fail(409,'tailscale_missing','Install Tailscale first.');
    const {stdout}=await exec(this.tailscale,['status','--json'],{windowsHide:true,timeout:5000});
    const s=JSON.parse(stdout);
    if(s.BackendState!=='Running')fail(409,'tailscale_stopped','Connect Tailscale on this PC, then start private sharing here.');
    const {stdout:current}=await exec(this.tailscale,['serve','status','--json'],{windowsHide:true,timeout:5000});
    const existing=JSON.parse(current);
    // Use a dedicated port so another Serve application is not overwritten.
    const host=s.Self?.DNSName?.replace(/\.$/,'');
    const web=existing.Web?.[`${host}:8443`];
    if(existing.AllowFunnel?.[`${host}:8443`])fail(409,'public_route_exists','Port 8443 has a public Funnel route. Choose a private Serve route before using this provider.');
    if(web?.Handlers?.['/'] && web.Handlers['/'].Proxy!==`http://127.0.0.1:${this.gatewayPort}`)fail(409,'serve_conflict','Tailscale port 8443 already serves another application.');
    await exec(this.tailscale,['serve','--bg','--https=8443',`http://127.0.0.1:${this.gatewayPort}`],{windowsHide:true,timeout:15000});
    this.store.setSetting('tunnel',{provider:'tailscale',hostname:`${host}:8443`,teamDomain:'',audience:''});
    this.state={status:'running',connected:true};return {status:'running',url:`https://${host}:8443`};
  }
  async stop() {
    if(this.child){const c=this.child;this.child=null;c.kill();}
    if(this.config().provider==='tailscale') {
      const {stdout}=await exec(this.tailscale,['serve','status','--json'],{windowsHide:true,timeout:5000});
      const current=JSON.parse(stdout),host=this.config().hostname;
      if(current.Web?.[host]?.Handlers?.['/']?.Proxy===`http://127.0.0.1:${this.gatewayPort}`)await exec(this.tailscale,['serve','--https=8443','off'],{windowsHide:true,timeout:5000});
    }
    this.state={status:'stopped',connected:false};return this.state;
  }
  close() {this.child?.kill();this.child=null;}
}
