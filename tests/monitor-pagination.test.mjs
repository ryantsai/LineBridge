import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomMonitor as LiveMonitor} from './room-monitor-fixture.mjs';
import {SQUARE_BASELINE_PAGE_DELAY_MS,SQUARE_BASELINE_MAX_PAGES,SQUARE_BASELINE_BURST_MS} from '../protocol/monitor.mjs';

const INTERVAL=60000;
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const control={type:6,eventStatus:1,payload:{}};
const message=id=>({type:0,eventStatus:1,payload:{receiveMessage:{squareMessage:{message:{id,text:`synthetic ${id}`}}}}});
function fixture(t,driver,{mockClock=true,...options}={}){
  if(mockClock)t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.parse('2026-10-05T00:00:00Z')});
  const states=[],captured=[],monitor=new LiveMonitor(driver,(_event,state)=>states.push(state),async(_id,value)=>captured.push(value),{refreshIntervalMs:INTERVAL,diagnostics:true,...options});
  monitor.update([{id:'room',kind:'openchat'}]);const room=monitor.rooms.get('room');
  t.after(async()=>{monitor.stop();await Promise.all([monitor.talkTask,room.task]);});
  return {monitor,room,states,captured};
}

test('advancing busy baseline pages drain quickly without archiving history, then live polling keeps its interval',async t=>{
  const requests=[],saved=[],resolved=[];
  const pages=[
    {events:Array(100).fill(control),syncToken:'control-page',continuationToken:'synthetic-next'},
    {events:[message('historical')],syncToken:'history-page'},
    {events:[],syncToken:'baseline-complete'},
    {events:[message('live')],syncToken:'live-page'}
  ];
  const driver={storage:{get:async()=>undefined,set:async(key,value)=>saved.push([key,value])},client:{square:{fetchSquareChatEvents:async options=>{requests.push(options);return pages[requests.length-1];}}},resolveMessageNames:async(_chat,messages)=>{resolved.push(...messages.map(value=>value.id));return messages;}};
  const {monitor,states,captured}=fixture(t,driver);await flush();
  assert.equal(requests.length,1);assert.equal(states.at(-1).ready,false);assert.deepEqual(captured,[]);
  t.mock.timers.tick(SQUARE_BASELINE_PAGE_DELAY_MS-1);await flush();assert.equal(requests.length,1);
  t.mock.timers.tick(1);await flush();assert.equal(requests.length,2);assert.equal(states.at(-1).ready,false);assert.deepEqual(captured,[]);
  t.mock.timers.tick(SQUARE_BASELINE_PAGE_DELAY_MS);await flush();assert.equal(requests.length,3);assert.equal(states.at(-1).ready,true);
  assert.deepEqual(saved.map(([,value])=>value),[{syncToken:'control-page',ready:false},{syncToken:'history-page',ready:false},{syncToken:'baseline-complete',ready:true}]);
  assert.deepEqual(requests.map(request=>request.syncToken),[undefined,'control-page','history-page']);
  assert.ok(requests.every(request=>!Object.hasOwn(request,'continuationToken')));assert.deepEqual(resolved,[]);assert.deepEqual(captured,[]);
  t.mock.timers.tick(INTERVAL-1);await flush();assert.equal(requests.length,3);
  t.mock.timers.tick(1);await flush();assert.equal(requests.length,4);assert.deepEqual(resolved,['live']);assert.deepEqual(captured.map(value=>value.id),['live']);monitor.stop();
});

test('an empty tail with sticky opaque continuation finishes baseline only after ACK and then uses normal live cadence',async t=>{
  const ack=deferred(),requests=[],saved=[];let writes=0,durable;t.after(()=>ack.resolve());
  const driver={storage:{get:async()=>undefined,set:async(_key,value)=>{saved.push(value);if(++writes===1)await ack.promise;durable={...value};}},client:{square:{fetchSquareChatEvents:async options=>{
    requests.push(options);return requests.length===1?{events:[],syncToken:'empty-tail',continuationToken:'synthetic-sticky-token'}:{events:[message('new-after-empty-tail')],syncToken:'live-after-tail',continuationToken:'synthetic-sticky-token'};
  }}}};
  const {monitor,states,captured}=fixture(t,driver);await flush();
  assert.equal(states.at(-1).ready,false);assert.equal(states.at(-1).lastSuccessAt,null);assert.equal(states.at(-1).pagination.checkpointSucceeded,false);assert.equal(durable,undefined);
  assert.deepEqual(saved,[{syncToken:'empty-tail',ready:true}]);t.mock.timers.tick(SQUARE_BASELINE_PAGE_DELAY_MS);await flush();assert.equal(requests.length,1);
  ack.resolve();await flush();assert.equal(states.at(-1).status,'running');assert.equal(states.at(-1).ready,true);assert.ok(states.at(-1).lastSuccessAt);
  assert.deepEqual(durable,{syncToken:'empty-tail',ready:true});assert.deepEqual(captured,[]);
  t.mock.timers.tick(INTERVAL-1);await flush();assert.equal(requests.length,1);
  t.mock.timers.tick(1);await flush();assert.equal(requests.length,2);assert.equal(requests[1].syncToken,'empty-tail');assert.ok(requests.every(request=>!Object.hasOwn(request,'continuationToken')));
  assert.deepEqual(captured.map(value=>value.id),['new-after-empty-tail']);monitor.stop();
});

test('baseline page budget yields to the regular interval without inventing readiness, then permits another bounded burst',async t=>{
  let polls=0;
  const driver={storage:{get:async()=>undefined,set:async()=>{}},client:{square:{fetchSquareChatEvents:async()=>({events:[control],syncToken:`page-${++polls}`})}}};
  const {monitor,states}=fixture(t,driver);await flush();
  for(let page=1;page<SQUARE_BASELINE_MAX_PAGES;page++){t.mock.timers.tick(SQUARE_BASELINE_PAGE_DELAY_MS);await flush();}
  assert.equal(polls,SQUARE_BASELINE_MAX_PAGES);assert.equal(states.at(-1).ready,false);assert.equal(states.at(-1).status,'initializing');
  t.mock.timers.tick(INTERVAL-1);await flush();assert.equal(polls,SQUARE_BASELINE_MAX_PAGES);
  t.mock.timers.tick(1);await flush();assert.equal(polls,SQUARE_BASELINE_MAX_PAGES+1);
  t.mock.timers.tick(SQUARE_BASELINE_PAGE_DELAY_MS);await flush();assert.equal(polls,SQUARE_BASELINE_MAX_PAGES+2);assert.equal(states.at(-1).ready,false);monitor.stop();
});

test('baseline elapsed-time budget includes slow requests and yields before the page limit',async t=>{
  const requestMs=Math.floor(SQUARE_BASELINE_BURST_MS/2)+1;let polls=0,signal;
  const driver={storage:{get:async()=>undefined,set:async()=>{}},monitorRequest:(current,operation)=>{signal=current;return operation();},client:{square:{fetchSquareChatEvents:()=>{
    const page=++polls;return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{signal.removeEventListener('abort',cancel);resolve({events:[control],syncToken:`slow-${page}`});},requestMs);
      const cancel=()=>{clearTimeout(timer);reject(signal.reason);};signal.addEventListener('abort',cancel,{once:true});
    });
  }}}};
  const {monitor,states}=fixture(t,driver);await flush();assert.equal(polls,1);
  t.mock.timers.tick(requestMs);await flush();t.mock.timers.tick(SQUARE_BASELINE_PAGE_DELAY_MS);await flush();assert.equal(polls,2);
  t.mock.timers.tick(requestMs);await flush();assert.equal(states.at(-1).ready,false);
  t.mock.timers.tick(INTERVAL-1);await flush();assert.equal(polls,2);
  t.mock.timers.tick(1);await flush();assert.equal(polls,3);monitor.stop();
});

test('crossing the burst deadline during the short page delay prevents another request until the regular interval',async t=>{
  const firstPage=deferred(),response={events:[control],syncToken:'slow-first'};let polls=0;t.after(()=>firstPage.resolve(response));
  const driver={storage:{get:async()=>undefined,set:async()=>{}},client:{square:{fetchSquareChatEvents:()=>++polls===1?firstPage.promise:Promise.resolve({events:[control],syncToken:`next-${polls}`})}}};
  const {monitor,states}=fixture(t,driver);await flush();assert.equal(polls,1);
  t.mock.timers.tick(SQUARE_BASELINE_BURST_MS-100);firstPage.resolve(response);await flush();assert.equal(states.at(-1).ready,false);
  t.mock.timers.tick(SQUARE_BASELINE_PAGE_DELAY_MS);await flush();assert.equal(polls,1,'the short delay crossed the time budget, so the next request must wait');
  t.mock.timers.tick(INTERVAL-1);await flush();assert.equal(polls,1);
  t.mock.timers.tick(1);await flush();assert.equal(polls,2);monitor.stop();
});

test('unchanged baseline cursor prevents a fast retry loop despite a nonempty page',async t=>{
  let polls=0;
  const driver={storage:{get:async()=>({syncToken:'unchanged',ready:false}),set:async()=>{}},client:{square:{fetchSquareChatEvents:async()=>{polls++;return {events:[control],syncToken:'unchanged',continuationToken:'synthetic-more'};}}}};
  const {monitor,states}=fixture(t,driver);await flush();assert.equal(polls,1);
  t.mock.timers.tick(INTERVAL-1);await flush();assert.equal(polls,1);assert.equal(states.at(-1).ready,false);
  t.mock.timers.tick(1);await flush();assert.equal(polls,2);assert.equal(states.at(-1).ready,false);monitor.stop();
});

test('duplicate historical events across advancing and unchanged baseline cursors never reach name resolution or capture',async t=>{
  const requests=[],resolved=[],old=message('same-historical-event');
  const pages=[{events:[old],syncToken:'boundary'},{events:[old],syncToken:'boundary'},{events:[old],syncToken:'advanced-boundary'},{events:[],syncToken:'empty-boundary'},{events:[message('new-live-event')],syncToken:'live'}];
  const driver={storage:{get:async()=>({syncToken:'start',ready:false}),set:async()=>{}},client:{square:{fetchSquareChatEvents:async options=>{requests.push(options);return pages[requests.length-1];}}},resolveMessageNames:async(_chat,messages)=>{resolved.push(...messages.map(value=>value.id));return messages;}};
  const {monitor,states,captured}=fixture(t,driver);await flush();
  t.mock.timers.tick(SQUARE_BASELINE_PAGE_DELAY_MS);await flush();assert.equal(requests.length,2);
  t.mock.timers.tick(INTERVAL-1);await flush();assert.equal(requests.length,2);assert.deepEqual(captured,[]);assert.deepEqual(resolved,[]);
  t.mock.timers.tick(1);await flush();assert.equal(requests.length,3);assert.equal(states.at(-1).ready,false);
  t.mock.timers.tick(SQUARE_BASELINE_PAGE_DELAY_MS);await flush();assert.equal(states.at(-1).ready,true);assert.deepEqual(captured,[]);assert.deepEqual(resolved,[]);
  t.mock.timers.tick(INTERVAL);await flush();assert.deepEqual(captured.map(value=>value.id),['new-live-event']);assert.deepEqual(resolved,['new-live-event']);monitor.stop();
});

test('a terminal empty page cannot renew prior success or ready state before its durable ACK',async t=>{
  const ack=deferred(),requests=[];let writes=0,durable;t.after(()=>ack.resolve());
  const driver={storage:{get:async()=>undefined,set:async(_key,value)=>{if(++writes===2)await ack.promise;durable={...value};}},client:{square:{fetchSquareChatEvents:async options=>{
    requests.push(options);return requests.length===1?{events:[control],syncToken:'acknowledged-baseline'}:{events:[],syncToken:'unacknowledged-ready'};
  }}}};
  const {monitor,states}=fixture(t,driver);await flush();const previousSuccess=states.at(-1).lastSuccessAt;assert.ok(previousSuccess);
  t.mock.timers.tick(SQUARE_BASELINE_PAGE_DELAY_MS);await flush();assert.equal(requests.length,2);
  assert.equal(states.at(-1).ready,false);assert.equal(states.at(-1).lastSuccessAt,previousSuccess);assert.equal(states.at(-1).pagination.checkpointSucceeded,false);
  assert.deepEqual(durable,{syncToken:'acknowledged-baseline',ready:false});t.mock.timers.tick(INTERVAL);await flush();assert.equal(requests.length,2);
  ack.resolve();await flush();assert.equal(states.at(-1).ready,true);assert.notEqual(states.at(-1).lastSuccessAt,previousSuccess);assert.equal(states.at(-1).pagination.checkpointSucceeded,true);
  assert.deepEqual(durable,{syncToken:'unacknowledged-ready',ready:true});monitor.stop();
});

test('restart from a durably saved unready checkpoint continues to discard history until the empty boundary',async t=>{
  let durable;const storage={get:async()=>durable,set:async(_key,value)=>{durable={...value};}};
  const first=fixture(t,{storage,client:{square:{fetchSquareChatEvents:async()=>({events:[message('before-restart')],syncToken:'saved-unready'})}}});
  await flush();assert.deepEqual(durable,{syncToken:'saved-unready',ready:false});assert.deepEqual(first.captured,[]);first.monitor.stop();await first.room.task;
  const requests=[];const second=fixture(t,{storage,client:{square:{fetchSquareChatEvents:async options=>{
    requests.push(options);return requests.length===1?{events:[message('after-restart-history')],syncToken:'still-unready'}:{events:[],syncToken:'ready-after-restart'};
  }}}},{mockClock:false});
  await flush();assert.equal(requests[0].syncToken,'saved-unready');assert.equal(second.states.at(-1).ready,false);assert.deepEqual(second.captured,[]);
  t.mock.timers.tick(SQUARE_BASELINE_PAGE_DELAY_MS);await flush();assert.equal(second.states.at(-1).ready,true);
  assert.deepEqual(durable,{syncToken:'ready-after-restart',ready:true});assert.deepEqual(second.captured,[]);second.monitor.stop();
});

test('pending and failed baseline ACKs prevent progress; retry uses the last durable cursor before resuming the burst',async t=>{
  const ack=deferred(),requests=[];let writes=0,durable={syncToken:'durable-start',ready:false};t.after(()=>ack.resolve());
  const driver={storage:{get:async()=>durable,set:async(_key,value)=>{if(++writes===1)await ack.promise;durable={...value};}},client:{square:{fetchSquareChatEvents:async options=>{
    requests.push(options);return {events:[message('discarded-history')],syncToken:'candidate'};
  }}}};
  const {monitor,states,captured}=fixture(t,driver);await flush();assert.equal(states.at(-1).lastSuccessAt,null);assert.equal(states.at(-1).pagination.checkpointSucceeded,false);
  t.mock.timers.tick(1000);await flush();assert.equal(requests.length,1);assert.deepEqual(durable,{syncToken:'durable-start',ready:false});
  ack.reject(new Error('synthetic failed ACK'));await flush();assert.equal(states.at(-1).status,'retrying');assert.equal(states.at(-1).lastFailure.stage,'checkpoint');assert.equal(states.at(-1).lastSuccessAt,null);
  t.mock.timers.tick(1999);await flush();assert.equal(requests.length,1);t.mock.timers.tick(1);await flush();
  assert.deepEqual(requests.map(request=>request.syncToken),['durable-start','durable-start']);assert.deepEqual(durable,{syncToken:'candidate',ready:false});
  assert.ok(states.at(-1).lastSuccessAt);assert.equal(states.at(-1).ready,false);assert.deepEqual(captured,[]);monitor.stop();
});

test('stop cancels the short baseline delay and a late checkpoint cannot publish successful readiness',async t=>{
  let polls=0;
  const first=fixture(t,{storage:{get:async()=>undefined,set:async()=>{}},client:{square:{fetchSquareChatEvents:async()=>({events:[control],syncToken:`page-${++polls}`})}}});
  await flush();first.monitor.stop();await first.room.task;t.mock.timers.tick(INTERVAL);await flush();assert.equal(polls,1);
  const ack=deferred();t.after(()=>ack.resolve());
  const second=fixture(t,{storage:{get:async()=>({syncToken:'unready',ready:false}),set:()=>ack.promise},client:{square:{fetchSquareChatEvents:async()=>({events:[],syncToken:'would-be-ready'})}}},{mockClock:false});
  await flush();const beforeStop=second.states.length;second.monitor.stop();ack.resolve();await second.room.task;
  assert.equal(second.states.length,beforeStop);assert.ok(second.states.every(state=>state.lastSuccessAt===null));assert.ok(second.states.every(state=>state.ready===false));
});
