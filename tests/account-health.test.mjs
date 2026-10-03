import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {Store} from '../server/store.mjs';
import {Vault} from '../server/vault.mjs';
import {Hub,adminActor} from '../server/hub.mjs';
import {LineDriver} from '../server/drivers.mjs';
import {ProtocolWorker} from '../server/worker.mjs';
import {accountDiagnostic,accountCheckError,ACCOUNT_CHECK_TIMEOUT_MS} from '../server/account-health.mjs';

const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const profile={displayName:'Synthetic profile',mid:'synthetic-account'};
const network=()=>Object.assign(new TypeError('secret URL https://token.invalid/secret'),{cause:{code:'ECONNRESET',message:'secret token'}});
const protocol=code=>Object.assign(new Error('secret payload and headers'),{name:'RequestError',data:{code,reason:'secret'}});
async function fixture(t,check=async()=>profile){
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.UTC(2026,9,4)});
  const store=new Store(':memory:'),hub=new Hub(store,new Vault(randomBytes(32),'synthetic'),()=>{
    const driver={ready:false,stops:0,starts:0,monitorStops:0,checks:0,
      async login(){this.ready=true;return profile;},async check(signal){this.checks++;return check(signal);},
      stop(){this.ready=false;this.stops++;},async startMonitor(){this.starts++;},async stopMonitor(){this.monitorStops++;}};
    return driver;
  });
  t.after(()=>{hub.close();store.close();});
  const a=store.addAccount('Synthetic LINE account','line','IOSIPAD');await hub.connect(a.id);
  for(const [id,kind] of [['talk-chat','group'],['room-1','openchat'],['room-2','openchat']]){store.putChat(a.id,{id,name:id,kind});store.designate(a.id,id,true);}
  await hub.monitor(a.id,true);
  const r=hub.runtime.get(a.id),success=new Date().toISOString();
  r.monitorStreams=Object.fromEntries(['talk','room-1','room-2'].map(channel=>[channel,{channel,status:'running',ready:true,lastSuccessAt:success}]));
  return {store,hub,a,r,driver:r.driver,success};
}

test('transient account failure recovers on the same driver without renewing any receiver success',async t=>{
  let fail=true;const {hub,a,r,driver,success}=await fixture(t,async()=>{if(fail)throw network();return {...profile,displayName:'Recovered'};});
  t.mock.timers.tick(1000);await hub.healthcheck();
  assert.equal(r.status,'connected');assert.equal(driver.stops,0);assert.equal(r.error,'health_check_failed');
  assert.equal(r.accountHealth.status,'retrying');assert.equal(r.accountHealth.lastSuccessAt,success);assert.equal(r.lastChecked,success);
  assert.deepEqual(r.accountHealth.lastFailure,{at:new Date().toISOString(),kind:'network',errorName:'TypeError',code:'ECONNRESET',elapsedMs:0,retryInMs:5000});
  const originalFailure={...r.accountHealth.lastFailure};fail=false;
  t.mock.timers.tick(4999);await flush();assert.equal(driver.checks,1);
  t.mock.timers.tick(1);await flush();assert.equal(driver.checks,2);assert.equal(r.accountHealth.status,'healthy');assert.equal(r.error,null);
  assert.equal(r.profile.displayName,'Recovered');assert.equal(driver.starts,1);assert.equal(driver.stops,0);assert.equal(r.accountHealth.consecutiveFailures,0);
  assert.deepEqual(r.accountHealth.lastFailure,originalFailure);assert.equal(r.accountHealth.nextRetryAt,null);
  t.mock.timers.tick(60001);await hub.healthcheck();
  assert.equal(r.accountHealth.status,'healthy');const view=hub.accounts(adminActor)[0];assert.equal(view.monitor.health,'stale');
  for(const stream of Object.values(view.monitor.streams))assert.equal(stream.lastSuccessAt,success);
  assert.ok(!JSON.stringify(view.accountHealth).includes('secret'));
});

test('only explicit Talk authentication failures invalidate a session and stop retries',async t=>{
  const {hub,store,a,r,driver,success}=await fixture(t,async()=>{throw protocol('NOT_AUTHORIZED_DEVICE');});
  await hub.healthcheck();assert.equal(r.status,'error');assert.equal(r.error,'login_required');assert.equal(driver.stops,1);assert.equal(driver.ready,false);
  assert.equal(r.accountHealth.status,'auth_invalid');assert.equal(r.accountHealth.lastFailure.kind,'auth');assert.equal(r.accountHealth.lastFailure.retryInMs,null);
  assert.equal(store.account(a.id).connected,0);assert.equal(store.setting(`monitor:${a.id}`),true);
  assert.equal(hub.view(store.account(a.id)).monitor.health,'disconnected');assert.equal(r.lastChecked,success);
  t.mock.timers.tick(600000);await hub.healthcheck();assert.equal(driver.checks,1);assert.equal(driver.stops,1);
  for(const code of ['AUTHENTICATION_FAILED','NOT_AUTHORIZED_SESSION','NOT_AUTHENTICATED',1,8,14,17])assert.equal(accountDiagnostic(protocol(code)).kind,'auth');
  for(const code of ['FORBIDDEN','MUST_REFRESH_V3_TOKEN','NOT_AVAILABLE_SESSION',401,'token-secret'])assert.notEqual(accountDiagnostic(protocol(code)).kind,'auth');
  assert.notEqual(accountDiagnostic({name:'Error',code:'NOT_AUTHORIZED_DEVICE',message:'AUTHENTICATION_FAILED'}).kind,'auth');
});

test('repeated failures use bounded backoff, coalesce periodic checks and recover after the cap',async t=>{
  let fail=true;const {hub,r,driver}=await fixture(t,async()=>{if(fail)throw protocol('EXCESSIVE_ACCESS');return profile;});
  await hub.healthcheck();let calls=1;
  for(const delay of [5000,10000,20000,40000,60000,60000]){
    assert.equal(r.accountHealth.lastFailure.retryInMs,delay);
    await Promise.all([hub.healthcheck(),hub.healthcheck()]);assert.equal(driver.checks,calls);
    t.mock.timers.tick(delay-1);await flush();assert.equal(driver.checks,calls);
    t.mock.timers.tick(1);await flush();assert.equal(driver.checks,++calls);
  }
  fail=false;t.mock.timers.tick(60000);await flush();assert.equal(r.accountHealth.status,'healthy');assert.equal(r.accountHealth.consecutiveFailures,0);
  assert.equal(driver.stops,0);assert.equal(driver.starts,1);
});

test('disabling monitoring during a retry stays disabled after account recovery',async t=>{
  let fail=true;const {hub,store,a,r,driver}=await fixture(t,async()=>{if(fail)throw network();return profile;});
  await hub.healthcheck();await hub.monitor(a.id,false);fail=false;t.mock.timers.tick(5000);await flush();
  assert.equal(r.accountHealth.status,'healthy');assert.equal(store.setting(`monitor:${a.id}`),false);assert.equal(driver.starts,1);assert.equal(driver.monitorStops,1);
  assert.deepEqual(r.monitorStreams,{});assert.equal(hub.view(store.account(a.id)).monitor.health,'off');
});

for(const action of ['disconnect','forget','remove','close'])test(`${action} cancels account retries and ignores a late in-flight success`,async t=>{
  const pending=deferred();let fail=true;const {hub,a,r,driver}=await fixture(t,async()=>{if(fail)throw network();return pending.promise;});
  await hub.healthcheck();fail=false;t.mock.timers.tick(5000);await flush();assert.equal(driver.checks,2);const job=r.healthJob;
  const before={profile:r.profile,lastChecked:r.lastChecked};
  if(action==='forget')hub.disconnect(a.id,true);else if(action==='close')hub.close();else hub[action](a.id);
  await job;assert.equal(r.healthController,null);assert.equal(r.healthTimer,null);
  pending.resolve({...profile,displayName:'Late result'});await flush();t.mock.timers.tick(600000);await hub.healthcheck();
  assert.equal(driver.checks,2);assert.equal(r.profile,before.profile);assert.equal(r.lastChecked,before.lastChecked);
  if(action==='remove')assert.equal(hub.runtime.has(a.id),false);
  else if(action!=='close')assert.equal(hub.runtime.get(a.id).status,'disconnected');
});

test('disconnect before a retry fires prevents another RPC',async t=>{
  const {hub,a,driver}=await fixture(t,async()=>{throw network();});await hub.healthcheck();hub.disconnect(a.id);
  t.mock.timers.tick(600000);await flush();await hub.healthcheck();assert.equal(driver.checks,1);
});

test('a replaced session and overlapping health ticks cannot publish a late failure or duplicate probe',async t=>{
  const pending=deferred();const {hub,a,r,driver}=await fixture(t,()=>pending.promise);
  const first=hub.healthcheck();await flush();assert.equal(r.accountHealth.status,'checking');assert.equal(driver.checks,1);
  await Promise.all([hub.healthcheck(),hub.healthcheck()]);assert.equal(driver.checks,1);
  await hub.connect(a.id);const replacement=hub.runtime.get(a.id);pending.reject(protocol('NOT_AUTHORIZED_DEVICE'));await first;await flush();
  assert.notEqual(replacement,r);assert.equal(replacement.status,'connected');assert.equal(replacement.error,undefined);assert.equal(replacement.driver.stops,0);
  assert.equal(replacement.accountHealth.status,'healthy');assert.equal(r.healthTimer,null);
});

test('hung account checks are bounded, do not block other accounts and do not claim success',async t=>{
  const never=deferred();const {hub,store,r,driver,success}=await fixture(t,()=>never.promise);
  const other=store.addAccount('Another synthetic account','line','IOSIPAD');await hub.connect(other.id);hub.runtime.get(other.id).driver.check=async()=>profile;
  const job=hub.healthcheck();await flush();assert.equal(hub.runtime.get(other.id).accountHealth.status,'healthy');assert.equal(driver.checks,1);
  t.mock.timers.tick(ACCOUNT_CHECK_TIMEOUT_MS+5000);await job;
  assert.equal(r.accountHealth.status,'retrying');assert.equal(r.accountHealth.lastFailure.kind,'timeout');assert.equal(r.lastChecked,success);assert.equal(hub.queues.size,0);
  never.resolve({...profile,displayName:'Too late'});await flush();assert.equal(r.profile.displayName,profile.displayName);
});

test('malformed profile and unknown protocol/parse errors remain unhealthy and retain only allowlisted diagnostics',async t=>{
  const {hub,r}=await fixture(t,async()=>({displayName:'Invalid'}));await hub.healthcheck();assert.equal(r.accountHealth.status,'retrying');assert.equal(r.accountHealth.lastFailure.kind,'unknown');
  const hostile={name:'secret-name',message:'secret token',stack:'secret',code:'secret',cause:{code:'secret'},data:{code:'secret',headers:'secret',body:'secret'}};
  assert.deepEqual(accountDiagnostic(hostile),{kind:'unknown',errorName:'UnknownError'});
  assert.deepEqual(accountDiagnostic(protocol('FORBIDDEN')),{kind:'protocol',errorName:'RequestError',code:'FORBIDDEN'});
  assert.deepEqual(accountDiagnostic({name:'TimeoutError',message:'secret'}),{kind:'timeout',errorName:'TimeoutError'});
  assert.ok(!JSON.stringify(accountCheckError(hostile)).includes('secret'));
});

test('profile RPC errors preserve safe classification across the real driver and worker result boundary',async()=>{
  const d=Object.create(LineDriver.prototype);d.abort=new AbortController();d.monitorRequest=(_,operation)=>operation();
  d.client={profile:{...profile},talk:{getProfile:async()=>{throw protocol('NOT_AUTHORIZED_DEVICE');}}};
  let raw;try{await d.check();}catch(error){raw=error;}
  assert.equal(raw.code,'login_required');assert.equal(raw.accountDiagnostic.kind,'auth');assert.ok(!JSON.stringify(raw).includes('secret'));
  const worker=new ProtocolWorker(null,null,null);const result=deferred();
  worker.pending.set('check',{method:'check',timer:setTimeout(()=>{},1000),reject:result.reject});
  worker.handle({type:'result',id:'check',error:{...JSON.parse(JSON.stringify(raw)),message:'secret payload',accountDiagnostic:{...raw.accountDiagnostic,stack:'secret',headers:'secret'}}});
  await assert.rejects(result.promise,error=>{assert.deepEqual(accountDiagnostic(error),raw.accountDiagnostic);assert.ok(!JSON.stringify(error).includes('secret'));return true;});
  d.client.talk.getProfile=async()=>null;await assert.rejects(d.check(),error=>error.accountDiagnostic.kind==='unknown');
  d.client.talk.getProfile=async()=>profile;const controller=new AbortController();controller.abort();await assert.rejects(d.check(controller.signal));
  assert.notEqual(d.client.profile,profile);
});

test('a profile deadline cancels only that request and keeps a concurrent receiver fetch alive',async t=>{
  const deadline=new AbortController(),requests=[];
  t.mock.method(AbortSignal,'timeout',ms=>{assert.equal(ms,ACCOUNT_CHECK_TIMEOUT_MS);return deadline.signal;});
  t.mock.method(globalThis,'fetch',request=>{requests.push(request);return new Promise((resolve,reject)=>request.signal.addEventListener('abort',()=>reject(request.signal.reason),{once:true}));});
  const driver=new LineDriver({device:'IOSIPAD'},{},{fault:()=>{}});t.after(()=>driver.stop());
  driver.client.talk.getProfile=async()=>{await driver.client.fetch(new Request('https://synthetic.invalid/profile'));return profile;};
  const receiver=new AbortController();const poll=driver.monitorRequest(receiver.signal,()=>driver.client.fetch(new Request('https://synthetic.invalid/poll'))).catch(()=>{});
  const checked=driver.check();await flush();assert.equal(requests.length,2);
  deadline.abort(new DOMException('secret URL','TimeoutError'));
  await assert.rejects(checked,error=>error.accountDiagnostic.kind==='timeout'&&!JSON.stringify(error).includes('secret'));
  assert.equal(requests[0].signal.aborted,false);assert.equal(driver.abort.signal.aborted,false);
  receiver.abort();await poll;
});

test('parent check cancellation cleans pending IPC and ignores a late worker result',async()=>{
  const worker=new ProtocolWorker(null,null,null),requests=[];worker.start=()=>{};worker.write=value=>requests.push(value);
  const controller=new AbortController(),job=worker.call('check',{accountId:'synthetic'},35000,controller.signal);
  assert.equal(worker.pending.size,1);controller.abort();await assert.rejects(job,{name:'AbortError'});assert.equal(worker.pending.size,0);
  worker.handle({type:'result',id:requests[0].id,result:profile});assert.equal(worker.pending.size,0);worker.close();
});
