import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {Store} from '../server/store.mjs';
import {Vault,VaultStorage} from '../server/vault.mjs';
import {ProtocolWorker} from '../server/worker.mjs';
import {capture} from '../server/inbox.mjs';
import {SendRejectedError} from '../server/errors.mjs';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';

test('private worker RPC returns bounded sanitized errors and stops cleanly',async t=>{
  const store=new Store(':memory:'),worker=new ProtocolWorker(store,new Vault(randomBytes(32),'test'),()=>{});t.after(()=>{worker.close();store.close();});
  await assert.rejects(worker.call('disconnect',{accountId:'missing'}),{code:'account_disconnected'});assert.equal(worker.pending.size,0);assert.ok(worker.child);
  await assert.rejects(worker.call('check',{accountId:'missing'}),error=>{
    assert.equal(error.code,'health_check_failed');assert.equal(error.status,502);assert.deepEqual(error.accountDiagnostic,{kind:'unknown',errorName:'Error'});return true;
  });assert.equal(worker.pending.size,0);
  worker.close();assert.equal(worker.child,null);
});
test('storage and incoming-message acknowledgements follow durable encrypted writes',async t=>{
  const store=new Store(':memory:'),vault=new Vault(randomBytes(32),'test'),a=store.addAccount('worker','demo','IOSIPAD');t.after(()=>store.close());
  const worker=new ProtocolWorker(store,vault,(id,chat,message)=>capture(store,vault,id,chat,message)),acks=[];worker.write=value=>acks.push(value);
  worker.handle({type:'storage',id:'s1',accountId:a.id,operation:'set',key:'monitor.talk',value:{revision:9007199254740995n}});
  assert.equal(acks.at(-1).ok,true);assert.equal((await new VaultStorage(store,vault,a.id).get('monitor.talk')).revision,9007199254740995n);
  worker.handle({type:'storage',id:'s2',accountId:'missing',operation:'set',key:'secret',value:'private'});assert.equal(acks.at(-1).ok,false);
  store.putChat(a.id,{id:'chat',name:'room',kind:'group'});store.designate(a.id,'chat',true);store.setSetting(`monitor:${a.id}`,true);
  worker.handle({type:'capture',id:'c1',accountId:a.id,chatId:'chat',message:{id:'m1',text:'private'}});assert.equal(acks.at(-1).ok,true);assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,1);
  worker.handle({type:'capture',id:'c2',accountId:a.id,chatId:'chat',message:{}});assert.equal(acks.at(-1).ok,false);
  const prepare=store.db.prepare.bind(store.db);store.db.prepare=sql=>{if(sql.startsWith('INSERT OR REPLACE INTO message_search'))throw new Error('synthetic index failure');return prepare(sql);};
  worker.handle({type:'capture',id:'c3',accountId:a.id,chatId:'chat',message:{id:'m2',text:'retry'}});assert.equal(acks.at(-1).ok,false);assert.equal(prepare('SELECT COUNT(*) n FROM messages').get().n,1);
  store.db.prepare=prepare;worker.handle({type:'capture',id:'c4',accountId:a.id,chatId:'chat',message:{id:'m2',text:'retry'}});assert.equal(acks.at(-1).ok,true);assert.equal(prepare('SELECT COUNT(*) n FROM messages').get().n,2);
});
test('worker preserves preparation-rejected sends and rejects pending jobs when closing',async()=>{
  const worker=new ProtocolWorker(null,null,null);let error;worker.pending.set('send',{timer:setTimeout(()=>{},5000),reject:e=>{error=e;}});
  worker.handle({type:'result',id:'send',error:{status:502,code:'send_preparation_failed',message:'No message was sent.',rejected_send:true}});assert.ok(error instanceof SendRejectedError);
  worker.pending.set('read',{timer:setTimeout(()=>{},5000),reject:e=>{error=e;}});worker.close();assert.equal(error.code,'upstream_unavailable');assert.equal(worker.pending.size,0);
});

test('real private pipe waits for parent dispatch authorization and rejects late or revoked sends',async t=>{
  // Exercise the actual protocol loop with an in-child synthetic adapter. No
  // auth token, keys, live account, network or persistent storage is provided.
  const source=`import {LineDriver} from './server/drivers.mjs';
    let dispatches=0;
    LineDriver.prototype.login=async()=>({mid:'synthetic'});
    LineDriver.prototype.send=async function(chat,text,options,beforeDispatch){await new Promise(r=>setTimeout(r,30));await beforeDispatch();dispatches++;return {messageId:'synthetic'};};
    LineDriver.prototype.read=async()=>({dispatches});
    await import('./protocol/worker.mjs');`;
  const worker=new ProtocolWorker(null,null,null),child=spawn(process.execPath,['--input-type=module','-e',source],{windowsHide:true,stdio:['pipe','pipe','ignore']});worker.child=child;
  const input=createInterface({input:child.stdout});input.on('line',line=>worker.handle(JSON.parse(line)));
  t.after(()=>{input.close();worker.close();});
  await worker.call('connect',{accountId:'synthetic',account:{device:'IOSIPAD'},storage:{}});
  const params={accountId:'synthetic',chat:{id:'synthetic',kind:'direct'},text:'synthetic',options:{acknowledgeOaTransport:true}};
  let checks=0;assert.equal((await worker.call('send',params,1000,undefined,()=>{checks++;})).messageId,'synthetic');assert.equal(checks,1);
  await assert.rejects(worker.call('send',params,1000,undefined,()=>{throw new Error('revoked');}),{code:'send_authorization_revoked'});
  await assert.rejects(worker.call('send',params,5,undefined,()=>assert.fail('Expired call must not authorize')),{code:'upstream_unavailable'});
  await new Promise(r=>setTimeout(r,70));assert.equal((await worker.call('read',{accountId:'synthetic'})).dispatches,1);
});

test('private worker serializes monitor replacement through durable ACKs without blocking login cancellation',async t=>{
  const source=`import {LineDriver} from './server/drivers.mjs';
    import {LiveMonitor} from './protocol/monitor.mjs';
    const active=new Set();let peak=0,starts=0;
    LineDriver.prototype.login=async function(){
      if(this.account.pending){this.events.qr('synthetic_waiting');await new Promise(resolve=>this.abort.signal.addEventListener('abort',resolve,{once:true}));throw new Error('synthetic_cancelled');}
      return {mid:'synthetic'};
    };
    LineDriver.prototype.read=async()=>({active:active.size,peak,starts});
    LiveMonitor.prototype.update=function(){if(!active.has(this)){active.add(this);starts++;peak=Math.max(peak,active.size);}};
    const done=LiveMonitor.prototype.done;
    LiveMonitor.prototype.done=async function(){
      await this.driver.storage.set('synthetic.lifecycle',starts);
      await done.call(this);await new Promise(resolve=>setTimeout(resolve,20));active.delete(this);
    };
    await import('./protocol/worker.mjs');`;
  const worker=new ProtocolWorker(null,null,null),child=spawn(process.execPath,['--input-type=module','-e',source],{windowsHide:true,stdio:['pipe','pipe','ignore']});worker.child=child;
  let acks=0;
  const input=createInterface({input:child.stdout});input.on('line',line=>{
    const message=JSON.parse(line);
    if(message.type==='storage'){acks++;setTimeout(()=>worker.write({type:'storage_ack',id:message.id,ok:true}),10);}
    else worker.handle(message);
  });
  t.after(()=>{input.close();worker.close();});
  const accountId='synthetic',connect={accountId,account:{device:'IOSIPAD'},storage:{}};
  const call=(method,params={})=>worker.call(method,{accountId,...params},3000);
  await worker.call('connect',connect);await call('monitor_start');
  await Promise.all([call('monitor_start'),call('monitor_start'),call('monitor_update'),call('monitor_interval',{refreshIntervalMs:15000})]);
  assert.deepEqual(await call('read'),{active:1,peak:1,starts:3});
  await Promise.all([worker.call('connect',connect),call('monitor_start')]);
  assert.deepEqual(await call('read'),{active:1,peak:1,starts:4});
  await Promise.all([call('monitor_stop'),call('monitor_start'),call('monitor_stop')]);
  assert.deepEqual(await call('read'),{active:0,peak:1,starts:5});assert.equal(acks,5);
  let ready;const waiting=new Promise(resolve=>{ready=resolve;});worker.events.set(accountId,{qr:ready});
  const pending=worker.call('connect',{...connect,account:{device:'IOSIPAD',pending:true}},3000);
  const cancelled=assert.rejects(pending);
  await waiting;await call('disconnect');await cancelled;
});

for(const heldType of ['capture_ack','storage_ack'])test(`graceful worker drain waits for durable ${heldType} and rejects new work`,async t=>{
  const store=new Store(':memory:'),vault=new Vault(randomBytes(32),'synthetic'),a=store.addAccount('drain','line','IOSIPAD');
  store.putChat(a.id,{id:'synthetic-chat',name:'synthetic',kind:'group'});store.designate(a.id,'synthetic-chat',true);store.setSetting(`monitor:${a.id}`,true);
  const storage=new VaultStorage(store,vault,a.id);await storage.set('monitor.talk',{revision:1});
  const source=`import {LineDriver} from './server/drivers.mjs';
    LineDriver.prototype.login=async function(){this.ready=true;this.client.profile={mid:'synthetic-owner'};
      this.client.talk.sync=async()=>({operationResponse:{operations:[{type:26,revision:2,message:{id:'synthetic-message',to:'synthetic-chat',from:'synthetic-sender',text:'synthetic text'}}]}});return this.client.profile;};
    LineDriver.prototype.decryptMessage=async value=>value;
    LineDriver.prototype.resolveMessageNames=async(chat,messages)=>messages;
    await import('./protocol/worker.mjs');`;
  const worker=new ProtocolWorker(store,vault,(id,chat,message)=>capture(store,vault,id,chat,message));
  const child=spawn(process.execPath,['--input-type=module','-e',source],{windowsHide:true,stdio:['pipe','pipe','ignore']});worker.child=child;
  const input=createInterface({input:child.stdout});input.on('line',line=>worker.handle(JSON.parse(line)));
  t.after(()=>{input.close();worker.close();store.close();});
  let release,seen;const waiting=new Promise(r=>{seen=r;}),write=worker.write.bind(worker);
  worker.write=value=>{if(value.type===heldType&&!release){release=()=>write(value);seen();}else write(value);};
  await worker.call('connect',{accountId:a.id,account:{device:'IOSIPAD'},storage:storage.getAll()});
  await worker.call('monitor_start',{accountId:a.id,chats:[{id:'synthetic-chat',kind:'group'}]});
  await waiting;
  let stopped=false;const drained=worker.drain().then(()=>{stopped=true;});
  await new Promise(r=>setTimeout(r,60));assert.equal(stopped,false,'The process must retain its ACK pipe and store until the outstanding commit is acknowledged');
  await assert.rejects(worker.call('read',{accountId:a.id}),{code:'service_stopping'});
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM messages').get().n,1);
  release();await drained;assert.equal(child.exitCode,0);assert.equal(worker.child,null);
  assert.equal((await storage.get('monitor.talk')).revision,heldType==='capture_ack'?1:2,'A stopped capture cannot advance a cursor; an already committed checkpoint is retained');
  await worker.drain();assert.equal(worker.pending.size,0);
});

test('graceful worker drain waits for an accepted synthetic send outcome and does not kill its child',async t=>{
  const source=`import {LineDriver} from './server/drivers.mjs';
    LineDriver.prototype.login=async function(){this.ready=true;return {mid:'synthetic'};};
    LineDriver.prototype.send=async function(chat,text,options,beforeDispatch){await beforeDispatch();await new Promise(r=>setTimeout(r,100));return {messageId:'synthetic-accepted'};};
    await import('./protocol/worker.mjs');`;
  const worker=new ProtocolWorker(null,null,null),child=spawn(process.execPath,['--input-type=module','-e',source],{windowsHide:true,stdio:['pipe','pipe','ignore']});worker.child=child;
  const input=createInterface({input:child.stdout});input.on('line',line=>worker.handle(JSON.parse(line)));t.after(()=>{input.close();worker.close();});
  await worker.call('connect',{accountId:'synthetic',account:{device:'IOSIPAD'},storage:{}});
  let accepted;const dispatched=new Promise(r=>{accepted=r;});
  const send=worker.call('send',{accountId:'synthetic',chat:{id:'synthetic'},text:'synthetic'},1000,undefined,accepted);
  await dispatched;const draining=worker.drain();
  assert.equal((await send).messageId,'synthetic-accepted');await draining;assert.equal(child.exitCode,0);assert.equal(child.signalCode,null);
});
