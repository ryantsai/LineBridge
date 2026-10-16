import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {Store} from '../server/store.mjs';
import {Vault} from '../server/vault.mjs';
import {Hub} from '../server/hub.mjs';
import {ProtocolWorker} from '../server/worker.mjs';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter,once} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {startSource} from './worker-test-utils.mjs';

const flush=async()=>{for(let n=0;n<50;n++)await Promise.resolve();};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const profile={mid:'synthetic',displayName:'Synthetic profile'};
const network=()=>Object.assign(new Error('PRIVATE upstream payload'),{code:'upstream_unavailable'});
async function fixture(t){
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.UTC(2026,9,16)});
  const store=new Store(':memory:'),vault=new Vault(randomBytes(32),'synthetic'),drivers=[],logins=[],next=[];
  const hub=new Hub(store,vault,(account,_storage,events)=>{
    const driver={accountId:account.id,events,ready:false,stops:0,monitors:[],
      async login(qr){logins.push({id:account.id,qr});const result=next.length?await next.shift()(account.id):profile;this.ready=true;return result;},
      async check(){return profile;},stop(){this.ready=false;this.stops++;},
      async startMonitor(chats,reset){this.monitors.push({chats:chats.map(c=>c.id),reset});},async stopMonitor(){}};
    drivers.push(driver);return driver;
  });
  t.after(()=>{hub.close();store.close();});
  async function add(){
    const a=store.addAccount('PRIVATE account label','line','IOSIPAD');
    store.putSecret(a.id,'bridge.authToken',vault.seal('PRIVATE saved token',`${a.id}:bridge.authToken`));
    await hub.connect(a.id);
    store.putChat(a.id,{id:'synthetic-room',name:'PRIVATE room name',kind:'group'});store.designate(a.id,'synthetic-room',true);
    await hub.monitor(a.id,true);return a.id;
  }
  const id=await add();
  const fault=(code='protocol_error',accountId=id)=>hub.runtime.get(accountId).driver.events.fault(code);
  const tick=async ms=>{t.mock.timers.tick(ms);await flush();};
  return {store,vault,hub,drivers,logins,next,id,add,fault,tick};
}

test('an exited LINE worker no longer leaves a connected account permanently in error',async t=>{
  const f=await fixture(t),old=f.hub.runtime.get(f.id),secret=f.store.secret(f.id,'bridge.authToken');
  f.fault();assert.equal(old.status,'error');assert.equal(old.driver.ready,false);
  await f.tick(4999);assert.equal(f.logins.length,1);
  await f.tick(1);const current=f.hub.runtime.get(f.id);
  assert.notEqual(current,old);assert.equal(current.status,'connected');assert.equal(f.logins.length,2);
  assert.deepEqual(f.logins.map(call=>call.qr),[false,false]);
  assert.deepEqual(current.driver.monitors,[{chats:['synthetic-room'],reset:false}]);
  assert.equal(f.store.secret(f.id,'bridge.authToken'),secret);assert.equal(f.store.setting(`monitor:${f.id}`),true);
  assert.equal(current.monitorStreams.talk,undefined,'A new login must not claim that LINE reception has succeeded');
  const audits=f.store.audits().filter(e=>['account.fault','account.recovery'].includes(e.action));
  assert.ok(audits.some(e=>e.action==='account.fault'&&e.details.code==='protocol_error'));
  assert.ok(audits.some(e=>e.action==='account.recovery'&&e.outcome==='connected'));
  assert.doesNotMatch(JSON.stringify(audits),/PRIVATE/);
});

test('a session-expired event remains stopped because the LINE device is no longer authorized',async t=>{
  const f=await fixture(t);f.fault('session_expired');await f.tick(7200000);
  assert.equal(f.hub.runtime.get(f.id).status,'error');assert.deepEqual(f.logins.map(call=>call.qr),[false]);
  assert.equal(f.store.account(f.id).connected,0);
  assert.ok(f.store.audits().some(e=>e.action==='account.fault'&&e.details.code==='session_expired'));
});

test('repeated faults are coalesced and failed recovery logins stop after three bounded attempts',async t=>{
  const f=await fixture(t);f.next.push(...Array.from({length:3},()=>async()=>{throw network();}));
  const old=f.hub.runtime.get(f.id).driver;
  f.fault();f.fault();old.events.fault('protocol_error');
  await f.tick(5000);assert.equal(f.logins.length,2);
  await f.tick(29999);assert.equal(f.logins.length,2);await f.tick(1);assert.equal(f.logins.length,3);
  await f.tick(119999);assert.equal(f.logins.length,3);await f.tick(1);assert.equal(f.logins.length,4);
  await f.tick(7200000);assert.equal(f.logins.length,4);
  assert.equal(f.hub.view(f.store.account(f.id)).recovery.status,'exhausted');
  assert.equal(f.store.setting(`monitor:${f.id}`),true);
  assert.equal(f.store.audits().filter(e=>e.action==='account.recovery'&&e.outcome==='attempt').length,3);
});

test('the hourly automatic budget survives successful logins and a manual reconnect',async t=>{
  const f=await fixture(t);
  for(let i=0;i<3;i++){f.fault();await f.tick(5000);assert.equal(f.hub.runtime.get(f.id).status,'connected');}
  await f.hub.connect(f.id);const manualCount=f.logins.length;
  f.fault();await f.tick(300000);assert.equal(f.logins.length,manualCount);
  assert.equal(f.hub.view(f.store.account(f.id)).recovery.status,'exhausted');
  assert.equal(f.store.audits().filter(e=>e.action==='account.recovery'&&e.outcome==='attempt').length,3);
});

test('a new Hub respects the durable hourly budget and a later fresh fault can recover after it expires',async t=>{
  const f=await fixture(t);
  for(let n=0;n<3;n++){f.fault();await f.tick(5000);}
  f.hub.close();const restarted=new Hub(f.store,f.vault,f.hub.driverFactory);t.after(()=>restarted.close());
  await restarted.connect(f.id);const before=f.logins.length;
  restarted.runtime.get(f.id).driver.events.fault('protocol_error');await f.tick(5000);
  assert.equal(f.logins.length,before);assert.equal(restarted.view(f.store.account(f.id)).recovery.status,'exhausted');
  await f.tick(3600000);assert.equal(f.logins.length,before,'Exhaustion does not create an endless periodic retry');
  await restarted.connect(f.id);restarted.runtime.get(f.id).driver.events.fault('protocol_error');await f.tick(5000);
  assert.equal(restarted.runtime.get(f.id).status,'connected');assert.equal(f.logins.length,before+2);
});

test('an exhausted account stays stopped across service initialization until an explicit manual reconnect',async t=>{
  const f=await fixture(t);f.next.push(...Array.from({length:3},()=>async()=>{throw network();}));
  f.fault();for(const delay of [5000,30000,120000])await f.tick(delay);
  assert.equal(f.store.account(f.id).connected,0);const before=f.logins.length,secret=f.store.secret(f.id,'bridge.authToken');
  f.hub.close();const restarted=new Hub(f.store,f.vault,f.hub.driverFactory);t.after(()=>restarted.close());
  await restarted.initialize();assert.equal(f.logins.length,before);assert.equal(restarted.view(f.store.account(f.id)).status,'disconnected');
  assert.equal(f.store.setting(`monitor:${f.id}`),true);assert.equal(f.store.secret(f.id,'bridge.authToken'),secret);
  await restarted.connect(f.id);assert.equal(f.logins.length,before+1);assert.equal(restarted.runtime.get(f.id).status,'connected');
});

test('auth-invalid, login-required, vault and unknown faults never trigger recovery',async t=>{
  const f=await fixture(t);
  for(const code of ['login_required','auth_invalid','vault_write_failed','PRIVATE unexpected error']){
    await f.hub.connect(f.id);const count=f.logins.length;f.fault(code);await f.tick(7200000);assert.equal(f.logins.length,count,code);
  }
  assert.doesNotMatch(JSON.stringify(f.store.audits()),/PRIVATE unexpected error/);
});

test('an explicit authentication rejection stops an automatic login episode',async t=>{
  const f=await fixture(t);f.next.push(async()=>{throw Object.assign(new Error('PRIVATE auth details'),{code:'login_required'});});
  f.fault();await f.tick(5000);await f.tick(7200000);
  assert.equal(f.logins.length,2);assert.equal(f.hub.runtime.get(f.id).error,'login_required');assert.equal(f.store.account(f.id).connected,0);
  assert.equal(f.hub.view(f.store.account(f.id)).recovery.status,'stopped');
});

for(const action of ['disconnect','remove','drain','close'])test(`${action} cancels a pending recovery and does not revive an account`,async t=>{
  const f=await fixture(t);f.fault();
  if(action==='disconnect'||action==='remove')f.hub[action](f.id);else await f.hub[action]();
  await f.tick(7200000);assert.equal(f.logins.length,1);
});

for(const outcome of ['resolve','reject'])test(`late recovery login ${outcome} cannot overwrite a manual replacement or its monitoring`,async t=>{
  const f=await fixture(t),pending=deferred();f.next.push(()=>pending.promise);
  f.fault();await f.tick(5000);assert.equal(f.logins.length,2);const stale=f.hub.runtime.get(f.id);
  f.hub.disconnect(f.id);await f.hub.connect(f.id);const replacement=f.hub.runtime.get(f.id);
  if(outcome==='resolve')pending.resolve(profile);else pending.reject(network());await flush();
  stale.driver.events.fault('protocol_error');await f.tick(300000);
  assert.equal(f.hub.runtime.get(f.id),replacement);assert.equal(replacement.status,'connected');assert.equal(replacement.driver.ready,true);
  assert.equal(f.logins.length,3);assert.equal(replacement.driver.monitors.length,1);
});

test('drain cancels an in-flight recovery before a late login response can publish success',async t=>{
  const f=await fixture(t),pending=deferred();f.next.push(()=>pending.promise);f.fault();await f.tick(5000);
  await f.hub.drain();pending.resolve(profile);await flush();await f.tick(300000);
  assert.equal(f.logins.length,2);assert.notEqual(f.hub.runtime.get(f.id).status,'connected');
  assert.equal(f.store.audits().filter(e=>e.action==='account.recovery'&&e.outcome==='connected').length,0);
});

test('session expiry during an automatic login stops the episode and fences its late success',async t=>{
  const f=await fixture(t),pending=deferred();f.next.push(()=>pending.promise);f.fault();await f.tick(5000);
  assert.equal(f.logins.length,2);f.fault('session_expired');pending.resolve(profile);await flush();await f.tick(7200000);
  assert.equal(f.logins.length,2);assert.equal(f.hub.runtime.get(f.id).status,'error');assert.equal(f.hub.runtime.get(f.id).error,'session_expired');
  assert.equal(f.hub.runtime.get(f.id).driver.ready,false);assert.equal(f.store.account(f.id).connected,0);
  assert.equal(f.hub.view(f.store.account(f.id)).recovery.status,'stopped');
});

test('monitoring disabled during recovery remains disabled after the connection resumes',async t=>{
  const f=await fixture(t);f.fault();await f.hub.monitor(f.id,false);await f.tick(5000);
  assert.equal(f.hub.runtime.get(f.id).status,'connected');assert.equal(f.store.setting(`monitor:${f.id}`),false);
  assert.deepEqual(f.hub.runtime.get(f.id).driver.monitors,[]);
});

test('a failed monitor restore preserves the saved choice for the next bounded recovery attempt',async t=>{
  const f=await fixture(t);
  f.next.push(async()=>{f.drivers.at(-1).startMonitor=async()=>{throw network();};return profile;});
  f.fault();await f.tick(5000);assert.equal(f.hub.runtime.get(f.id).status,'error');assert.equal(f.store.setting(`monitor:${f.id}`),true);
  await f.tick(30000);assert.equal(f.hub.runtime.get(f.id).status,'connected');
  assert.deepEqual(f.drivers.at(-1).monitors,[{chats:['synthetic-room'],reset:false}]);
});

test('worker loss during a pending manual monitor start preserves the saved monitoring choice',async t=>{
  const f=await fixture(t),pending=deferred();await f.hub.monitor(f.id,false);
  f.drivers.at(-1).startMonitor=()=>pending.promise;
  const start=assert.rejects(f.hub.monitor(f.id,true),{code:'upstream_unavailable'});await flush();
  assert.equal(f.store.setting(`monitor:${f.id}`),true);f.fault();pending.reject(network());await start;
  assert.equal(f.store.setting(`monitor:${f.id}`),true);
  await f.tick(5000);assert.equal(f.hub.runtime.get(f.id).status,'connected');
  assert.deepEqual(f.drivers.at(-1).monitors,[{chats:['synthetic-room'],reset:false}]);
});

test('a missing stored token or a failed budget write never dispatches an automatic login',async t=>{
  const f=await fixture(t);f.store.deleteSecrets(f.id);f.fault();await f.tick(300000);assert.equal(f.logins.length,1);
  await f.hub.connect(f.id);f.store.putSecret(f.id,'bridge.authToken',f.vault.seal('synthetic',`${f.id}:bridge.authToken`));
  f.fault();const original=f.store.setSetting.bind(f.store);
  t.mock.method(f.store,'setSetting',(key,value)=>{if(key.startsWith('accountRecoveryAttempts:'))throw new Error('PRIVATE storage failure');return original(key,value);});
  await f.tick(5000);assert.equal(f.logins.length,2);assert.equal(f.hub.view(f.store.account(f.id)).recovery.status,'stopped');
  assert.doesNotMatch(JSON.stringify(f.store.audits()),/PRIVATE/);
});

test('an unreadable encrypted credential stops recovery before contacting LINE again',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.UTC(2026,9,16)});
  const store=new Store(':memory:'),hub=new Hub(store,new Vault(randomBytes(32),'synthetic')),requests=[];
  t.after(()=>{hub.close();store.close();});
  // Keep the production worker driver and VaultStorage; replace only external IPC.
  hub.worker.call=async method=>{requests.push(method);return profile;};
  const a=store.addAccount('Synthetic','line','IOSIPAD');
  store.putSecret(a.id,'bridge.authToken',hub.vault.seal('synthetic',`${a.id}:bridge.authToken`));await hub.connect(a.id);
  store.putSecret(a.id,'bridge.authToken','PRIVATE malformed ciphertext');hub.worker.events.get(a.id).fault('protocol_error');
  t.mock.timers.tick(5000);await flush();t.mock.timers.tick(30000);await flush();
  assert.equal(hub.view(store.account(a.id)).recovery.status,'stopped');assert.equal(hub.runtime.get(a.id).error,'storage_failed');
  assert.equal(hub.view(store.account(a.id)).recovery.attempts,1);assert.equal(store.account(a.id).connected,0);
  assert.deepEqual(requests,['connect']);assert.doesNotMatch(JSON.stringify(store.audits()),/PRIVATE|ciphertext/);
});

for(const failure of ['negative acknowledgement','acknowledgement timeout'])test(`a credential write ${failure} remains terminal across the actual private worker pipe`,async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.UTC(2026,9,16)});
  const store=new Store(':memory:'),hub=new Hub(store,new Vault(randomBytes(32),'synthetic'));
  t.after(()=>{hub.close();store.close();});
  const source=`import {LineDriver} from './server/drivers.mjs';
    let logins=0;
    LineDriver.prototype.login=async function(){if(++logins>1)await this.storage.set('refreshToken','synthetic');this.ready=true;return {mid:'synthetic',displayName:'Synthetic'};};
    await import('./protocol/worker.mjs');`;
  startSource(t,hub.worker,source);
  const a=store.addAccount('Synthetic','line','IOSIPAD');store.putSecret(a.id,'bridge.authToken',hub.vault.seal('synthetic',`${a.id}:bridge.authToken`));
  await hub.connect(a.id);
  const write=hub.worker.write.bind(hub.worker),put=store.putSecret.bind(store),handle=hub.worker.handle.bind(hub.worker);
  if(failure==='negative acknowledgement')store.putSecret=(id,key,value)=>{if(key==='refreshToken')throw new Error('PRIVATE disk error');return put(id,key,value);};
  else hub.worker.write=value=>{if(value.type!=='storage_ack')write(value);};
  let received;const errorResult=new Promise(resolve=>{received=resolve;});
  hub.worker.handle=message=>{handle(message);if(message.type==='result'&&message.error)received();};
  hub.worker.events.get(a.id).fault('protocol_error');t.mock.timers.tick(5000);await flush();await errorResult;await flush();
  assert.equal(hub.runtime.get(a.id).error,'vault_write_failed');assert.equal(hub.view(store.account(a.id)).recovery.status,'stopped');
  assert.equal(store.account(a.id).connected,0);t.mock.timers.tick(7200000);await flush();
  assert.equal(store.audits().filter(e=>e.action==='account.recovery'&&e.outcome==='attempt').length,1);
  assert.doesNotMatch(JSON.stringify(store.audits()),/PRIVATE|synthetic/);
});

test('one account with a pending resume does not block another account recovering from the same worker exit',async t=>{
  const f=await fixture(t),second=await f.add(),pending=deferred();f.next.push(()=>pending.promise);
  f.fault();f.fault('protocol_error',second);await f.tick(5000);
  assert.equal(f.hub.runtime.get(f.id).status,'connecting');assert.equal(f.hub.runtime.get(second).status,'connected');
  f.hub.disconnect(f.id);pending.resolve(profile);await flush();
  assert.equal(f.hub.runtime.get(f.id).status,'disconnected');assert.equal(f.hub.runtime.get(second).status,'connected');
});

test('a stopped superseded worker driver cannot remove or disconnect the current owner',async()=>{
  const worker=new ProtocolWorker(null,null,null),calls=[];worker.call=async(method,params)=>{calls.push({method,params});};worker.child={};
  const account={id:'synthetic'},oldEvents={},currentEvents={};
  const old=worker.driver(account,oldEvents),current=worker.driver(account,currentEvents);current.ready=true;
  old.stop();assert.equal(worker.events.get(account.id),currentEvents);assert.equal(current.ready,true);assert.deepEqual(calls,[]);
  current.stop();assert.equal(worker.events.has(account.id),false);assert.equal(calls.length,1);assert.equal(calls[0].method,'disconnect');
});

test('real worker close handling resumes two accounts in one replacement child without replaying a pending read',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.UTC(2026,9,16)});
  const store=new Store(':memory:'),hub=new Hub(store,new Vault(randomBytes(32),'synthetic')),children=[],requests=[];
  const spawned=t.mock.method(childProcess,'spawn',()=>{
    const child=new EventEmitter();child.stdout=new PassThrough();child.kill=()=>true;
    child.stdin=new Writable({write(bytes,_encoding,done){
      const request=JSON.parse(String(bytes));requests.push({child,request});
      if(request.method!=='read')queueMicrotask(()=>child.stdout.write(JSON.stringify({type:'result',id:request.id,result:request.method==='connect'?profile:{ok:true}})+'\n'));
      done();
    }});children.push(child);return child;
  });syncBuiltinESMExports();
  t.after(()=>{hub.close();store.close();spawned.mock.restore();syncBuiltinESMExports();for(const child of children){child.stdout.destroy();child.stdin.destroy();}});
  const ids=[];
  for(let n=0;n<2;n++){
    const a=store.addAccount('Synthetic','line','IOSIPAD');ids.push(a.id);
    store.putSecret(a.id,'bridge.authToken',hub.vault.seal('synthetic',`${a.id}:bridge.authToken`));await hub.connect(a.id);
  }
  await hub.monitor(ids[0],true);
  const pending=assert.rejects(hub.worker.call('read',{accountId:ids[0]}),{code:'upstream_unavailable'}),original=children[0];
  original.emit('exit',2);await flush();assert.equal(hub.runtime.get(ids[0]).status,'connected','Wait for stdout before faulting accounts');
  const ended=once(original.stdout,'end');original.stdout.end();await ended;original.emit('close',2);await pending;
  assert.equal(hub.runtime.get(ids[0]).status,'error');assert.equal(hub.runtime.get(ids[1]).status,'error');
  t.mock.timers.tick(5000);await flush();
  assert.equal(children.length,2);assert.ok(ids.every(id=>hub.runtime.get(id).status==='connected'));
  assert.equal(requests.filter(({request})=>request.method==='read').length,1);
  assert.deepEqual(requests.filter(({child})=>child===children[1]).map(({request})=>request.method),['connect','connect','monitor_start']);
  assert.equal(store.setting(`monitor:${ids[1]}`,false),false);
});
