import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {randomBytes} from 'node:crypto';
import {ProtocolWorker} from '../server/worker.mjs';
import {Hub,adminActor} from '../server/hub.mjs';
import {Store} from '../server/store.mjs';
import {Vault} from '../server/vault.mjs';
import {startWithChild} from './worker-test-utils.mjs';
const flush=()=>new Promise(resolve=>setImmediate(resolve));

function childFixture(t,worker){
  // Deterministically model the documented ordering: exit may precede final
  // stdout data. Real Node streams feed the production readline handler.
  const child=new EventEmitter(),writes=[];let kills=0,spawns=0;
  child.exitCode=child.signalCode=null;
  child.stdout=new PassThrough();
  child.stdin=new Writable({write(bytes,_encoding,done){writes.push(JSON.parse(String(bytes)));done();}});
  child.kill=()=>{kills++;return true;};
  startWithChild(t,worker,()=>{spawns++;return child;});
  t.after(()=>{worker.close();child.stdout.destroy();child.stdin.destroy();});
  return {child,writes,get kills(){return kills;},get spawns(){return spawns;},
    output:value=>child.stdout.write(JSON.stringify(value)+'\n'),
    exit(code=0,signal=null){child.exitCode=code;child.signalCode=signal;child.emit('exit',code,signal);},
    async close(code=child.exitCode,signal=child.signalCode){const ended=once(child.stdout,'end');child.stdout.end();await ended;child.emit('close',code,signal);await flush();}
  };
}
async function ledgerFixture(t,timeout=1000){
  const store=new Store(':memory:'),hub=new Hub(store,new Vault(randomBytes(32),'synthetic'));
  t.after(()=>{hub.close();store.close();});
  const account=await hub.addAccount({label:'Synthetic lifecycle',kind:'demo'}),worker=hub.worker;
  const f=childFixture(t,worker);let sends=0;
  hub.driver(account.id).send=(chat,text,_options,beforeDispatch)=>{sends++;return worker.call('send',{chat,text},timeout,undefined,beforeDispatch);};
  return {...f,fixture:f,hub,store,worker,account,get sends(){return sends;}};
}

test('production start retains an accepted send result delivered after exit and waits for stdout closure',async t=>{
  const f=await ledgerFixture(t),key='late-stdout-send';
  const sent=f.hub.send(adminActor,f.account.id,'demo-group','synthetic',key);void sent.catch(()=>{});await flush();
  const request=f.writes.find(value=>value.method==='send');assert.ok(request);
  f.output({type:'authorize_send',id:request.id});assert.equal(f.writes.at(-1).ok,true);
  let stopped=false;const draining=f.hub.drain().then(()=>{stopped=true;});void draining.catch(()=>{});
  f.exit(0);await flush();
  assert.equal(f.worker.pending.size,1,'exit is not the end of the result pipe');assert.equal(f.worker.child,f.child);
  assert.equal(f.store.send(adminActor.id,key).state,'pending');
  f.output({type:'result',id:request.id,result:{messageId:'synthetic-accepted',delivery:'sandbox_only'}});
  f.output({type:'shutdown_complete'});assert.equal((await sent).messageId,'synthetic-accepted');
  assert.equal(f.store.send(adminActor.id,key).state,'sent');assert.equal(stopped,false);
  await f.close();await draining;assert.equal(f.worker.pending.size,0);assert.equal(f.worker.child,null);assert.equal(f.sends,1);assert.equal(f.fixture.kills,0);
});
test('production start blocks new RPCs after exit while still accepting the final result',async t=>{
  const worker=new ProtocolWorker(null,null,null),f=childFixture(t,worker);
  const result=worker.call('send',{},1000),id=f.writes[0].id;void result.catch(()=>{});
  f.exit(0);
  await assert.rejects(worker.call('read',{},1000),{code:'upstream_unavailable'});
  assert.equal(f.writes.length,1);assert.equal(f.spawns,1);
  f.output({type:'result',id,result:{messageId:'synthetic-tail'}});assert.equal((await result).messageId,'synthetic-tail');await f.close();
});
test('production drain started after exit preserves a late result but fails without shutdown_complete',async t=>{
  const worker=new ProtocolWorker(null,null,null),f=childFixture(t,worker);
  const result=worker.call('send',{},1000),id=f.writes[0].id;void result.catch(()=>{});
  f.exit(0);
  const failed=assert.rejects(worker.drain(),{code:'worker_drain_failed'});
  assert.equal(f.writes.length,1,'No writes or replacement child after exit');
  f.output({type:'result',id,result:{messageId:'synthetic-accepted'}});
  assert.equal((await result).messageId,'synthetic-accepted');await f.close();await failed;assert.equal(f.kills,0);
});
test('production start waits for close after a spawn error and fails the drain',async t=>{
  const worker=new ProtocolWorker(null,null,null),f=childFixture(t,worker);
  const failed=assert.rejects(worker.call('read',{},1000),{code:'upstream_unavailable'});
  f.child.emit('error',Object.assign(new Error('synthetic spawn failure'),{code:'ENOENT'}));
  assert.equal(worker.pending.size,1);assert.equal(worker.child,f.child);
  await assert.rejects(worker.call('read'),{code:'upstream_unavailable'});
  const drain=assert.rejects(worker.drain(),{code:'worker_drain_failed'});
  await f.close(-2);await failed;await drain;assert.equal(f.spawns,1);assert.equal(f.writes.length,1);
});
test('production close rejects an unresolved abrupt send as unknown without retrying',async t=>{
  const f=await ledgerFixture(t),key='abrupt-stdout-send';
  const failedSend=assert.rejects(f.hub.send(adminActor,f.account.id,'demo-group','synthetic',key),{code:'delivery_unknown'});await flush();
  f.output({type:'authorize_send',id:f.writes.find(value=>value.method==='send').id});assert.equal(f.writes.at(-1).ok,true);
  const failedDrain=assert.rejects(f.worker.drain(),{code:'worker_drain_failed'});
  f.exit(2);await flush();assert.equal(f.worker.pending.size,1);
  await f.close();await failedSend;await failedDrain;
  assert.equal(f.store.send(adminActor.id,key).state,'unknown');
  await assert.rejects(f.hub.send(adminActor,f.account.id,'demo-group','synthetic',key),{code:'delivery_unknown'});
  assert.equal(f.sends,1);assert.equal(f.fixture.spawns,1);assert.equal(f.fixture.kills,0);
});
test('shutdown_complete cannot hide an unresolved RPC at stdout closure',async t=>{
  const worker=new ProtocolWorker(null,null,null),f=childFixture(t,worker);
  const failed=assert.rejects(worker.call('send',{},1000),{code:'upstream_unavailable'});
  const drain=assert.rejects(worker.drain(),{code:'worker_drain_failed'});
  f.exit(0);f.output({type:'shutdown_complete'});await f.close();await failed;await drain;
});
test('an RPC deadline during drain stays bounded and a late result cannot overwrite unknown delivery',async t=>{
  const f=await ledgerFixture(t,30),key='timed-out-stdout-send',started=Date.now();
  const failed=assert.rejects(f.hub.send(adminActor,f.account.id,'demo-group','synthetic',key),{code:'delivery_unknown'});await flush();
  const id=f.writes.find(value=>value.method==='send').id;f.output({type:'authorize_send',id});assert.equal(f.writes.at(-1).ok,true);
  const drain=assert.rejects(f.worker.drain(),{code:'worker_drain_failed'});
  f.exit(0);await failed;assert.ok(Date.now()-started<1000);assert.equal(f.store.send(adminActor.id,key).state,'unknown');
  f.output({type:'result',id,result:{messageId:'too-late'}});f.output({type:'shutdown_complete'});await f.close();await drain;
  assert.equal(f.store.send(adminActor.id,key).state,'unknown');
  await assert.rejects(f.hub.send(adminActor,f.account.id,'demo-group','synthetic',key),{code:'delivery_unknown'});assert.equal(f.sends,1);
});
