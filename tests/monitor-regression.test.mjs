import test from 'node:test';
import assert from 'node:assert/strict';
import {LiveMonitor,pollDiagnostic} from '../protocol/monitor.mjs';
import {TALK_POLL_TIMEOUT_MS} from '../server/monitor-policy.mjs';
import {Store} from '../server/store.mjs';
import {monitorStatus} from '../server/inbox.mjs';
import {LineDriver} from '../server/drivers.mjs';

const flush=()=>new Promise(resolve=>setImmediate(resolve));
const empty={operationResponse:{operations:[]}};
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
function clock(t){t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.parse('2026-10-03T00:00:00Z')});}
function fixture(t,driver,chats=[{id:'chosen',kind:'group'}],capture=()=>{}){
  const states=[],monitor=new LiveMonitor(driver,(_event,state)=>states.push(state),capture);
  monitor.update(chats);
  t.after(async()=>{monitor.stop();await Promise.all([monitor.talkTask,...[...monitor.rooms.values()].map(r=>r.task)]);});
  return {monitor,states};
}

test('a synthetic 20-second empty Talk poll survives the old deadline and renews success only after checkpoint ACK',async t=>{
  clock(t);const ack=deferred(),saved=[],requests=[];
  const driver={storage:{get:async()=>({revision:1n}),set:async(key,value)=>{saved.push([key,value]);await ack.promise;}},client:{talk:{sync:options=>{
    requests.push(options);
    return new Promise((resolve,reject)=>{
      const deadline=setTimeout(()=>reject(new DOMException('private timeout details','TimeoutError')),options.timeout);
      setTimeout(()=>{clearTimeout(deadline);resolve(empty);},20000);
    });
  }}}};
  const {monitor,states}=fixture(t,driver);
  t.mock.timers.tick(1000);await flush();assert.equal(requests[0].timeout,180000);
  assert.equal(Date.parse(states.at(-1).pollDeadlineAt)-Date.parse(states.at(-1).lastAttemptAt),TALK_POLL_TIMEOUT_MS);
  t.mock.timers.tick(10004);await flush();assert.equal(states.at(-1).status,'polling');assert.equal(states.at(-1).lastSuccessAt,null);
  t.mock.timers.tick(9996);await flush();assert.equal(saved.length,1);assert.equal(states.at(-1).lastSuccessAt,null);
  ack.resolve();await flush();assert.equal(states.at(-1).status,'running');assert.equal(states.at(-1).lastSuccessAt,new Date().toISOString());
  assert.equal(states.at(-1).pollDeadlineAt,null);monitor.stop();
});

test('a real timeout is visible through the next pending retry; durable recovery clears the error and resets backoff',async t=>{
  clock(t);const recovery=deferred();let polls=0;
  const driver={storage:{get:async()=>({revision:1}),set:async()=>{}},client:{talk:{sync:options=>{
    polls++;
    if(polls===1)return empty;
    if(polls===2)return new Promise((_resolve,reject)=>setTimeout(()=>reject(new DOMException('secret headers and chat body','TimeoutError')),options.timeout));
    if(polls===3)return recovery.promise;
    throw Object.assign(new Error('private DNS hostname'),{cause:{code:'ENOTFOUND'}});
  }}}};
  const {monitor,states}=fixture(t,driver);
  t.mock.timers.tick(1000);await flush();const success=states.at(-1).lastSuccessAt;
  t.mock.timers.tick(500);await flush();t.mock.timers.tick(180000);await flush();
  const failure=states.at(-1);assert.equal(failure.status,'retrying');assert.equal(failure.lastSuccessAt,success);
  assert.deepEqual(failure.lastFailure,{at:new Date().toISOString(),kind:'timeout',stage:'poll',errorName:'TimeoutError',elapsedMs:180000,pollTimeoutMs:180000,retryInMs:2000});
  t.mock.timers.tick(2000);await flush();assert.equal(polls,3);assert.equal(states.at(-1).status,'polling');assert.equal(states.at(-1).error,'monitor_poll_failed');
  assert.deepEqual(states.at(-1).lastFailure,failure.lastFailure);
  recovery.resolve(empty);await flush();assert.equal(states.at(-1).status,'running');assert.equal(states.at(-1).error,undefined);
  assert.equal(states.at(-1).lastSuccessAt,new Date().toISOString());assert.deepEqual(states.at(-1).lastFailure,failure.lastFailure);
  t.mock.timers.tick(500);await flush();assert.equal(states.at(-1).lastFailure.retryInMs,2000);assert.equal(states.at(-1).lastFailure.kind,'network');
  assert.ok(!JSON.stringify(states).includes('secret headers'));monitor.stop();
});

test('failed Talk checkpoint retries the durable cursor rather than skipping the unacknowledged revision',async t=>{
  clock(t);const requests=[];let writes=0;
  const driver={storage:{get:async()=>({revision:1n}),set:async()=>{if(++writes===1)throw new Error('secret vault path');}},client:{talk:{sync:async options=>{
    requests.push(options.revision);return {operationResponse:{operations:[{revision:2n,type:0}]}};
  }}}};
  const {monitor,states}=fixture(t,driver);t.mock.timers.tick(1000);await flush();
  assert.equal(states.at(-1).lastSuccessAt,null);assert.equal(states.at(-1).lastFailure.kind,'storage');
  t.mock.timers.tick(2000);await flush();assert.deepEqual(requests,[1n,1n]);assert.ok(states.at(-1).lastSuccessAt);monitor.stop();
});

test('OpenChat checkpoint failures retain baseline and cursor, discard history, and require durable readiness',async t=>{
  clock(t);const requests=[],captured=[];let polls=0,writes=0;
  const history={payload:{receiveMessage:{squareMessage:{message:{id:'old',text:'private history'}}}}};
  const driver={storage:{get:async()=>undefined,set:async()=>{if(++writes<=2)throw new Error('private checkpoint');}},client:{square:{fetchSquareChatEvents:async options=>{
    requests.push(options.syncToken);return ++polls===1?{events:[],syncToken:'ready-uncommitted'}:{events:[history],syncToken:'baseline'};
  }}}};
  const {monitor,states}=fixture(t,driver,[{id:'room',kind:'openchat'}],(_id,message)=>captured.push(message));
  await flush();assert.equal(states.at(-1).lastSuccessAt,null);assert.equal(states.at(-1).lastFailure.stage,'checkpoint');
  t.mock.timers.tick(2000);await flush();t.mock.timers.tick(4000);await flush();
  assert.deepEqual(requests,[undefined,undefined,undefined]);assert.deepEqual(captured,[]);
  assert.equal(states.at(-1).status,'initializing');assert.equal(states.at(-1).ready,false);assert.ok(states.at(-1).lastSuccessAt);monitor.stop();
});

test('capture failure does not checkpoint or renew success and keeps diagnostics content-free',async t=>{
  clock(t);let writes=0;
  const driver={storage:{get:async()=>({revision:1}),set:async()=>{writes++;}},client:{profile:{mid:'self'},talk:{sync:async()=>({operationResponse:{operations:[{type:26,revision:2,message:{id:'new',from:'friend',to:'chosen',text:'private chat text'}}]}})},e2ee:{decryptE2EEMessage:async raw=>raw}}};
  const {monitor,states}=fixture(t,driver,undefined,()=>{throw new Error('private chat text in capture failure');});
  t.mock.timers.tick(1000);await flush();assert.equal(writes,0);assert.equal(states.at(-1).lastSuccessAt,null);
  assert.equal(states.at(-1).lastFailure.kind,'capture');assert.ok(!JSON.stringify(states).includes('private chat text'));monitor.stop();
});

test('stop cancels a pending poll and an idle/backoff delay without emitting failure or success',async t=>{
  clock(t);let signal;const states=[];
  const driver={storage:{get:async()=>({revision:1})},monitorRequest:(s,operation)=>{signal=s;return operation();},client:{talk:{sync:()=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))}}};
  const monitor=new LiveMonitor(driver,(_event,state)=>states.push(state),()=>{});monitor.update([{id:'chosen',kind:'group'}]);
  t.mock.timers.tick(1000);await flush();monitor.stop();await monitor.talkTask;assert.equal(signal.aborted,true);assert.deepEqual(states.map(s=>s.status),['polling']);
  const idle=new LiveMonitor(driver,()=>assert.fail('Idle stop must not emit'),()=>{});idle.stop();await idle.talkTask;
  const retry=fixture(t,{storage:{get:async()=>({revision:1})},client:{talk:{sync:async()=>{throw new Error('synthetic outage');}}}});
  t.mock.timers.tick(1000);await flush();assert.equal(retry.states.at(-1).status,'retrying');retry.monitor.stop();await retry.monitor.talkTask;
});

test('removing an OpenChat cancels its poll and a late checkpoint cannot overwrite stopped status',async t=>{
  clock(t);const ack=deferred();let signal;
  const driver={storage:{get:async()=>({syncToken:'old',ready:true}),set:()=>ack.promise},monitorRequest:(s,operation)=>{signal=s;return operation();},client:{square:{fetchSquareChatEvents:async()=>({events:[],syncToken:'new'})}}};
  const {monitor,states}=fixture(t,driver,[{id:'room',kind:'openchat'}]);await flush();const room=monitor.rooms.get('room');
  monitor.update([]);assert.equal(signal.aborted,true);assert.equal(states.at(-1).status,'stopped');
  ack.resolve();await room.task;assert.equal(states.at(-1).status,'stopped');assert.ok(states.every(s=>s.lastSuccessAt===null));monitor.stop();
});

test('the installed SDK receives the long deadline and stop aborts actual Talk/OpenChat fetches without disconnecting the driver',async t=>{
  clock(t);const requests=[];
  t.mock.method(globalThis,'fetch',request=>{
    requests.push(request);
    return new Promise((_resolve,reject)=>request.signal.addEventListener('abort',()=>reject(request.signal.reason),{once:true}));
  });
  const driver=new LineDriver({device:'IOSIPAD'},{get:async key=>key==='monitor.talk'?{revision:1}:undefined},{fault:()=>{}});t.after(()=>driver.stop());
  const request=driver.client.request.request.bind(driver.client.request),rpc=[];
  t.mock.method(driver.client.request,'request',(...args)=>{rpc.push(args);return request(...args);});
  const {monitor,states}=fixture(t,driver,[{id:'chosen',kind:'group'},{id:'room',kind:'openchat'}]);
  await flush();t.mock.timers.tick(1000);await flush();assert.equal(requests.length,2);
  const sync=rpc.find(args=>args[1]==='sync');assert.equal(sync[4],'/SYNC4');assert.equal(sync[6],driver.client.config.longTimeout);assert.equal(sync[6],180000);
  const room=monitor.rooms.get('room');monitor.update([{id:'chosen',kind:'group'}]);await room.task;
  assert.equal(requests.find(r=>r.url.endsWith('/SQ1')).signal.aborted,true);assert.equal(requests.find(r=>r.url.endsWith('/SYNC4')).signal.aborted,false);
  monitor.stop();await monitor.talkTask;assert.ok(requests.every(r=>r.signal.aborted));assert.equal(driver.abort.signal.aborted,false);
  assert.ok(states.every(s=>['polling','stopped'].includes(s.status)));assert.ok(states.every(s=>s.lastSuccessAt===null));
});

test('diagnostics allowlist names and codes and drop raw messages, causes, data, and malformed errors',()=>{
  const secret='SYNTHETIC_SECRET_CHAT_TOKEN';
  for(const error of [null,undefined,secret,{name:secret,code:secret,data:{errorCode:secret},cause:{message:secret,code:secret}},Object.assign(new Error(`status=403 headers=${secret} body=${secret}`),{stack:secret})]){
    assert.ok(!JSON.stringify(pollDiagnostic(error,'poll',10,180000,2000)).includes(secret));
  }
  assert.equal(pollDiagnostic({name:'RequestError',data:{code:'NOT_AUTHORIZED_DEVICE',message:secret}},'poll',10,180000,2000).code,'NOT_AUTHORIZED_DEVICE');
  assert.equal(pollDiagnostic({name:'TypeError',cause:{code:'ECONNRESET',stack:secret}},'poll',10,180000,2000).kind,'network');
  assert.equal(pollDiagnostic({name:'AbortError'},'poll',10,180000,2000).kind,'cancelled');
});

test('60-second freshness, pending deadlines, sticky failure, and EVERY stream remain independent',t=>{
  clock(t);const store=new Store(':memory:');t.after(()=>store.close());const account=store.addAccount('Synthetic receiver','line','IOSIPAD');
  for(const chat of [{id:'chosen',kind:'group'},{id:'room',kind:'openchat'}]){store.putChat(account.id,{...chat,name:chat.id});store.designate(account.id,chat.id,true);}store.setSetting(`monitor:${account.id}`,true);
  const success=new Date().toISOString(),streams={talk:{status:'polling',ready:true,lastAttemptAt:success,lastSuccessAt:success,pollTimeoutMs:180000,pollDeadlineAt:new Date(Date.now()+180000).toISOString()},room:{status:'running',ready:true,lastSuccessAt:success}};
  t.mock.timers.tick(60000);assert.equal(monitorStatus(store,account.id,streams).health,'healthy');
  t.mock.timers.tick(1);streams.room.lastSuccessAt=new Date().toISOString();let health=monitorStatus(store,account.id,streams);
  assert.equal(health.health,'stale');assert.equal(health.streams.talk.health,'stale');assert.equal(health.streams.room.health,'healthy');assert.equal(streams.talk.lastSuccessAt,success);
  streams.talk.lastSuccessAt=new Date().toISOString();streams.talk.error='monitor_poll_failed';assert.equal(monitorStatus(store,account.id,streams).health,'retrying');
  delete streams.talk.error;streams.talk.pollDeadlineAt=new Date().toISOString();assert.equal(monitorStatus(store,account.id,streams).health,'stale');
  delete streams.talk.pollDeadlineAt;for(const invalid of [null,'not-a-date',new Date(Date.now()+1).toISOString()]){streams.talk.lastSuccessAt=invalid;assert.equal(monitorStatus(store,account.id,streams).health,'waiting');}
});
