import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {Store} from '../server/store.mjs';
import {Vault} from '../server/vault.mjs';
import {Cloudflare,pkce,SCOPES} from '../server/cloudflare.mjs';
import {Tunnels,quickHostname,tailscaleAuth,validHostname} from '../server/tunnels.mjs';

function fixture(t,failPolicy=false,conflict=false){
  const store=new Store(':memory:'),vault=new Vault(randomBytes(32),'test'),calls=[];t.after(()=>store.close());
  const transport=async(url,options)=>{
    const u=new URL(url),method=options.method??'GET';calls.push({path:u.pathname,method,options});assert.equal(options.redirect,'error');
    if(u.pathname==='/oauth2/token')return Response.json({access_token:'private-oauth-token',expires_in:3600,token_type:'bearer'});
    if(u.pathname==='/oauth2/revoke')return new Response(null,{status:200});
    const path=u.pathname.replace('/client/v4','');let result;
    if(path==='/accounts')result=[{id:'account',name:'Authorized'}];
    else if(path==='/zones')result=[{id:'zone',name:'example.com'}];
    else if(path==='/zones/zone/dns_records'&&method==='GET')result=conflict?[{id:'existing'}]:[];
    else if(path.endsWith('/access/organizations'))result={auth_domain:'test.cloudflareaccess.com'};
    else if(path.endsWith('/access/apps')&&method==='GET')result=[];
    else if(path.endsWith('/access/apps'))result={id:'app',aud:'test-audience'};
    else if(path.endsWith('/access/service_tokens'))result={id:'service',client_id:'service-id',client_secret:'private-service-secret',expires_at:'2026-11-01T00:00:00Z'};
    else if(path.endsWith('/policies')){if(failPolicy)return Response.json({success:false},{status:500});result={id:'policy'};}
    else if(path.endsWith('/cfd_tunnel'))result={id:'tunnel'};
    else if(path.endsWith('/configurations'))result={};
    else if(path.endsWith('/token'))result='connector-secret-abcdefghijklmnopqrstuvwxyz';
    else if(path==='/zones/zone/dns_records'&&method==='POST')result={id:'dns'};
    else throw new Error(`Unexpected fixture path ${path}`);
    return Response.json({success:true,result});
  };
  const cf=new Cloudflare(store,vault,3210,transport),tunnels=new Tunnels(store,vault,process.cwd(),3211);tunnels.tailscale=null;
  cf.configure({clientId:'fixture-client'});return {store,vault,cf,tunnels,calls};
}
async function signIn(cf){const url=new URL(cf.begin().authUrl);await cf.finish({state:url.searchParams.get('state'),code:'private-code'});return url;}
test('PKCE login consumes one-use state; tokens are encrypted and never returned in status',async t=>{
  assert.equal(pkce('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  const {cf,store,calls}=fixture(t),url=await signIn(cf);assert.equal(url.searchParams.get('scope'),SCOPES);assert.equal(cf.status().connected,true);assert.ok(!JSON.stringify(cf.status()).includes('private-oauth-token'));assert.ok(!store.setting('cloudflareOAuthToken').includes('private-oauth-token'));
  assert.equal(new URLSearchParams(calls[0].options.body).get('redirect_uri'),cf.callback());
  await assert.rejects(cf.finish({state:url.searchParams.get('state'),code:'replay'}),{code:'oauth_state_invalid'});await cf.disconnect();assert.equal(cf.status().connected,false);
});
test('Cloudflare setup protects Access before publishing DNS and encrypts connector/service credentials',async t=>{
  const {cf,store,tunnels,calls}=fixture(t);await signIn(cf);await cf.provision(tunnels,3211,{accountId:'account',zoneId:'zone',hostname:'line.example.com'});
  const writes=calls.filter(c=>['POST','PUT'].includes(c.method)&&c.path.startsWith('/client/v4')).map(c=>c.path);assert.ok(writes[0].endsWith('/access/apps'));assert.ok(writes.at(-1).endsWith('/dns_records'));assert.ok(writes.indexOf('/client/v4/accounts/account/access/apps/app/policies')<writes.indexOf('/client/v4/zones/zone/dns_records'));
  assert.equal(cf.status().setup.phase,'complete');assert.equal(tunnels.config().audience,'test-audience');assert.equal(cf.serviceToken().clientSecret,'private-service-secret');
  assert.ok(!JSON.stringify(store.setting('cloudflareSetup')).includes('private'));assert.ok(!store.setting('cloudflareServiceToken').includes('private-service-secret'));
  await assert.rejects(cf.provision(tunnels,3211,{accountId:'account',zoneId:'zone',hostname:'line.example.com'}),{code:'cloudflare_setup_exists'});
});
test('conflicts and partial Cloudflare failures retain progress and cannot blindly retry',async t=>{
  const {cf,store,tunnels,calls}=fixture(t,true);await signIn(cf);
  await assert.rejects(cf.provision(tunnels,3211,{accountId:'account',zoneId:'zone',hostname:'line.example.com'}),{code:'cloudflare_unavailable'});assert.equal(store.setting('cloudflareSetup').phase,'creating_policy');assert.ok(!calls.some(c=>c.method==='POST'&&c.path.endsWith('/dns_records')));
  await assert.rejects(cf.provision(tunnels,3211,{accountId:'account',zoneId:'zone',hostname:'line.example.com'}),{code:'cloudflare_setup_exists'});
  const other=fixture(t,false,true);await signIn(other.cf);await assert.rejects(other.cf.provision(other.tunnels,3211,{accountId:'account',zoneId:'zone',hostname:'line.example.com'}),{code:'cloudflare_dns_conflict'});assert.ok(!other.store.setting('cloudflareSetup',{}).phase);
});
test('direct localhost is the default; named Access settings survive selecting an optional provider',t=>{
  const {tunnels,store}=fixture(t);assert.equal(tunnels.config().provider,'local');tunnels.configure({provider:'cloudflare',hostname:'line.example.com',teamDomain:'test.cloudflareaccess.com',audience:'aud'});tunnels.configure({provider:'local'});assert.equal(store.setting('cloudflareNamed').hostname,'line.example.com');assert.equal(tunnels.gatewayHostname(),'');
  assert.equal(quickHostname('INF | https://bright-blue-tree.trycloudflare.com |'),'bright-blue-tree.trycloudflare.com');
  for(const line of ['https://foo.trycloudflare.com.evil.test','https://user@foo.trycloudflare.com','https://foo.trycloudflare.com/path'])assert.equal(quickHostname(line),null);
  assert.ok(tailscaleAuth('https://login.tailscale.com/a/token'));assert.equal(tailscaleAuth('https://login.tailscale.com.evil.test/a/token'),null);assert.equal(validHostname('-bad.example'),false);
});
