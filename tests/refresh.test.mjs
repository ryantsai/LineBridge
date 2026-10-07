import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {Store} from '../server/store.mjs';
import {Vault} from '../server/vault.mjs';
import {Hub} from '../server/hub.mjs';
import {DemoDriver} from '../server/drivers.mjs';
import {LiveMonitor} from '../protocol/monitor.mjs';
import {localCliInstructions,cloudCliInstructions} from '../public/ai-instructions.js';

const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('refresh settings default to 15 seconds, persist, validate, and apply without restarting receivers or resetting cursors',async t=>{
  const store=new Store(':memory:'),intervals=[],starts=[];
  const hub=new Hub(store,new Vault(randomBytes(32),'test'),()=>{
    const driver=new DemoDriver();
    driver.startMonitor=async(chats,reset,interval)=>starts.push([chats,reset,interval]);
    driver.setRefreshInterval=async interval=>intervals.push(interval);
    return driver;
  });t.after(()=>{hub.close();store.close();});
  assert.deepEqual(hub.refreshSettings(),{intervalSeconds:15,minSeconds:3,maxSeconds:3600});
  const a=await hub.addAccount({label:'Refresh sandbox',kind:'demo'});hub.designate(a.id,'demo-group',true);await hub.monitor(a.id,true);
  function checkInstructions(expected){
    const current={...hub.view(store.account(a.id)),localSetup:{profile:'synthetic',url:'http://127.0.0.1:3211',chatIds:['demo-group']}};
    const unrelated={id:'another-account',monitor:{staleAfterMs:999000}};
    for(const text of [localCliInstructions(current),cloudCliInstructions({accounts:[unrelated,current]},a.id)]){
      assert.ok(text.includes(`門檻為 ${expected} ms（${expected/1000} 秒）`));
      assert.ok(text.includes('執行時仍須重新讀取'));
      assert.ok(!text.includes('999000 ms'));assert.ok(!text.includes('60 秒的新鮮度門檻'));
    }
  }
  checkInstructions(75000);
  assert.equal(starts[0][2],15000);const revision=store.setting(`monitorRevision:${a.id}`);
  await hub.setRefreshSettings({intervalSeconds:120});
  assert.equal(store.setting('messageRefreshIntervalSeconds'),120);assert.deepEqual(intervals,[120000]);assert.equal(starts.length,1);
  assert.equal(hub.view(store.account(a.id)).monitor.staleAfterMs,180000);
  checkInstructions(180000);
  assert.equal(store.setting(`monitorRevision:${a.id}`),revision);assert.equal(store.setting(`monitor:${a.id}`),true);
  for(const value of [0,2,3601,3.5,'60',null])await assert.rejects(hub.setRefreshSettings({intervalSeconds:value}));
  await assert.rejects(hub.setRefreshSettings({intervalSeconds:60,extra:true}));assert.equal(hub.refreshSettings().intervalSeconds,120);
  await hub.monitor(a.id,false);await hub.monitor(a.id,true);assert.equal(starts[1][2],120000);
});

test('Talk rearms after 250ms independently of the OpenChat interval without losing the cursor',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.parse('2026-10-04T00:00:00Z')});
  const revisions=[];
  const driver={storage:{get:async()=>({revision:1}),set:async()=>{}},client:{talk:{sync:async options=>{
    revisions.push(options.revision);return {operationResponse:{operations:[{revision:revisions.length+1,type:0}]}};
  }}}};
  const monitor=new LiveMonitor(driver,()=>{},()=>{});monitor.update([{id:'chosen',kind:'group'}]);t.after(async()=>{monitor.stop();await monitor.talkTask;});
  t.mock.timers.tick(1000);await flush();assert.deepEqual(revisions,[1]);
  t.mock.timers.tick(249);await flush();assert.deepEqual(revisions,[1]);
  t.mock.timers.tick(1);await flush();assert.deepEqual(revisions,[1,2]);
  monitor.setRefreshInterval(120000);await flush();
  t.mock.timers.tick(249);await flush();assert.deepEqual(revisions,[1,2]);
  t.mock.timers.tick(1);await flush();assert.deepEqual(revisions,[1,2,3]);
  monitor.setRefreshInterval(3000);t.mock.timers.tick(250);await flush();assert.deepEqual(revisions,[1,2,3,4]);
});

test('OpenChat account polls use the configured interval and stop cancels the wait',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.parse('2026-10-04T00:00:00Z')});
  let polls=0,pages=0;const captured=[];
  const message={payload:{receiveMessage:{squareMessage:{message:{id:'new',text:'synthetic incoming'}}}}};
  const driver={storage:{get:async()=>undefined,set:async()=>{}},client:{square:{fetchMyEvents:async()=>({events:++polls===3?[{payload:{notificationMessage:{squareChatMid:'room',requiredToFetchChatEvents:true}}}]:[],syncToken:String(polls)}),fetchSquareChatEvents:async()=>({events:++pages===2?[message]:[],syncToken:String(pages)})}}};
  const monitor=new LiveMonitor(driver,()=>{},async(_id,message)=>captured.push(message),{pollJitter:()=>0.5});monitor.update([{id:'room',kind:'openchat'}]);
  t.after(async()=>{monitor.stop();await monitor.done();});
  await flush();assert.equal(polls,1);
  t.mock.timers.tick(14999);await flush();assert.equal(polls,1);
  t.mock.timers.tick(1);await flush();assert.equal(polls,2);
  monitor.setRefreshInterval(3000);await flush();t.mock.timers.tick(3000);await flush();assert.equal(polls,3);assert.equal(captured[0].id,'new');
  monitor.stop();await monitor.done();t.mock.timers.tick(60000);await flush();assert.equal(polls,3);
});
