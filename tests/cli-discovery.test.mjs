import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {runCli} from '../client/cli.mjs';
import {Store} from '../server/store.mjs';
import {Vault} from '../server/vault.mjs';
import {Hub} from '../server/hub.mjs';
import {LocalSetup} from '../server/local-setup.mjs';
import {createApps} from '../server/app.mjs';
import {defaultDataDirectory} from '../server/service-location.mjs';
import {removeClientFixture} from './client-test-utils.mjs';

async function cli(args,options={}){
  let stdout='',stderr='';
  const code=await runCli(args,{env:{},stdout:{write:s=>{stdout+=s;}},stderr:{write:s=>{stderr+=s;}},...options});
  return {code,json:JSON.parse(stdout),stdout,stderr};
}
async function directory(t){const dir=await mkdtemp(join(tmpdir(),'linebridge-discovery-'));t.after(()=>removeClientFixture(dir));return dir;}
async function fixture(t){
  const dir=await directory(t),items=new Map();let reads=0;
  const credentials={protection:'synthetic',create:async(profile,url,value)=>items.set(profile,{url,...value}),get:async profile=>{reads++;return items.get(profile);},forget:async profile=>items.delete(profile)};
  const store=new Store(':memory:'),hub=new Hub(store,new Vault(randomBytes(32),'synthetic'));
  const admin=createServer(),gateway=createServer();
  await Promise.all([admin,gateway].map(server=>new Promise(ok=>server.listen(0,'127.0.0.1',ok))));
  const adminPort=admin.address().port,gatewayPort=gateway.address().port;
  const setup=new LocalSetup(hub,{credentials,gatewayPort});
  const apps=createApps({hub,localSetup:setup,root:resolve('.'),adminPort,gatewayPort,instance:'synthetic-instance',tunnels:{config:()=>({provider:'local'}),gatewayHostname:()=>null}});
  admin.on('request',apps.admin);gateway.on('request',apps.gateway);
  t.after(async()=>{hub.close();await Promise.all([admin,gateway].map(server=>{server.closeAllConnections();return new Promise(ok=>server.close(ok));}));store.close();});
  const m={runtime:'node',instance:'synthetic-instance',adminPort,gatewayPort,dataDir:dir};
  await writeFile(join(dir,'service.json'),JSON.stringify(m));
  const account=await hub.addAccount({label:'Discovery test account',kind:'demo'});
  await setup.enable(account.id,{chatIds:['demo-group'],read:true,send:true,confirmed:true});
  const profile=setup.record(account.id).profile;
  return {dir,store,hub,setup,account,profile,credentials,items,m,admin,reads:()=>reads,command:(args,options={})=>cli(args,{store:credentials,env:{LINE_BRIDGE_DATA:dir},...options})};
}

test('discovery finds existing setups without credential access, then scoped CLI queries find current chats',async t=>{
  const f=await fixture(t),before=f.reads();
  f.items.set('manual-profile',{url:'https://unrelated.example',token:'synthetic-private-manual-token'});
  f.hub.designate(f.account.id,'demo-openchat',true);
  const tokenCount=f.store.tokens().length,auditCount=f.store.audits().length;
  const result=await f.command(['discover'],{env:{LINE_BRIDGE_DATA:f.dir,LINE_BRIDGE_URL:'https://ignored.example',LINE_BRIDGE_TOKEN:'ignored-synthetic-token',CF_ACCESS_CLIENT_SECRET:'ignored-synthetic-access'}});
  assert.equal(result.code,0);assert.equal(result.stderr,'');assert.equal(f.reads(),before);
  assert.equal(result.json.status,'running');assert.equal(result.json.dataDir,f.dir);
  assert.deepEqual(result.json.cli,{node:process.execPath,script:join(resolve('.'),'bin/linebridge.mjs'),platform:process.platform});
  assert.deepEqual(result.json.profiles,[{profile:f.profile,url:f.setup.url,accountId:f.account.id,accountLabel:f.account.label,expiresAt:f.store.token(f.setup.record(f.account.id).tokenId).expires_at}]);
  for(const secret of [...f.items.values()].map(c=>c.token))assert.ok(!result.stdout.includes(secret));
  assert.ok(!result.stdout.includes('demo-group'));assert.ok(!result.stdout.includes('manual-profile'));
  assert.equal(f.store.tokens().length,tokenCount);assert.equal(f.store.audits().length,auditCount);
  const accounts=await f.command(['accounts','--profile',result.json.profiles[0].profile]);
  assert.equal(accounts.code,0);assert.deepEqual(accounts.json.map(a=>a.id),[f.account.id]);assert.ok(accounts.json[0].monitor);
  const chats=await f.command(['chats','--profile',f.profile,'--account',accounts.json[0].id]);
  assert.equal(chats.code,0);assert.deepEqual(chats.json.map(c=>c.id),['demo-group']);
});

test('discovery lists multiple setups without selecting one and filters inactive or mismatched grants',async t=>{
  const f=await fixture(t),other=await f.hub.addAccount({label:'Other discovery account',kind:'demo'});
  await f.setup.enable(other.id,{chatIds:['demo-openchat'],read:true,send:true,confirmed:true});
  const before=f.reads(),original=f.setup.record(f.account.id);
  f.store.setSetting('aiEnabled',false);
  const paused=await f.command(['discover']);assert.equal(paused.code,0);assert.equal(paused.json.gatewayEnabled,false);assert.equal(paused.json.profiles.length,2);
  for(const change of [{phase:'enrolling'},{phase:'starting'},{phase:'cleanup_required'},{phase:'revoked'},{url:'http://127.0.0.1:1'}]){
    f.setup.save(f.account.id,{...original,...change});
    assert.deepEqual((await f.command(['discover'])).json.profiles.map(p=>p.accountId),[other.id]);
  }
  f.setup.save(f.account.id,original);
  f.store.db.prepare('UPDATE tokens SET expires_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z',original.tokenId);
  assert.deepEqual((await f.command(['discover'])).json.profiles.map(p=>p.accountId),[other.id]);
  f.store.revoke(f.setup.record(other.id).tokenId);
  assert.deepEqual((await f.command(['discover'])).json.profiles,[]);assert.equal(f.reads(),before);
});

test('discovery endpoint retains the local dashboard session and origin protections',async t=>{
  const f=await fixture(t),base=`http://127.0.0.1:${f.m.adminPort}`;
  assert.equal((await fetch(`${base}/admin/discovery`)).status,401);
  const page=await fetch(`${base}/`),cookie=page.headers.getSetCookie()[0].split(';')[0];await page.body.cancel();
  for(const headers of [{Origin:'https://other.example'},{'X-Forwarded-For':'127.0.0.1'},{'Sec-Fetch-Site':'cross-site'}]){
    assert.equal((await fetch(`${base}/admin/discovery`,{headers:{Cookie:cookie,...headers}})).status,403);
  }
  const response=await fetch(`http://127.0.0.1:${f.m.gatewayPort}/admin/discovery`,{headers:{Authorization:`Bearer ${f.items.get(f.profile).token}`}});
  assert.equal(response.status,404);
});

test('discovery output is allowlisted and ignores ambient credentials and remote endpoints',async t=>{
  const dir=await directory(t),m={runtime:'node',instance:'synthetic',adminPort:53210,gatewayPort:53211,dataDir:dir};await writeFile(join(dir,'service.json'),JSON.stringify(m));
  const requests=[],secret='synthetic-secret-must-not-print';
  const result=await cli(['discover','--data-dir',dir],{env:{LINE_BRIDGE_URL:'https://wrong.example',LINE_BRIDGE_TOKEN:secret},store:{get:()=>assert.fail('Discovery must not open credentials')},fetchImpl:async(url,options)=>{
    requests.push({url,options});
    if(requests.length===1)return new Response('',{headers:{'set-cookie':'lb_admin=synthetic_cookie_12345; HttpOnly'}});
    return new Response(JSON.stringify({instance:m.instance,version:'0.7.3',gatewayEnabled:true,cli:{platform:process.platform,node:process.execPath,script:resolve('bin/linebridge.mjs'),token:secret},profiles:[{profile:'local-test',url:'http://127.0.0.1:53211',accountId:'test',accountLabel:'Test',expiresAt:'2099-01-01T00:00:00Z',token:secret,chatIds:['private-chat']}],tokens:[secret],audit:[secret]}));
  }});
  assert.equal(result.code,0);assert.equal(requests.length,2);assert.ok(!result.stdout.includes(secret));assert.ok(!result.stdout.includes('private-chat'));
  assert.deepEqual(requests.map(r=>r.url),['http://127.0.0.1:53210/','http://127.0.0.1:53210/admin/discovery']);
  for(const {options} of requests){assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.ok(options.signal);assert.ok(!options.headers.Authorization);assert.ok(!options.headers['CF-Access-Client-Secret']);}
  assert.equal(requests[1].options.headers.Cookie,'lb_admin=synthetic_cookie_12345');assert.ok(!result.stdout.includes('synthetic_cookie'));
});

test('stopped discovery is empty; invalid options and service metadata fail before networking',async t=>{
  const dir=await directory(t),options={fetchImpl:()=>assert.fail('Must not contact a service'),store:{get:()=>assert.fail('Must not open credentials')}};
  const stopped=await cli(['discover','--data-dir',dir],options);assert.equal(stopped.code,0);assert.deepEqual(stopped.json,{status:'stopped',dataDir:dir,profiles:[]});
  const help=await cli(['discover','--help'],options);assert.equal(help.code,0);assert.match(help.stderr,/linebridge discover/);
  for(const args of [['--profile','do-not-print'],['--url','https://do-not-print.example'],['--credential-stdin'],['--data-dir',''],['--timeout-ms','0'],['--data-dir',dir,'--data-dir',dir]])assert.equal((await cli(['discover',...args],options)).code,2);
  for(const value of ['not-json',JSON.stringify({runtime:'node',dataDir:dir,instance:'test',adminPort:22,gatewayPort:53211}),'x'.repeat(16385)]){
    await writeFile(join(dir,'service.json'),value);const invalid=await cli(['discover','--data-dir',dir],options);assert.equal(invalid.code,5);assert.equal(invalid.json.error,'discovery_metadata_invalid');
  }
});

test('discovery rejects mismatched instances, old services, redirects, invalid JSON and oversized replies without leaking diagnostics',async t=>{
  const f=await fixture(t);
  for(const [response,code,error] of [
    [()=>new Response(JSON.stringify({instance:'different'})),5,'discovery_instance_mismatch'],
    [()=>new Response('synthetic-secret',{status:404}),6,'discovery_not_supported'],
    [()=>new Response('synthetic-secret',{status:302,headers:{Location:'https://wrong.example'}}),5,'discovery_unavailable'],
    [()=>new Response('synthetic-secret'),5,'discovery_unavailable'],
    [()=>new Response('x'.repeat(4*1024*1024+1)),5,'discovery_unavailable']
  ]){
    let calls=0;const result=await f.command(['discover'],{fetchImpl:async()=>++calls===1?new Response('',{headers:{'set-cookie':'lb_admin=synthetic_cookie_12345'}}):response()});
    assert.equal(result.code,code);assert.equal(result.json.error,error);assert.equal(calls,2);assert.ok(!result.stdout.includes('synthetic-secret'));assert.ok(!result.stderr.includes('synthetic-secret'));
  }
});

test('discovery deadline covers a stalled response body',async t=>{
  const f=await fixture(t);let requests=0;
  f.admin.removeAllListeners('request');f.admin.on('request',(req,res)=>{
    requests++;
    if(req.url==='/'){res.setHeader('Set-Cookie','lb_admin=synthetic_cookie_12345');res.end();}
    else{res.writeHead(200,{'Content-Type':'application/json'});res.write('{');}
  });
  const result=await f.command(['discover','--timeout-ms','100']);assert.equal(result.code,5);assert.equal(result.json.error,'discovery_unavailable');assert.equal(requests,2);
});

test('installed CLI entrypoint dispatches discovery and respects the existing data directory',async t=>{
  const f=await fixture(t),before=f.reads();
  const result=await new Promise((ok,reject)=>{
    const child=spawn(process.execPath,['bin/linebridge.mjs','discover','--data-dir',f.dir],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';const timer=setTimeout(()=>{child.kill();reject(new Error('Discovery subprocess timed out'));},10000);
    child.stdout.on('data',s=>{stdout+=s;});child.stderr.on('data',s=>{stderr+=s;});child.on('error',reject);
    child.on('close',code=>{clearTimeout(timer);ok({code,stdout,stderr});});
  });
  assert.equal(result.code,0,result.stderr);assert.equal(JSON.parse(result.stdout).profiles[0].profile,f.profile);assert.equal(f.reads(),before);
  assert.deepEqual(JSON.parse(await readFile(join(f.dir,'service.json'),'utf8')),f.m);
});

test('discovery and service startup share the custom, default and legacy data location rules',async t=>{
  const dir=await directory(t),env={LOCALAPPDATA:dir};
  assert.equal(defaultDataDirectory({env,platform:'win32'}),join(dir,'LineBridgeData'));
  const {mkdir}=await import('node:fs/promises');await mkdir(join(dir,'LineBridge'));await writeFile(join(dir,'LineBridge','bridge.sqlite'),'synthetic');
  assert.equal(defaultDataDirectory({env,platform:'win32'}),join(dir,'LineBridge'));
  assert.equal(defaultDataDirectory({env:{...env,LINE_BRIDGE_DATA:dir},platform:'win32'}),dir);
});
