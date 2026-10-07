import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomMonitor as LiveMonitor} from './room-monitor-fixture.mjs';


const flush=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const diagnosticFields=new Set(['page','eventCount','eventsTruncated','recognizedMessageCount','eventTypeCounts','eventStatusCounts','cursorProvided','cursorChanged','continuationPresent','continuationSent','eventTokenEqualsInputCount','eventTokenEqualsOutputCount','baselineBefore','checkpointSucceeded','elapsedMs','baselineAfter']);
function fixture(t,driver,options={}){
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.parse('2026-10-05T00:00:00Z')});
  const states=[],captured=[],monitor=new LiveMonitor(driver,(_event,state)=>states.push(state),async(_id,message)=>captured.push(message),{refreshIntervalMs:500,...options});
  monitor.update([{id:'room',kind:'openchat'}]);const room=monitor.rooms.get('room');
  t.after(async()=>{monitor.stop();await Promise.all([monitor.talkTask,room.task]);});
  return {monitor,room,states,captured};
}

test('OpenChat pagination diagnostics are absent by default',async t=>{
  const driver={storage:{get:async()=>undefined,set:async()=>{}},client:{square:{fetchSquareChatEvents:async()=>({events:[],syncToken:'synthetic-cursor'})}}};
  const {monitor,states}=fixture(t,driver);await flush();
  assert.equal(states.at(-1).status,'running');assert.ok(states.at(-1).lastSuccessAt);
  assert.ok(states.every(state=>!Object.hasOwn(state,'pagination')));monitor.stop();
});

test('opt-in pagination diagnostics count a baseline page without exposing content or claiming its pending ACK',async t=>{
  const secret='SYNTHETIC_SECRET_NEVER_EXPOSE',input=`${secret}_input`,output=`${secret}_output`,ack=deferred(),saved=[];
  const events=[
    {type:'RECEIVE_MESSAGE',eventStatus:'NORMAL',syncToken:input,payload:{receiveMessage:{senderDisplayName:secret,squareMessage:{message:{id:secret,from:secret,text:secret}}}}},
    {type:6,eventStatus:2,syncToken:output,payload:{notifiedMarkAsRead:{private:secret}}},
    {type:secret,eventStatus:secret,syncToken:`${secret}_other`,payload:{private:secret}}
  ];
  const driver={storage:{get:async()=>({syncToken:input,ready:false}),set:async(key,value)=>{saved.push([key,value]);await ack.promise;}},client:{square:{fetchSquareChatEvents:async()=>({events,syncToken:output,continuationToken:`${secret}_continuation`})}}};
  t.after(()=>ack.resolve());const {monitor,states,captured}=fixture(t,driver,{diagnostics:true});await flush();
  assert.equal(saved.length,1);assert.equal(states.at(-1).lastSuccessAt,null);assert.equal(states.at(-1).ready,false);
  const pending=states.at(-1).pagination;assert.ok(pending);assert.equal(Object.getPrototypeOf(pending),Object.prototype);
  assert.ok(Object.keys(pending).every(key=>diagnosticFields.has(key)));
  assert.equal(pending.page,1);assert.equal(pending.eventCount,3);assert.equal(pending.recognizedMessageCount,1);
  assert.equal(pending.cursorProvided,true);assert.equal(pending.cursorChanged,true);
  assert.equal(pending.continuationPresent,true);assert.equal(pending.continuationSent,false);
  assert.equal(pending.eventTokenEqualsInputCount,1);assert.equal(pending.eventTokenEqualsOutputCount,1);
  assert.equal(pending.baselineBefore,true);assert.equal(pending.checkpointSucceeded,false);assert.ok(pending.elapsedMs>=0);
  assert.equal(Object.values(pending.eventTypeCounts).reduce((sum,count)=>sum+count,0),3);
  assert.equal(Object.values(pending.eventStatusCounts).reduce((sum,count)=>sum+count,0),3);
  assert.ok(!JSON.stringify(states).includes(secret));assert.deepEqual(captured,[]);
  ack.resolve();await flush();const committed=states.at(-1);
  assert.equal(committed.pagination.checkpointSucceeded,true);assert.equal(committed.pagination.baselineAfter,true);
  assert.equal(committed.status,'initializing');assert.equal(committed.ready,false);assert.ok(committed.lastSuccessAt);
  assert.equal(pending.checkpointSucceeded,false,'later ACK must not mutate previously emitted diagnostic evidence');
  assert.deepEqual(saved[0][1],{syncToken:output,ready:false});assert.deepEqual(captured,[]);
  assert.ok(!JSON.stringify(states).includes(secret));monitor.stop();
});

test('failed OpenChat checkpoint retains content-free pagination evidence but never acknowledges the page',async t=>{
  const secret='SYNTHETIC_SECRET_CHECKPOINT';
  const driver={storage:{get:async()=>({syncToken:`${secret}_old`,ready:false}),set:async()=>{throw Object.assign(new Error(secret),{code:secret});}},client:{square:{fetchSquareChatEvents:async()=>({events:[],syncToken:`${secret}_new`})}}};
  const {monitor,states,captured}=fixture(t,driver,{diagnostics:true});await flush();
  const failed=states.at(-1);assert.equal(failed.status,'retrying');assert.equal(failed.lastFailure.stage,'checkpoint');assert.equal(failed.lastFailure.kind,'storage');
  assert.equal(failed.pagination.checkpointSucceeded,false);assert.equal(failed.lastSuccessAt,null);assert.equal(failed.ready,false);
  assert.ok(states.every(state=>state.pagination?.checkpointSucceeded!==true));assert.deepEqual(captured,[]);
  assert.ok(!JSON.stringify(states).includes(secret));monitor.stop();
});

test('diagnostic mode leaves repeated nonempty control pages initializing and observes actual continuation use',async t=>{
  const requests=[],saved=[];let page=0;
  const driver={storage:{get:async()=>undefined,set:async(key,value)=>saved.push([key,value])},client:{square:{fetchSquareChatEvents:async options=>{
    requests.push(options);return {events:[{type:'NOTIFIED_MARK_AS_READ',eventStatus:'NORMAL',syncToken:`synthetic-${page}`}],syncToken:`synthetic-${++page}`,continuationToken:'synthetic-continuation'};
  }}}};
  const {monitor,states,captured}=fixture(t,driver,{diagnostics:true});await flush();
  assert.equal(requests.length,1);assert.equal(states.at(-1).pagination.cursorProvided,false);
  for(let expected=2;expected<=3;expected++){
    t.mock.timers.tick(500);await flush();const current=states.at(-1);
    assert.equal(requests.length,expected);assert.equal(current.pagination.page,expected);
    assert.equal(current.pagination.eventCount,1);assert.equal(current.pagination.recognizedMessageCount,0);
    assert.equal(current.pagination.continuationPresent,true);assert.equal(current.pagination.continuationSent,false);
    assert.equal(current.pagination.checkpointSucceeded,true);assert.equal(current.pagination.baselineBefore,true);assert.equal(current.pagination.baselineAfter,true);
    assert.equal(current.status,'initializing');assert.equal(current.ready,false);assert.ok(current.lastSuccessAt);
  }
  assert.ok(requests.every(request=>!request.continuationToken));assert.ok(saved.every(([,value])=>value.ready===false));
  assert.deepEqual(captured,[]);monitor.stop();
});

test('removal while diagnostic checkpoint is pending cannot report a late ACK as stream success',async t=>{
  const ack=deferred();
  const driver={storage:{get:async()=>({syncToken:'synthetic-old',ready:false}),set:()=>ack.promise},client:{square:{fetchSquareChatEvents:async()=>({events:[],syncToken:'synthetic-new'})}}};
  t.after(()=>ack.resolve());const {monitor,room,states}=fixture(t,driver,{diagnostics:true});await flush();
  assert.equal(states.at(-1).pagination.checkpointSucceeded,false);
  monitor.update([]);assert.equal(states.at(-1).status,'stopped');const stoppedCount=states.length;
  ack.resolve();await room.task;assert.equal(states.length,stoppedCount);assert.equal(states.at(-1).status,'stopped');
  assert.ok(states.every(state=>state.lastSuccessAt===null));assert.ok(states.every(state=>state.pagination?.checkpointSucceeded!==true));monitor.stop();
});
