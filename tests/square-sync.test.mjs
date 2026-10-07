import test from 'node:test';
import assert from 'node:assert/strict';
import {LiveMonitor} from '../protocol/monitor.mjs';
import {SQUARE_ACCOUNT_KEY,SQUARE_BASELINE_PAGE_DELAY_MS} from '../protocol/square-sync.mjs';
import {SQUARE_RECONCILE_MS} from '../server/monitor-policy.mjs';
import {LineDriver} from '../server/drivers.mjs';
import {randomBytes} from 'node:crypto';
import {Store} from '../server/store.mjs';
import {Vault,VaultStorage} from '../server/vault.mjs';
import {capture as archiveCapture,monitorStatus} from '../server/inbox.mjs';

const flush=async()=>{for(let i=0;i<4;i++)await new Promise(resolve=>setImmediate(resolve));};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const chat=id=>({id,kind:'openchat'});
const message=(room,id,time=1000)=>({payload:{receiveMessage:{squareChatMid:room,squareMessage:{message:{id,from:'synthetic-member',to:room,text:`synthetic ${id}`,createdTime:time}}}}});
const notice=(room,extra={})=>({type:'NOTIFICATION_MESSAGE',payload:{notificationMessage:{squareChatMid:room,...extra}}});
async function tick(t,ms){t.mock.timers.tick(ms);await flush();}
function fixture(t,{ids=['a','b','c'],saved,feed,room,capture,write,resolveNames,interval=1000}={}){
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.parse('2026-10-07T00:00:00Z')});
  const durable=saved??new Map(ids.map(id=>[`monitor.square:${id}`,{syncToken:`${id}-old`,ready:true}]));
  const states=[],captured=[],feeds=[],hydrates=[],writes=[],resolved=[];let feedCount=0,roomCount=0;
  const driver={storage:{get:async key=>durable.get(key),set:async(key,value)=>{writes.push([key,structuredClone(value)]);await write?.(key,value);durable.set(key,structuredClone(value));}},client:{config:{timeout:30000},square:{
    fetchMyEvents:async options=>{feeds.push(options);return feed?feed(options,++feedCount):{events:[],syncToken:`feed-${++feedCount}`};},
    fetchSquareChatEvents:async options=>{hydrates.push(options);return room?room(options,++roomCount):{events:[],syncToken:`${options.squareChatMid}-${++roomCount}`};}
  }},resolveMessageNames:async(c,messages)=>{resolved.push(c.id);return resolveNames?resolveNames(c,messages):messages;}};
  const monitor=new LiveMonitor(driver,(_event,state)=>states.push(state),async(id,m)=>{captured.push([id,m]);await capture?.(id,m);},{refreshIntervalMs:interval,random:()=>0,pollJitter:()=>0.5});
  monitor.update(ids.map(chat));t.after(async()=>{monitor.stop();await monitor.done();});
  return {monitor,driver,durable,states,captured,feeds,hydrates,writes,resolved};
}

test('one account poll covers many quiet rooms; startup and periodic recovery are bounded',async t=>{
  const f=fixture(t,{ids:['a','b','c','d','e']});await flush();
  assert.equal(f.feeds.length,1);assert.equal(f.hydrates.length,5);assert.equal(f.durable.get(SQUARE_ACCOUNT_KEY).syncToken,'feed-1');
  assert.ok([...f.monitor.pollStates.values()].every(s=>s.ready&&s.lastSuccessAt));
  for(let i=0;i<4;i++)await tick(t,1000);
  assert.equal(f.feeds.length,5);assert.equal(f.hydrates.length,5,'quiet rooms do not each poll at the feed interval');
  await tick(t,SQUARE_RECONCILE_MS);assert.equal(f.hydrates.length,10,'scoped reconciliation catches missed/coalesced notifications');
  f.monitor.update([]);await tick(t,1000);assert.equal(f.feeds.length,6);assert.ok([...f.monitor.pollStates.values()].every(s=>s.status==='stopped'));
});

test('full or incomplete notifications hydrate only scoped rooms and preserve per-room ordering/dedupe',async t=>{
  const calls=new Map();
  const f=fixture(t,{ids:['a','b'],feed:(_options,n)=>({events:n===2?[notice('excluded',{requiredToFetchChatEvents:true}),notice('a',{squareMessage:{message:{id:'coalesced-last'}},requiredToFetchChatEvents:true}),notice('a'),{payload:{notifiedUpdateSquareChatStatus:{squareChatMid:'b'}}}]:[],syncToken:`feed-${n}`}),room:options=>{
    const id=options.squareChatMid,n=(calls.get(id)??0)+1;calls.set(id,n);
    return {events:n===2?[message(id,`${id}-2`,2000),message(id,`${id}-1`,1000),message(id,`${id}-1`,1000)]:[],syncToken:`${id}-${n}`};
  }});await flush();await tick(t,1000);
  assert.equal(f.durable.get(SQUARE_ACCOUNT_KEY).syncToken,'feed-1','feed ACK waits for room catch-up');
  await tick(t,SQUARE_BASELINE_PAGE_DELAY_MS);
  assert.deepEqual(f.captured.filter(([id])=>id==='a').map(([,m])=>m.id),['a-1','a-2']);
  assert.deepEqual(f.captured.filter(([id])=>id==='b').map(([,m])=>m.id),['b-1','b-2']);
  assert.deepEqual([...new Set(f.hydrates.map(o=>o.squareChatMid))].sort(),['a','b']);assert.deepEqual(f.resolved.sort(),['a','b']);
  assert.equal(f.durable.get(SQUARE_ACCOUNT_KEY).syncToken,'feed-2');
});

test('fresh baseline and restart discard historical messages until the durable empty boundary',async t=>{
  const ack=deferred();t.after(()=>ack.resolve());let pages=0;
  const f=fixture(t,{ids:['a'],saved:new Map(),room:()=>({events:++pages===1?[message('a','history')]:[],syncToken:`room-${pages}`,continuationToken:'sticky'}),write:async(key,value)=>{if(key==='monitor.square:a'&&value.ready)await ack.promise;}});
  await flush();assert.deepEqual(f.durable.get('monitor.square:a'),{syncToken:'room-1',ready:false});assert.equal(f.durable.has(SQUARE_ACCOUNT_KEY),false);
  await tick(t,250);assert.equal(f.monitor.pollStates.get('a').ready,false);assert.deepEqual(f.captured,[]);
  ack.resolve();await flush();assert.equal(f.monitor.pollStates.get('a').ready,true);assert.equal(f.durable.has(SQUARE_ACCOUNT_KEY),true);assert.deepEqual(f.captured,[]);
  f.monitor.stop();await f.monitor.done();
  // A new receiver reading an interrupted baseline keeps discarding history.
  f.durable.set('monitor.square:a',{syncToken:'room-1',ready:false});
  let next=0;f.driver.client.square.fetchSquareChatEvents=async options=>{assert.ok(['room-1','resumed'].includes(options.syncToken));return ++next===1?{events:[message('a','restart-history')],syncToken:'resumed'}:{events:[],syncToken:'restart-ready'};};
  const restarted=new LiveMonitor(f.driver,()=>{},()=>assert.fail('Baseline must not capture'),{refreshIntervalMs:1000,random:()=>0});t.after(async()=>{restarted.stop();await restarted.done();});restarted.update([chat('a')]);await flush();await tick(t,250);
  assert.deepEqual(f.durable.get('monitor.square:a'),{syncToken:'restart-ready',ready:true});
});

test('failed capture replays the room cursor; partial captures dedupe and feed never advances early',async t=>{
  const archived=new Set();let fail=true;
  const f=fixture(t,{ids:['a'],feed:(_o,n)=>({events:[notice('a')],syncToken:`feed-${n}`}),room:options=>({events:options.syncToken==='a-old'?[message('a','one'),message('a','two')]:[],syncToken:options.syncToken==='a-old'?'messages':'empty'}),capture:(_id,m)=>{if(m.id==='two'&&fail){fail=false;throw new Error('SYNTHETIC_PRIVATE_BODY');}archived.add(m.id);}});
  await flush();assert.equal(f.durable.has(SQUARE_ACCOUNT_KEY),false);assert.equal(f.durable.get('monitor.square:a').syncToken,'a-old');assert.equal(f.monitor.pollStates.get('a').lastFailure.kind,'capture');assert.equal(f.monitor.pollStates.get('a').lastSuccessAt,null);
  await tick(t,2000);await tick(t,250);
  assert.deepEqual([...archived],['one','two']);assert.deepEqual(f.hydrates.slice(0,2).map(o=>o.syncToken),['a-old','a-old']);assert.equal(f.durable.get(SQUARE_ACCOUNT_KEY).syncToken,'feed-1');assert.equal(f.monitor.pollStates.get('a').error,undefined);assert.ok(!JSON.stringify(f.states).includes('SYNTHETIC_PRIVATE_BODY'));
});

test('room and account checkpoint failures retain retry evidence and recover from durable cursors',async t=>{
  let roomFail=true,accountFail=true;
  const f=fixture(t,{ids:['a'],write:(key)=>{if(key==='monitor.square:a'&&roomFail){roomFail=false;throw Error('private');}if(key===SQUARE_ACCOUNT_KEY&&accountFail){accountFail=false;throw Error('private');}}});
  await flush();assert.equal(f.monitor.pollStates.get('a').lastFailure.stage,'checkpoint');assert.equal(f.monitor.pollStates.get('a').lastSuccessAt,null);assert.equal(f.durable.get('monitor.square:a').syncToken,'a-old');
  await tick(t,2000);assert.equal(f.monitor.pollStates.get('a').status,'retrying');assert.equal(f.durable.has(SQUARE_ACCOUNT_KEY),false);
  const count=f.hydrates.length;await tick(t,4000);assert.equal(f.hydrates.length,count);assert.equal(f.durable.get(SQUARE_ACCOUNT_KEY).syncToken,'feed-1');assert.equal(f.monitor.pollStates.get('a').status,'running');assert.equal(f.monitor.pollStates.get('a').error,undefined);
});

test('account empty page counts as success only after durable ACK, and an actual failure stays visible',async t=>{
  const ack=deferred();t.after(()=>ack.resolve());let second=false;
  const f=fixture(t,{ids:['a'],feed:(_o,n)=>{if(n>2)throw Error('network');return {events:[],syncToken:`feed-${n}`};},write:(key)=>{if(key===SQUARE_ACCOUNT_KEY&&second)return ack.promise;}});
  await flush();const success=f.monitor.pollStates.get('a').lastSuccessAt;second=true;await tick(t,1000);
  assert.equal(f.monitor.pollStates.get('a').lastSuccessAt,success);assert.equal(f.monitor.pollStates.get('a').status,'polling');
  ack.resolve();await flush();assert.notEqual(f.monitor.pollStates.get('a').lastSuccessAt,success);const recovered=f.monitor.pollStates.get('a').lastSuccessAt;
  await tick(t,1000);assert.equal(f.monitor.pollStates.get('a').status,'retrying');assert.equal(f.monitor.pollStates.get('a').lastSuccessAt,recovered);
});

test('account continuation pages cannot renew untouched rooms before the caught-up page is durably ACKed',async t=>{
  const ack=deferred(),roomCalls=new Map();t.after(()=>ack.resolve());
  const f=fixture(t,{ids:['a','b'],feed:(_o,n)=>({
    events:n===1||n===5?[]:[notice(n===3?'a':'excluded')],syncToken:`feed-${n}`,...(n>1&&n<5?{continuationToken:`more-${n}`}:{})
  }),room:options=>{
    const id=options.squareChatMid,n=(roomCalls.get(id)??0)+1;roomCalls.set(id,n);
    return {events:id==='a'&&n===2?[message('a','late-notification')]:[],syncToken:`${id}-${n}`};
  },write:(key,value)=>key===SQUARE_ACCOUNT_KEY&&value.syncToken==='feed-5'?ack.promise:undefined});
  const store=new Store(':memory:'),account=store.addAccount('Synthetic backlog','line','IOSIPAD');t.after(()=>store.close());
  for(const id of ['a','b']){store.putChat(account.id,{...chat(id),name:id});store.designate(account.id,id,true);}store.setSetting(`monitor:${account.id}`,true);
  const health=()=>monitorStatus(store,account.id,Object.fromEntries(f.monitor.pollStates));
  await flush();const original=f.monitor.pollStates.get('b').lastSuccessAt;assert.equal(health().health,'healthy');
  await tick(t,75001);
  assert.equal(f.feeds.length,2);assert.equal(f.hydrates.length,2);assert.equal(f.durable.get(SQUARE_ACCOUNT_KEY).continuationToken,'more-2');
  for(const id of ['a','b']){assert.equal(f.monitor.pollStates.get(id).lastSuccessAt,original);assert.equal(health().streams[id].health,'stale');}
  await tick(t,250);assert.deepEqual(f.captured.map(([,m])=>m.id),['late-notification']);assert.equal(f.monitor.pollStates.get('a').ready,false);
  await tick(t,250);const hydrated=f.monitor.pollStates.get('a').lastSuccessAt;
  assert.notEqual(hydrated,original);assert.equal(f.monitor.pollStates.get('a').source,'room_events');assert.equal(health().streams.a.health,'healthy');assert.equal(health().streams.b.health,'stale');
  await tick(t,250);assert.equal(f.feeds.length,4);
  assert.equal(f.monitor.pollStates.get('a').lastSuccessAt,hydrated);assert.equal(f.monitor.pollStates.get('b').lastSuccessAt,original);
  await tick(t,250);assert.equal(f.feeds.length,5);assert.equal(f.durable.get(SQUARE_ACCOUNT_KEY).syncToken,'feed-4');assert.equal(health().streams.b.health,'stale');
  await tick(t,1);ack.resolve();await flush();
  assert.equal(f.durable.get(SQUARE_ACCOUNT_KEY).syncToken,'feed-5');assert.equal(health().health,'healthy');
  assert.notEqual(f.monitor.pollStates.get('a').lastSuccessAt,hydrated);assert.notEqual(f.monitor.pollStates.get('b').lastSuccessAt,original);
  assert.deepEqual([...roomCalls],[['a',3],['b',1]],'excluded notifications never hydrate a room and untouched rooms retain their own cursor');
});

test('many rooms use at most two concurrent hydration calls; no global ACK while one is pending',async t=>{
  const gates=[],f=fixture(t,{ids:['a','b','c','d','e','f'],room:options=>{const gate=deferred();gates.push({gate,id:options.squareChatMid});return gate.promise;}});
  t.after(()=>{for(const {gate,id} of gates)gate.resolve({events:[],syncToken:`${id}-done`});});
  await flush();assert.equal(gates.length,2);assert.equal(f.durable.has(SQUARE_ACCOUNT_KEY),false);
  for(let i=0;i<6;i++){assert.ok(gates.length<=i+2);const {gate,id}=gates[i];gate.resolve({events:[],syncToken:`${id}-done`});await flush();}
  assert.equal(gates.length,6);assert.equal(f.durable.get(SQUARE_ACCOUNT_KEY).syncToken,'feed-1');
});

test('removal during name resolution prevents capture; re-selection persists a fresh baseline',async t=>{
  const names=deferred();t.after(()=>names.resolve([]));
  const f=fixture(t,{ids:['a'],room:()=>({events:[message('a','private')],syncToken:'new'}),resolveNames:()=>names.promise});await flush();
  f.monitor.update([]);names.resolve([{id:'private'}]);await flush();assert.deepEqual(f.captured,[]);assert.equal(f.monitor.pollStates.get('a').status,'stopped');
  f.driver.client.square.fetchSquareChatEvents=async()=>({events:[],syncToken:'new-baseline'});f.monitor.update([chat('a')]);await flush();
  assert.ok(f.writes.some(([key,value])=>key==='monitor.square:a'&&value.ready===false&&!value.syncToken));assert.deepEqual(f.captured,[]);assert.deepEqual(f.durable.get('monitor.square:a'),{syncToken:'new-baseline',ready:true});
});

test('account continuation is checkpointed, restored on restart, and repeated nonempty tokens cannot spin',async t=>{
  const durable=new Map([[SQUARE_ACCOUNT_KEY,{syncToken:'durable-feed',continuationToken:'durable-page'}],['monitor.square:a',{syncToken:'a-old',ready:true}]]);
  const f=fixture(t,{ids:['a'],saved:durable,feed:(options,n)=>{
    if(n===1){assert.equal(options.syncToken,'durable-feed');assert.equal(options.continuationToken,'durable-page');return {events:[{payload:{}}],syncToken:'next',continuationToken:'more'};}
    if(n===2)return {events:[{payload:{}}],syncToken:'next',continuationToken:'more'};
    return {events:[],syncToken:'recovered'};
  }});await flush();assert.deepEqual(durable.get(SQUARE_ACCOUNT_KEY),{syncToken:'next',continuationToken:'more'});
  await tick(t,250);assert.equal(f.feeds.length,2);assert.equal(f.monitor.pollStates.get('a').status,'retrying');await tick(t,1999);assert.equal(f.feeds.length,2);await tick(t,1);assert.equal(f.feeds.length,3);assert.equal(durable.get(SQUARE_ACCOUNT_KEY).syncToken,'recovered');
});

test('malformed feed and cross-room hydration responses cannot become successful empty polls',async t=>{
  const f=fixture(t,{ids:['a'],feed:()=>({events:null,syncToken:'invalid'})});await flush();assert.equal(f.durable.has(SQUARE_ACCOUNT_KEY),false);assert.equal(f.monitor.pollStates.get('a').lastSuccessAt,null);assert.equal(f.monitor.pollStates.get('a').lastFailure.kind,'protocol');
  f.driver.client.square.fetchMyEvents=async()=>({events:[notice('a')],syncToken:'valid'});f.driver.client.square.fetchSquareChatEvents=async()=>({events:[message('outside','private')],syncToken:'bad-room'});
  await tick(t,2000);assert.deepEqual(f.captured,[]);assert.equal(f.durable.get('monitor.square:a').syncToken,'a-old');assert.equal(f.monitor.pollStates.get('a').lastSuccessAt,null);
});

test('real SDK has one Square account request plus one Talk request; removal/stop cancels independently',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.parse('2026-10-07T00:00:00Z')});const requests=[];
  const driver=new LineDriver({device:'IOSIPAD'},{get:async key=>key==='monitor.talk'?{revision:1}:undefined},{fault:()=>{}},{fetch:async(url,{signal})=>new Promise((_resolve,reject)=>{requests.push({url,signal});signal.addEventListener('abort',()=>reject(signal.reason),{once:true});})});t.after(()=>driver.stop());
  const m=new LiveMonitor(driver,()=>{},()=>assert.fail('No capture while pending'),{random:()=>0});t.after(async()=>{m.stop();await m.done();});
  m.update([chat('a'),chat('b'),chat('c'),{id:'group',kind:'group'}]);await flush();await tick(t,1000);
  assert.equal(requests.length,2);m.update([{id:'group',kind:'group'}]);await flush();assert.equal(requests.find(r=>r.url.endsWith('/SQ1')).signal.aborted,true);assert.equal(requests.find(r=>r.url.endsWith('/SYNC4')).signal.aborted,false);
  m.stop();await m.done();assert.ok(requests.every(r=>r.signal.aborted));assert.equal(driver.abort.signal.aborted,false);
});

test('encrypted durable replay after interrupted account ACK deduplicates archive rows and preserves designation',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.parse('2026-10-07T00:00:00Z')});
  const store=new Store(':memory:'),vault=new Vault(randomBytes(32),'synthetic'),account=store.addAccount('Synthetic recovery','line','IOSIPAD');
  t.after(()=>store.close());for(const id of ['a','excluded'])store.putChat(account.id,{...chat(id),name:id});store.designate(account.id,'a',true);store.setSetting(`monitor:${account.id}`,true);
  const storage=new VaultStorage(store,vault,account.id);await storage.set('monitor.square:a',{syncToken:'old',ready:true});await storage.set(SQUARE_ACCOUNT_KEY,{syncToken:'old-feed'});
  const original=storage.set.bind(storage),ack=deferred();let interrupt=true;t.after(()=>ack.reject(Error('interrupted checkpoint')));
  storage.set=async(key,value)=>{if(key===SQUARE_ACCOUNT_KEY&&interrupt)return ack.promise;return original(key,value);};
  const requests=[],driver={storage,client:{square:{fetchMyEvents:async options=>{requests.push(options.syncToken);return {events:[notice('a'),notice('excluded')],syncToken:'next-feed'};},fetchSquareChatEvents:async options=>{assert.equal(options.squareChatMid,'a');return options.syncToken==='old'?{events:[message('a','one')],syncToken:'captured'}:{events:[],syncToken:'tail'};}}}};
  const capture=(id,m)=>archiveCapture(store,vault,account.id,id,m),states={};
  const first=new LiveMonitor(driver,(_event,s)=>states[s.channel]=s,capture,{refreshIntervalMs:1000,random:()=>0});t.after(async()=>{first.stop();ack.reject(Error('stopped'));await first.done();});first.update([chat('a')]);await flush();
  assert.equal(monitorStatus(store,account.id,states).health,'initializing','an ACKed partial backlog is not caught up');await tick(t,250);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM messages').get().n,1);assert.equal((await storage.get(SQUARE_ACCOUNT_KEY)).syncToken,'old-feed');
  first.stop();ack.reject(Error('interrupted checkpoint'));await first.done();interrupt=false;
  const second=new LiveMonitor(driver,()=>{},capture,{refreshIntervalMs:1000,random:()=>0});t.after(async()=>{second.stop();await second.done();});second.update([chat('a')]);await flush();
  assert.deepEqual(requests,['old-feed','old-feed']);assert.equal((await storage.get(SQUARE_ACCOUNT_KEY)).syncToken,'next-feed');assert.equal(store.db.prepare('SELECT COUNT(*) n FROM messages').get().n,1);
  const row=store.db.prepare('SELECT cipher FROM messages').get();assert.ok(!row.cipher.includes('synthetic one'));assert.equal(store.chat(account.id,'excluded').enabled,0);
});

test('real 429 Retry-After pauses the whole Square feed; interval and selection changes cannot bypass it',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.parse('2026-10-07T00:00:00Z')});let calls=0;
  const driver=new LineDriver({device:'IOSIPAD'},{get:async()=>undefined},{fault:()=>{}},{fetch:async()=>{calls++;return new Response(null,{status:429,headers:{'retry-after':'120'}});}});t.after(()=>driver.stop());
  const states=[],m=new LiveMonitor(driver,(_event,s)=>states.push(s),()=>assert.fail('429 is not an empty success'),{refreshIntervalMs:1000,random:()=>0});t.after(async()=>{m.stop();await m.done();});m.update([chat('a')]);await flush();
  assert.equal(calls,1);assert.equal(states.at(-1).lastFailure.kind,'rate_limit');assert.equal(states.at(-1).lastFailure.retryAfterMs,120000);assert.equal(states.at(-1).lastSuccessAt,null);assert.ok(states.at(-1).nextRetryAt);
  m.setRefreshInterval(3);m.update([chat('b')]);await tick(t,119999);assert.equal(calls,1);await tick(t,1);assert.equal(calls,2);
});
