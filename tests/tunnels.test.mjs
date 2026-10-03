import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {Store} from '../server/store.mjs';
import {Vault} from '../server/vault.mjs';
import {Tunnels,publicHostname,tailcatAddress} from '../server/tunnels.mjs';
import {connectorPlan,verifiedDownload} from '../server/connector-install.mjs';
function fixture(t){const store=new Store(':memory:'),vault=new Vault(randomBytes(32),'test'),tunnels=new Tunnels(store,vault,process.cwd(),3211);t.after(()=>store.close());return {store,vault,tunnels};}
test('ngrok credentials stay encrypted and are never returned in status; discovery URL is strict',async t=>{
  const {store,vault,tunnels}=fixture(t);tunnels.tailscale=null;tunnels.configure({provider:'ngrok',ngrokDomain:'TEST.ngrok.app'});tunnels.setNgrokToken('synthetic-secret-ngrok-123');
  assert.equal(vault.unseal(store.setting('ngrokAuthtoken'),'ngrok.authtoken'),'synthetic-secret-ngrok-123');assert.ok(!store.setting('ngrokAuthtoken').includes('synthetic-secret'));assert.ok(!JSON.stringify(await tunnels.status()).includes('synthetic-secret'));
  assert.equal(publicHostname('https://test.ngrok.app'),'test.ngrok.app');for(const v of ['http://test.ngrok.app','https://user@evil.test','https://test.ngrok.app/a','https://test.ngrok.app?x=1','https://test.ngrok.app:8443'])assert.equal(publicHostname(v),null);
  tunnels.forgetNgrokToken();assert.equal((await tunnels.status()).ngrok.hasAuthtoken,false);assert.throws(()=>tunnels.setNgrokToken('bad secret'),{code:'invalid_ngrok_token'});
  assert.ok(tailcatAddress('tc'+'A'.repeat(80)));assert.equal(tailcatAddress('tc'+'A'.repeat(80)+';whoami'),null);
  assert.throws(()=>tunnels.configure({provider:'ngrok',ngrokDomain:'https://evil.test'}),{code:'invalid_hostname'});
});
test('Funnel owns only newly created routes and does not overwrite or remove other services',async t=>{
  const {tunnels}=fixture(t),calls=[],dns='machine.test.ts.net';let current={Web:{[dns+':8443']:{Handlers:{'/':{Proxy:'http://127.0.0.1:3211'}}}},TCP:{8443:{HTTPS:true}}};
  tunnels.connectTailscale=async()=>({connected:true});tunnels.ts=async args=>{calls.push(args);if(args[0]==='status')return {BackendState:'Running',Self:{DNSName:dns+'.'}};if(args[1]==='status')return structuredClone(current);if(args[0]==='funnel'&&args.includes('--bg')){current.Web[dns+':443']={Handlers:{'/':{Proxy:'http://127.0.0.1:3211'}}};current.AllowFunnel={[dns+':443']:true};}if(args.at(-1)==='off'){delete current.Web[dns+':443'];delete current.AllowFunnel[dns+':443'];}return {};};
  tunnels.configure({provider:'tailscale_funnel'});assert.equal((await tunnels.start()).url,'https://'+dns);assert.equal((await tunnels.status()).connected,true);assert.ok(calls.some(a=>a[0]==='funnel'&&a.includes('--https=443')));await tunnels.stop();assert.ok(current.Web[dns+':8443']);assert.ok(!current.Web[dns+':443']);
  tunnels.configure({provider:'tailscale_funnel',httpsPort:8443});await assert.rejects(tunnels.start(),{code:'serve_conflict'});assert.ok(current.Web[dns+':8443']);
  tunnels.configure({provider:'tailscale'});await tunnels.start();await tunnels.stop();assert.ok(current.Web[dns+':8443'],'Matching external route must not be removed');
});
test('Funnel cleanup refuses a changed route and exposes only a validated consent URL',async t=>{
  const {tunnels}=fixture(t);let current={};tunnels.connectTailscale=async()=>({connected:true});tunnels.ts=async args=>{if(args[0]==='status')return {Self:{DNSName:'machine.test.ts.net'}};if(args[1]==='status')return current;if(args.includes('--bg')){const e=new Error();e.code='funnel_authorization_required';e.authUrl='https://login.tailscale.com/f/funnel?node=test';throw e;}throw Error('Must not delete a changed route');};
  tunnels.configure({provider:'tailscale_funnel'});assert.equal((await tunnels.start()).state,'NeedsFunnelAuth');
  tunnels.ownedRoute={host:'machine.test.ts.net:443',port:443,proxy:'http://127.0.0.1:3211',funnel:true};current={Web:{'machine.test.ts.net:443':{Handlers:{'/':{Proxy:'http://127.0.0.1:9999'}}}},AllowFunnel:{'machine.test.ts.net:443':true}};await tunnels.close();assert.equal(tunnels.ownedRoute,null);
});
test('connector packages have fixed platform digests and refuse changed downloads',()=>{
  for(const key of [['win32','x64'],['darwin','arm64'],['darwin','x64'],['linux','x64'],['linux','arm64']])assert.match(connectorPlan('ngrok',...key).sha256,/^[a-f0-9]{64}$/);
  assert.throws(()=>verifiedDownload(Buffer.from('unexpected binary'),'0'.repeat(64)),{code:'connector_checksum_failed'});
});
