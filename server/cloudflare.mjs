import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {fail,HubError,publicError} from './errors.mjs';
import {validHostname} from './tunnels.mjs';

export const CALLBACK='/oauth/cloudflare/callback';
export const SCOPES='account-settings.read teams-connectors.write access-app.write access-policy.write access-org.read access-service-token.write zone.read dns.write';
const endpoints={auth:'https://dash.cloudflare.com/oauth2/auth',token:'https://dash.cloudflare.com/oauth2/token',revoke:'https://dash.cloudflare.com/oauth2/revoke',api:'https://api.cloudflare.com/client/v4'};
const id=z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const upstream=()=>new HubError(502,'cloudflare_unavailable','Cloudflare could not complete the request.');
const login=()=>new HubError(409,'cloudflare_login_required','Connect your Cloudflare account first.');
export const pkce=value=>createHash('sha256').update(value).digest('base64url');
export class Cloudflare {
  constructor(store,vault,port,transport=fetch){Object.assign(this,{store,vault,port,transport});this.busy=false;this.pending=null;this.lastError=null;}
  callback(){return `http://127.0.0.1:${this.port}${CALLBACK}`;}
  available(){if(this.busy)fail(409,'cloudflare_busy','A Cloudflare operation is already in progress.');}
  async operation(job){this.available();this.busy=true;try{return await job();}finally{this.busy=false;}}
  saved(){const cipher=this.store.setting('cloudflareOAuthToken',null);return cipher?this.vault.unseal(cipher,'cloudflare.oauth'):{};}
  status(){const t=this.saved();return {clientId:this.store.setting('cloudflareOAuthClient',''),callback:this.callback(),connected:!!t.accessToken&&t.expiresAt>Date.now()/1000+30,expiresAt:t.expiresAt?new Date(t.expiresAt*1000).toISOString():null,pending:!!this.pending&&Date.now()-this.pending.at<600000,lastError:this.lastError,setup:this.store.setting('cloudflareSetup',{})};}
  configure(input){this.available();const {clientId}=z.object({clientId:id}).strict().parse(input);if(this.store.setting('cloudflareOAuthClient',null)!==clientId){this.store.setSetting('cloudflareOAuthToken',null);this.pending=null;}this.store.setSetting('cloudflareOAuthClient',clientId);return this.status();}
  begin(){
    this.available();const client=this.store.setting('cloudflareOAuthClient','');if(!client)fail(409,'cloudflare_client_required','Register a PKCE OAuth client first.');
    const state=randomBytes(32).toString('base64url'),verifier=randomBytes(32).toString('base64url'),url=new URL(endpoints.auth);
    url.search=new URLSearchParams({client_id:client,response_type:'code',redirect_uri:this.callback(),state,code_challenge:pkce(verifier),code_challenge_method:'S256',scope:SCOPES});
    this.pending={state,verifier,client,at:Date.now()};this.lastError=null;return {authUrl:url.href,expiresIn:600};
  }
  consume(state){const p=this.pending;const a=Buffer.from(typeof state==='string'?state:''),b=Buffer.from(p?.state??'');if(!p||Date.now()-p.at>=600000||a.length!==b.length||!timingSafeEqual(a,b))fail(400,'oauth_state_invalid','The sign-in request is invalid or expired.');this.pending=null;return p;}
  async request(url,options={},json=true){
    try{
      const response=await this.transport(url,{...options,redirect:'error',signal:AbortSignal.timeout(20000)});
      if(response.status===401&&url.startsWith(endpoints.api))throw login();
      if(!response.ok||Number(response.headers.get('content-length'))>1024*1024)throw upstream();
      if(!json){await response.body?.cancel();return null;}
      const chunks=[];let size=0;
      for await(const chunk of response.body){size+=chunk.length;if(size>1024*1024)throw upstream();chunks.push(chunk);}
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }catch(e){if(e instanceof HubError)throw e;throw upstream();}
  }
  async finish(params){return this.operation(async()=>{
    const p=this.consume(params.state);
    try{
      if(params.error)fail(400,'oauth_declined','Cloudflare authorization was declined.');
      if(typeof params.code!=='string'||!params.code||params.code.length>4096)fail(400,'oauth_code_invalid','Missing OAuth code.');
      if(this.store.setting('cloudflareOAuthClient',null)!==p.client)throw login();
      const token=await this.request(endpoints.token,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:p.client,code:params.code,redirect_uri:this.callback(),code_verifier:p.verifier})});
      if(typeof token.access_token!=='string'||!token.access_token||token.access_token.length>16000||String(token.token_type).toLowerCase()!=='bearer'||!Number.isInteger(token.expires_in)||token.expires_in<=0||token.expires_in>31536000)throw upstream();
      this.store.setSetting('cloudflareOAuthToken',this.vault.seal({accessToken:token.access_token,expiresAt:Math.floor(Date.now()/1000)+token.expires_in},'cloudflare.oauth'));this.lastError=null;
    }catch(e){this.lastError=publicError(e).code;throw e;}
  });}
  async disconnect(){return this.operation(async()=>{
    this.pending=null;const t=this.saved();if(t.accessToken)await this.request(endpoints.revoke,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:this.store.setting('cloudflareOAuthClient',''),token:t.accessToken,token_type_hint:'access_token'})},false);
    this.store.setSetting('cloudflareOAuthToken',null);return this.status();
  });}
  async api(method,path,body){
    const t=this.saved();if(!t.accessToken||t.expiresAt<=Date.now()/1000+30)throw login();
    const v=await this.request(`${endpoints.api}${path}`,{method,headers:{Authorization:`Bearer ${t.accessToken}`,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    if(v.success!==true)throw upstream();return v.result;
  }
  async resources(account){
    const accounts=await this.api('GET','/accounts?per_page=50');if(!Array.isArray(accounts))throw upstream();
    if(!account)return {accounts};id.parse(account);if(!accounts.some(a=>a.id===account))fail(403,'cloudflare_account_denied','Select an authorized account.');
    const zones=await this.api('GET',`/zones?account.id=${account}&per_page=50`);if(!Array.isArray(zones))throw upstream();return {accounts,zones};
  }
  async provision(tunnels,port,input){return this.operation(async()=>{
    const {accountId:account,zoneId:zone,hostname}=z.object({accountId:id,zoneId:id,hostname:z.string().trim().max(253)}).strict().parse(input);tunnels.available();tunnels.idle();
    const host=hostname.toLowerCase(),resources=await this.resources(account),zoneInfo=resources.zones.find(v=>v.id===zone);
    if(!zoneInfo)fail(403,'cloudflare_zone_denied','Select a zone belonging to this account.');
    if(!validHostname(host)||!host.endsWith(`.${zoneInfo.name}`))fail(400,'invalid_hostname','Choose a new subdomain within the selected zone.');
    if(this.store.setting('cloudflareSetup',{}).phase)fail(409,'cloudflare_setup_exists','A setup already exists. Review its resources in Cloudflare before creating another.');
    const records=await this.api('GET',`/zones/${zone}/dns_records?name=${host}`);if(!Array.isArray(records)||records.length)fail(409,'cloudflare_dns_conflict','This hostname already has DNS records.');
    let org;try{org=await this.api('GET',`/accounts/${account}/access/organizations`);}catch{fail(409,'cloudflare_zero_trust_required','Finish Cloudflare Zero Trust organization setup first.');}
    const team=org.auth_domain;if(!/^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(team))throw upstream();
    const apps=await this.api('GET',`/accounts/${account}/access/apps?per_page=100`);if(!Array.isArray(apps)||apps.some(a=>a.domain===host))fail(409,'cloudflare_access_conflict','This hostname already has an Access application.');
    const setup={accountId:account,zoneId:zone,hostname:host,teamDomain:team,phase:'creating_access'},save=(phase,values={})=>{Object.assign(setup,values,{phase});this.store.setSetting('cloudflareSetup',setup);};save('creating_access');
    try{
      const app=await this.api('POST',`/accounts/${account}/access/apps`,{name:`LineBridge · ${host}`,type:'self_hosted',domain:host,session_duration:'24h',app_launcher_visible:false});
      const appId=id.parse(app.id);if(typeof app.aud!=='string'||!app.aud||app.aud.length>512)throw upstream();save('creating_service_token',{applicationId:appId,audience:app.aud});
      const service=await this.api('POST',`/accounts/${account}/access/service_tokens`,{name:`LineBridge · ${host}`,duration:'720h'}),serviceId=id.parse(service.id);
      if(!service.client_id||!service.client_secret)throw upstream();this.store.setSetting('cloudflareServiceToken',this.vault.seal({clientId:service.client_id,clientSecret:service.client_secret,expiresAt:service.expires_at},'cloudflare.service'));save('creating_policy',{serviceTokenId:serviceId});
      const policy=await this.api('POST',`/accounts/${account}/access/apps/${appId}/policies`,{name:'LineBridge AI service',decision:'non_identity',include:[{service_token:{token_id:serviceId}}],precedence:1});save('creating_tunnel',{policyId:id.parse(policy.id)});
      const tunnel=await this.api('POST',`/accounts/${account}/cfd_tunnel`,{name:`LineBridge-${host}`,config_src:'cloudflare'}),tunnelId=id.parse(tunnel.id);save('configuring_tunnel',{tunnelId});
      await this.api('PUT',`/accounts/${account}/cfd_tunnel/${tunnelId}/configurations`,{config:{ingress:[{hostname:host,service:`http://127.0.0.1:${port}`},{service:'http_status:404'}]}});
      const connector=await this.api('GET',`/accounts/${account}/cfd_tunnel/${tunnelId}/token`);tunnels.available();tunnels.idle();tunnels.setConnectorToken(connector);tunnels.configure({provider:'cloudflare',hostname:host,teamDomain:team,audience:app.aud});save('creating_dns');
      const record=await this.api('POST',`/zones/${zone}/dns_records`,{type:'CNAME',name:host,content:`${tunnelId}.cfargotunnel.com`,proxied:true,ttl:1});save('complete',{dnsRecordId:id.parse(record.id)});
      return {configured:true,hostname:host,setup};
    }catch(e){setup.error=publicError(e).code;this.store.setSetting('cloudflareSetup',setup);throw e;}
  });}
  serviceToken(){const cipher=this.store.setting('cloudflareServiceToken',null);if(!cipher)fail(404,'cloudflare_service_token_missing','No saved service token.');return this.vault.unseal(cipher,'cloudflare.service');}
}
