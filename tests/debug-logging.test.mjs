import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.mjs';
import {Vault} from '../server/vault.mjs';
import {Hub} from '../server/hub.mjs';
import {DemoDriver} from '../server/drivers.mjs';
import {DebugLogging,debugDetails} from '../server/debug-logging.mjs';

async function fixture(t){
  const store=new Store(':memory:');let emit;
  const hub=new Hub(store,new Vault(randomBytes(32),'synthetic'),(account,storage,events)=>{emit=events;return new DemoDriver();});
  t.after(()=>{hub.close();store.close();});
  const account=await hub.addAccount({label:'Debug account',kind:'line'});await hub.connect(account.id);
  return {hub,store,account,emit};
}

test('debug logging defaults off, validates settings and migrates old records without losing them',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'linebridge-debug-')),path=join(dir,'bridge.sqlite');
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const old=new DatabaseSync(path);
  old.exec("CREATE TABLE audit(id TEXT PRIMARY KEY,at TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,account_id TEXT,chat_id TEXT,outcome TEXT NOT NULL); INSERT INTO audit VALUES('old','2026-01-01','local-admin','account.create',NULL,NULL,'ok');");old.close();
  let store=new Store(path);
  try{
    const debug=new DebugLogging(store);assert.deepEqual(debug.settings(),{enabled:false});
    debug.record('refresh','ok',{durationMs:10});assert.equal(store.audits().length,1);
    for(const value of [{},{enabled:'true'},{enabled:true,secret:'x'}])assert.throws(()=>debug.configure(value));
    debug.configure({enabled:true});debug.record('refresh','ok',{durationMs:10});
  }finally{store.close();}
  store=new Store(path);
  try{
    const debug=new DebugLogging(store);assert.equal(debug.settings().enabled,true);
    assert.equal(store.audits().find(row=>row.id==='old').action,'account.create');
    assert.deepEqual(store.audits().find(row=>row.action==='debug.refresh').details,{durationMs:10});
    debug.configure({enabled:false});const count=store.audits().length;
    debug.record('refresh','failed',{durationMs:20});assert.equal(store.audits().length,count);
  }finally{store.close();}
});

test('frequent debug records are capped separately and never evict the security audit trail',()=>{
  const store=new Store(':memory:');
  try{
    store.audit('local-admin','local-setup.enable','account',null,'ok');
    const debug=new DebugLogging(store);debug.configure({enabled:true});
    for(let i=0;i<2100;i++)debug.record('refresh','ok',{durationMs:i});
    const rows=store.db.prepare("SELECT action,COUNT(*) AS count FROM audit GROUP BY action").all();
    assert.deepEqual(Object.fromEntries(rows.map(row=>[row.action,row.count])),{'debug.refresh':2000,'debug.toggle':1,'local-setup.enable':1});
    for(let i=0;i<2005;i++)store.audit('local-admin','chat.access','account','chat','ok');
    const debugRows="actor='system' AND action LIKE 'debug.%'";
    assert.equal(store.db.prepare(`SELECT COUNT(*) AS count FROM audit WHERE NOT (${debugRows})`).get().count,2000);
    assert.equal(store.db.prepare(`SELECT COUNT(*) AS count FROM audit WHERE ${debugRows}`).get().count,2000);
  }finally{store.close();}
});

test('every poll start, empty success, baseline and failure is recorded once through the real hub event handler',async t=>{
  const {hub,store,account,emit}=await fixture(t);
  const started={channel:'talk',status:'polling',lastPoll:'2026-10-05T00:00:00.000Z',lastAttemptAt:'2026-10-05T00:00:00.000Z',pollTimeoutMs:180000};
  emit.monitor(started);assert.equal(store.audits().filter(row=>row.action==='debug.poll').length,0);
  hub.debug.configure({enabled:true});
  const polling={...started,lastPoll:'2026-10-05T00:01:00.000Z',lastAttemptAt:'2026-10-05T00:01:00.000Z'};
  emit.monitor(polling);emit.monitor({...polling,pagination:{returnedEvents:0}});
  const success={...polling,status:'running',lastPoll:'2026-10-05T00:01:00.250Z',lastSuccessAt:'2026-10-05T00:01:00.250Z'};
  emit.monitor(success);emit.monitor({...success});
  const failed={...success,status:'retrying',lastPoll:'2026-10-05T00:04:00.000Z',lastFailure:{at:'2026-10-05T00:04:00.000Z',kind:'timeout',stage:'poll',elapsedMs:180000,retryInMs:2000,message:'private-debug-sentinel',headers:'private-debug-sentinel'}};
  emit.monitor(failed);
  const rows=store.audits().filter(row=>row.action==='debug.poll');assert.equal(rows.length,3);
  assert.deepEqual(rows.map(row=>row.outcome),['failed','ok','polling']);
  assert.equal(rows[1].details.durationMs,250);assert.equal(rows[0].details.failureKind,'timeout');assert.equal(rows[0].details.retryInMs,2000);
  assert.equal(rows[0].details.lastSuccessAt,success.lastSuccessAt);assert.ok(rows.every(row=>row.account_id===account.id));
  assert.ok(!JSON.stringify(rows).includes('private-debug-sentinel'));
  store.putChat(account.id,{id:'test-openchat',name:'Room',kind:'openchat'});
  emit.monitor({...success,channel:'test-openchat',status:'initializing'});
  const baseline=store.audits().find(row=>row.chat_id==='test-openchat');assert.equal(baseline.details.channel,'openchat');assert.equal(baseline.details.status,'initializing');
  hub.debug.configure({enabled:false});emit.monitor({...polling,lastPoll:'2026-10-05T00:05:00.000Z'});
  assert.equal(store.audits().filter(row=>row.action==='debug.poll').length,4);
});

test('account refresh failures and recovery log status and duration without upstream text',async t=>{
  const {hub,store,account}=await fixture(t);hub.debug.configure({enabled:true});
  const driver=hub.driver(account.id),check=driver.check.bind(driver);
  driver.check=async()=>{throw Object.assign(new Error('private-debug-sentinel'),{code:'ECONNRESET'});};
  await hub.healthcheck();
  const failure=store.audits().find(row=>row.action==='debug.account-refresh');
  assert.equal(failure.outcome,'failed');assert.equal(failure.details.failureKind,'network');assert.ok(failure.details.durationMs>=0);
  driver.check=check;hub.runtime.get(account.id).accountHealth.nextRetryAt=null;await hub.healthcheck();
  assert.equal(store.audits().find(row=>row.action==='debug.account-refresh').outcome,'ok');
  assert.ok(!JSON.stringify(store.audits()).includes('private-debug-sentinel'));
});

test('debug details allow only operational fields and debug writes cannot break reception',async t=>{
  const {hub,store}=await fixture(t);hub.debug.configure({enabled:true});
  const secret='private-debug-sentinel';
  assert.deepEqual(debugDetails({durationMs:4.5,accounts:-1,connected:Infinity,messages:NaN,channel:secret,status:secret,failureKind:secret,stage:secret,lastSuccessAt:secret,token:secret,text:secret,headers:secret,url:secret,pagination:{cursor:secret}}),{durationMs:4});
  const audit=store.audit;store.audit=()=>{throw new Error('Disk unavailable');};
  assert.doesNotThrow(()=>hub.debug.record('refresh','ok',{durationMs:1}));store.audit=audit;
});

test('high-frequency debug records retain only the newest 2000 entries, including tied timestamps',()=>{
  const store=new Store(':memory:'),debug=new DebugLogging(store);
  try{
    debug.configure({enabled:true});
    for(let i=0;i<2005;i++)debug.record('refresh','ok',{messages:i});
    const rows=store.audits(3000).filter(row=>row.action==='debug.refresh');assert.equal(rows.length,2000);assert.equal(rows[0].details.messages,2004);assert.equal(rows.at(-1).details.messages,5);
    assert.ok(store.audits(3000).some(row=>row.action==='debug.toggle'),'The admin toggle stays in the security trail');
  }finally{store.close();}
});
