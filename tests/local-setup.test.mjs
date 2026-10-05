import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {Store} from '../server/store.mjs';
import {Vault} from '../server/vault.mjs';
import {Hub,adminActor} from '../server/hub.mjs';
import {LocalSetup} from '../server/local-setup.mjs';
import {DemoDriver} from '../server/drivers.mjs';
import {CredentialStore} from '../client/credentials.mjs';

export class SyntheticCredentials {
  constructor(){this.items=new Map();this.protection='synthetic protected store';this.creates=0;}
  async create(profile,url,creds){if(this.items.has(profile))throw Object.assign(new Error('synthetic'),{code:'profile_conflict'});this.creates++;this.items.set(profile,{url,...creds});}
  async get(profile){if(!this.items.has(profile))throw Object.assign(new Error('synthetic'),{code:'credentials_required'});return this.items.get(profile);}
  async forget(profile){this.items.delete(profile);}
}
async function fixture(t,{line=false}={}){
  const store=new Store(':memory:'),vault=new Vault(randomBytes(32),'synthetic'),hub=new Hub(store,vault,()=>new DemoDriver()),credentials=new SyntheticCredentials(),setup=new LocalSetup(hub,{credentials,gatewayPort:54321});
  t.after(()=>{hub.close();store.close();});
  const account=await hub.addAccount({label:'Synthetic account',kind:line?'line':'demo'});
  if(line){await hub.connect(account.id);store.putChat(account.id,{id:'chosen',name:'Chosen group',kind:'group'});store.putChat(account.id,{id:'room',name:'Chosen room',kind:'openchat'});}
  return {store,hub,credentials,setup,id:account.id};
}
const confirm=(chatIds=['demo-group'])=>({chatIds,read:true,send:true,confirmed:true});
const activeToken=({store,setup,id})=>store.token(setup.record(id).tokenId);
const actor=async f=>f.hub.authenticate((await f.credentials.get(f.setup.record(f.id).profile)).token);
const unavailable=()=>{throw Object.assign(new Error('synthetic-secret-never-expose'),{code:'credential_store_unavailable'});};

test('explicit combined confirmation enrolls a unique protected profile; repeats reuse grant and revoke deletes it',async t=>{
  const f=await fixture(t),{setup,credentials,id,store}=f;
  credentials.items.set('default',{url:'https://old.example',token:'synthetic-existing-token'});
  assert.throws(()=>setup.enable(id,{chatIds:['demo-group'],read:true,send:false,confirmed:true}));
  assert.throws(()=>setup.enable(id,{chatIds:['demo-group'],read:true,send:true,confirmed:false}));assert.equal(store.tokens().length,0);
  const [first,second]=await Promise.all([setup.enable(id,confirm()),setup.enable(id,confirm())]);
  assert.equal(first.profile,second.profile);assert.equal(first.health,'sandbox');assert.equal(first.ready,false);assert.equal(first.grantActive,true);assert.match(first.profile,/^linebridge-/);assert.equal(credentials.creates,1);
  const token=activeToken(f);assert.deepEqual(token.grants,[{accountId:id,read:true,send:true,chatIds:['demo-group'],localOnly:true}]);
  await setup.enable(id,confirm());assert.equal(credentials.creates,1);
  await assert.rejects(setup.enable(id,confirm(['demo-openchat'])),{code:'setup_scope_conflict'});
  assert.ok(!JSON.stringify([first,setup.record(id),store.audits()]).includes((await credentials.get(first.profile)).token));
  const a=await actor(f);const sent=await f.hub.send(a,id,'demo-group','synthetic send','setup-send-001');assert.equal(sent.delivery,'sandbox_only');assert.equal((await f.hub.send(a,id,'demo-group','synthetic send','setup-send-001')).replayed,true);
  const disabled=await setup.revoke(id);assert.equal(disabled.grantActive,false);assert.equal(disabled.phase,'revoked');assert.equal(credentials.items.has(first.profile),false);assert.equal(credentials.items.get('default').token,'synthetic-existing-token');assert.throws(()=>f.hub.accounts(a),{code:'invalid_token'});
});

test('new designations never broaden listing, reads, events, search or sends; unknown sends are never retried',async t=>{
  const f=await fixture(t);await f.setup.enable(f.id,confirm());const a=await actor(f);
  f.hub.designate(f.id,'demo-openchat',true);assert.deepEqual(f.hub.chats(a,f.id).map(c=>c.id),['demo-group']);
  await f.hub.send(adminActor,f.id,'demo-group','allowed synthetic text','scope-admin-001');await f.hub.send(adminActor,f.id,'demo-openchat','excluded synthetic text','scope-admin-002');
  assert.equal(f.hub.events(a,f.id).events.length,1);assert.equal(f.hub.search(a,{query:'synthetic'}).results.length,1);assert.equal((await f.setup.status(f.id)).selectionChanged,true);
  await assert.rejects(f.hub.read(a,f.id,'demo-openchat'),{code:'scope_denied'});await assert.rejects(f.hub.send(a,f.id,'demo-openchat','forbidden','scope-deny-001'),{code:'scope_denied'});assert.throws(()=>f.hub.search(a,{query:'synthetic',accountId:f.id,chatId:'demo-openchat'}),{code:'scope_denied'});
  let calls=0;f.hub.driver(f.id).send=async()=>{calls++;throw new Error('synthetic timeout');};
  for(let i=0;i<2;i++)await assert.rejects(f.hub.send(a,f.id,'demo-group','synthetic unknown','scope-unknown-001'),{code:'delivery_unknown'});assert.equal(calls,1);
});

test('only an opted-in setup monitors newly discovered rooms and expands its own local scope',async t=>{
  for(const autoMonitorNewChats of [false,true]){
    const f=await fixture(t),updates=[],driver=f.hub.driver(f.id);
    driver.updateMonitor=async chats=>updates.push(chats.map(c=>c.id).sort());
    await f.setup.enable(f.id,{...confirm(),autoMonitorNewChats});
    const a=await actor(f),fixed=f.hub.createToken({name:'Fixed scope',grants:[{accountId:f.id,read:true,send:true,chatIds:['demo-group']}]}),fixedActor=f.hub.authenticate(fixed.token);
    driver.rooms.push({id:'new-group',name:'New group',kind:'group'},{id:'new-room',name:'New OpenChat',kind:'openchat'},{id:'new-person',name:'New contact',kind:'direct'});
    await f.hub.discover(f.id);
    assert.equal(f.store.chat(f.id,'demo-openchat').enabled,0,'An existing unchecked room stays excluded');
    const status=await f.setup.status(f.id);assert.equal(status.autoMonitorNewChats,autoMonitorNewChats);assert.equal(status.selectionChanged,false);
    assert.deepEqual(f.hub.chats(fixedActor,f.id).map(c=>c.id),['demo-group'],'Another client retains its fixed grant');
    if(!autoMonitorNewChats){
      assert.equal(f.store.chat(f.id,'new-room').enabled,0);assert.deepEqual(status.chatIds,['demo-group']);assert.equal(updates.length,0);assert.equal(f.hub.runtime.get(f.id).discoveryTimer??null,null);
      continue;
    }
    assert.deepEqual(updates.at(-1),['demo-group','new-group','new-person','new-room']);
    assert.deepEqual([...status.chatIds].sort(),updates.at(-1));assert.deepEqual(f.store.token(f.setup.record(f.id).tokenId).grants[0].chatIds.sort(),updates.at(-1));
    const incoming={id:'auto-incoming',senderId:'person',text:'synthetic future-room message'};
    assert.ok(f.hub.capture(f.id,'new-room',incoming));assert.equal(f.hub.events(a,f.id).events.length,1);assert.equal(f.hub.search(a,{query:'future-room'}).results.length,1);
    assert.equal((await f.hub.read(a,f.id,'new-room')).messages[0].id,incoming.id);
    assert.equal((await f.hub.send(a,f.id,'new-room','synthetic reply','auto-send-001')).delivery,'sandbox_only');
    await assert.rejects(f.hub.read(fixedActor,f.id,'new-room'),{code:'scope_denied'});
    f.hub.designate(f.id,'new-room',false);await f.hub.discover(f.id);
    assert.equal(f.store.chat(f.id,'new-room').enabled,0,'Rediscovery preserves a later manual exclusion');
    assert.equal(f.store.audits().filter(row=>row.action==='chat.auto-monitor').length,3,'Each new room is enrolled once');
  }
});

test('automatic discovery follows the refresh interval, resumes on reconnect and retries receiver updates',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.parse('2026-10-05T00:00:00Z')});
  const f=await fixture(t),flush=()=>new Promise(resolve=>setImmediate(resolve)),driver=f.hub.driver(f.id);let polls=0,updates=0;
  const discover=driver.discover.bind(driver);driver.discover=async()=>{polls++;return discover();};
  driver.updateMonitor=async()=>{if(++updates===1)throw new Error('synthetic update failure');};
  await f.setup.enable(f.id,{...confirm(),autoMonitorNewChats:true});
  driver.rooms.push({id:'future-room',name:'Future room',kind:'openchat'});
  t.mock.timers.tick(0);await flush();assert.equal(polls,1);assert.equal(updates,1);assert.equal(f.store.chat(f.id,'future-room').enabled,1);
  assert.match(f.store.setting(`discovery:${f.id}`).warnings[0],/retry/);
  t.mock.timers.tick(59999);await flush();assert.equal(polls,1);
  t.mock.timers.tick(1);await flush();assert.equal(polls,2);assert.equal(updates,2,'A failed update is reconciled on the next discovery');
  await f.hub.setRefreshSettings({intervalSeconds:3});t.mock.timers.tick(2999);await flush();assert.equal(polls,2);
  t.mock.timers.tick(1);await flush();assert.equal(polls,3);
  await f.hub.monitor(f.id,false);t.mock.timers.tick(60000);await flush();assert.equal(polls,3);
  await f.hub.monitor(f.id,true);t.mock.timers.tick(0);await flush();assert.equal(polls,4);
  f.hub.disconnect(f.id);assert.equal(f.hub.runtime.get(f.id).discoveryTimer??null,null);
  await f.hub.connect(f.id);const reconnected=f.hub.driver(f.id);reconnected.rooms.push({id:'offline-room',name:'Joined while offline',kind:'openchat'});
  t.mock.timers.tick(0);await flush();assert.equal(f.store.chat(f.id,'offline-room').enabled,1);assert.equal((await f.setup.status(f.id)).selectionChanged,false);
  await f.setup.revoke(f.id);reconnected.rooms.push({id:'revoked-room',name:'After revocation',kind:'openchat'});
  t.mock.timers.tick(60000);await flush();assert.equal(f.store.chat(f.id,'revoked-room'),undefined);
});

test('late automatic discovery cannot enroll a room after stop, revocation, expiry or disconnect',async t=>{
  for(const event of ['stop','revoke','expire','token-revoke','disconnect']){
    const f=await fixture(t),driver=f.hub.driver(f.id);await f.setup.enable(f.id,{...confirm(),autoMonitorNewChats:true});
    let release,entered;const started=new Promise(resolve=>{entered=resolve;});
    driver.discover=()=>{entered();return new Promise(resolve=>{release=resolve;});};
    const discovery=f.hub.discover(f.id,f.hub.runtime.get(f.id));await started;
    if(event==='stop')await f.hub.monitor(f.id,false);
    if(event==='revoke')await f.setup.revoke(f.id);
    if(event==='expire')f.store.db.prepare('UPDATE tokens SET expires_at=? WHERE id=?').run(new Date(Date.now()-1000).toISOString(),f.setup.record(f.id).tokenId);
    if(event==='token-revoke')f.store.revoke(f.setup.record(f.id).tokenId);
    if(event==='disconnect')f.hub.disconnect(f.id);
    release({chats:[{id:'late-room',name:'Late room',kind:'openchat'}],warnings:[]});await discovery;
    assert.equal(f.store.chat(f.id,'late-room'),undefined);assert.deepEqual(f.setup.record(f.id).chatIds,['demo-group']);
  }
});

test('automatic monitoring policy changes require a new confirmation, including concurrent enrollment',async t=>{
  const f=await fixture(t);await f.setup.enable(f.id,confirm());
  await assert.rejects(f.setup.enable(f.id,{...confirm(),autoMonitorNewChats:true}),{code:'setup_scope_conflict'});
  await f.setup.revoke(f.id);
  let release,entered;const started=new Promise(resolve=>{entered=resolve;}),blocked=new Promise(resolve=>{release=resolve;}),create=f.credentials.create.bind(f.credentials);
  f.credentials.create=async(...args)=>{entered();await blocked;return create(...args);};
  const enabling=f.setup.enable(f.id,{...confirm(),autoMonitorNewChats:true});await started;
  assert.throws(()=>f.setup.enable(f.id,confirm()),{code:'setup_busy'});release();assert.equal((await enabling).autoMonitorNewChats,true);
  assert.throws(()=>f.setup.enable(f.id,{...confirm(),autoMonitorNewChats:'true'}));
});

test('an opted-in scope survives service restart and status includes additions made during a protected-store read',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.parse('2026-10-05T00:00:00Z')});
  const f=await fixture(t);await f.setup.enable(f.id,{...confirm(),autoMonitorNewChats:true});f.hub.close();
  const hub=new Hub(f.store,f.hub.vault,()=>new DemoDriver()),setup=new LocalSetup(hub,{credentials:f.credentials,gatewayPort:54321});
  t.after(()=>hub.close());await hub.initialize();
  hub.driver(f.id).rooms.push({id:'restart-room',name:'New after restart',kind:'openchat'});
  t.mock.timers.tick(0);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.store.chat(f.id,'restart-room').enabled,1);assert.equal((await setup.status(f.id)).autoMonitorNewChats,true);
  const get=f.credentials.get.bind(f.credentials);
  f.credentials.get=async profile=>{const value=await get(profile);hub.driver(f.id).rooms.push({id:'status-room',name:'Added during status',kind:'group'});await hub.discover(f.id);return value;};
  const state=await setup.status(f.id);assert.ok(state.chatIds.includes('status-room'));assert.equal(state.selectionChanged,false);
});

test('protected storage failure and a write-then-failure roll back grants and keep original selection',async t=>{
  for(const written of [false,true]){
    const f=await fixture(t);f.hub.designate(f.id,'demo-openchat',true);
    const create=f.credentials.create.bind(f.credentials);f.credentials.create=async(...args)=>{if(written)await create(...args);unavailable();};
    await assert.rejects(f.setup.enable(f.id,{...confirm(),autoMonitorNewChats:true}),{code:'credential_store_unavailable'});
    assert.equal(activeToken(f).revoked,1);assert.equal(f.credentials.items.size,0);assert.deepEqual(f.store.chats(f.id).filter(c=>c.enabled).map(c=>c.id),['demo-openchat']);assert.equal(f.store.setting(`monitor:${f.id}`,false),false);
    assert.equal(f.hub.runtime.get(f.id).discoveryTimer??null,null);
  }
});

test('partial monitor failure restores selection/preferences and removes the new profile',async t=>{
  const f=await fixture(t);f.hub.designate(f.id,'demo-openchat',true);const original=f.hub.monitor.bind(f.hub);f.hub.monitor=async(id,on)=>{if(on){await original(id,on);throw new Error('synthetic start failure');}return original(id,on);};
  await assert.rejects(f.setup.enable(f.id,confirm()),{code:'setup_failed'});assert.equal(activeToken(f).revoked,1);assert.equal(f.credentials.items.size,0);assert.deepEqual(f.store.chats(f.id).filter(c=>c.enabled).map(c=>c.id),['demo-openchat']);assert.equal(f.store.setting(`monitor:${f.id}`),false);
});

test('scope changes and revocation during enrollment cannot activate a late grant',async t=>{
  for(const event of ['selection','revoke','token-revoke','disconnect','pause']){
    const f=await fixture(t);let release,started;const wait=new Promise(r=>{release=r;}),entered=new Promise(r=>{started=r;}),create=f.credentials.create.bind(f.credentials);
    f.credentials.create=async(...args)=>{started();await wait;await create(...args);};
    const enabling=f.setup.enable(f.id,confirm());await entered;
    let revoked;
    if(event==='selection')f.hub.designate(f.id,'demo-openchat',true);
    if(event==='revoke')revoked=f.setup.revoke(f.id);
    if(event==='token-revoke')f.store.revoke(f.setup.record(f.id).tokenId);
    if(event==='disconnect')f.hub.disconnect(f.id);
    if(event==='pause')f.store.setSetting('aiEnabled',false);
    release();await assert.rejects(enabling);await revoked;assert.equal(activeToken(f).revoked,1);assert.equal(f.credentials.items.size,0);
    if(event==='selection')assert.equal(f.store.chat(f.id,'demo-openchat').enabled,1,'User change is preserved');
  }
});

test('cleanup failure remains retryable and an old/mismatched profile is preserved',async t=>{
  const f=await fixture(t);const state=await f.setup.enable(f.id,confirm()),forget=f.credentials.forget.bind(f.credentials);f.credentials.forget=unavailable;
  assert.equal((await f.setup.revoke(f.id)).phase,'cleanup_required');assert.equal(activeToken(f).revoked,1);
  f.credentials.forget=forget;assert.equal((await f.setup.revoke(f.id)).phase,'revoked');
  await f.setup.enable(f.id,confirm());const profile=f.setup.record(f.id).profile;f.credentials.items.set(profile,{url:'https://old.example',token:'synthetic-old-profile'});
  assert.equal((await f.setup.status(f.id)).health,'profile_conflict');assert.equal((await f.setup.revoke(f.id)).phase,'revoked');assert.equal(f.credentials.items.get(profile).token,'synthetic-old-profile');
  assert.notEqual((await f.setup.enable(f.id,confirm())).profile,profile);assert.equal(f.credentials.items.has(state.profile),false);
});

test('restart revokes incomplete setup and reports healthy only when EVERY selected receiver succeeded',async t=>{
  const f=await fixture(t,{line:true});await f.setup.enable(f.id,confirm(['chosen','room']));const runtime=f.hub.runtime.get(f.id),now=new Date().toISOString();
  runtime.monitorStreams={talk:{channel:'talk',status:'running',lastSuccessAt:now,ready:true}};assert.equal((await f.setup.status(f.id)).ready,false);
  runtime.monitorStreams.room={channel:'room',status:'running',lastSuccessAt:now,ready:true};assert.equal((await f.setup.status(f.id)).ready,true);
  runtime.monitorStreams.room.lastSuccessAt=new Date(Date.now()-121000).toISOString();assert.equal((await f.setup.status(f.id)).health,'stale');runtime.monitorStreams.room.lastSuccessAt=now;runtime.monitorStreams.room.status='retrying';assert.equal((await f.setup.status(f.id)).health,'retrying');
  f.credentials.get=unavailable;assert.equal((await f.setup.status(f.id)).ready,false);
  const record=f.setup.record(f.id);f.setup.save(f.id,{...record,phase:'enrolling'});new LocalSetup(f.hub,{credentials:f.credentials});assert.equal(f.store.token(record.tokenId).revoked,1);assert.equal(f.setup.record(f.id).phase,'cleanup_required');
});

test('status rechecks revocation after an asynchronous protected-store read',async t=>{
  const f=await fixture(t);await f.setup.enable(f.id,confirm());const get=f.credentials.get.bind(f.credentials);
  f.credentials.get=async profile=>{const result=await get(profile);f.store.revoke(f.setup.record(f.id).tokenId);return result;};
  assert.equal((await f.setup.status(f.id)).grantActive,false);
});

test('gateway port changes require explicit reset without overwriting the old bound profile',async t=>{
  const f=await fixture(t);await f.setup.enable(f.id,confirm());const original=f.setup.record(f.id),moved=new LocalSetup(f.hub,{credentials:f.credentials,gatewayPort:54322});
  assert.equal((await moved.status(f.id)).health,'endpoint_changed');assert.equal((await moved.status(f.id)).ready,false);
  await assert.rejects(moved.enable(f.id,confirm()),{code:'setup_needs_reset'});assert.equal(f.setup.record(f.id).profile,original.profile);
  await moved.revoke(f.id);const updated=await moved.enable(f.id,confirm());assert.equal(updated.url,'http://127.0.0.1:54322');assert.notEqual(updated.profile,original.profile);
});


test('Linux adapter recovers from unavailable service with no item; locked and unowned items are preserved',async t=>{
  const f=await fixture(t);let available=false,locked=false;const items=new Map(),calls=[];
  const run=async(_file,args,{input})=>{
    calls.push(args);const profile=args.at(-1);
    if(!available)return {code:1,stdout:''};
    if(args[0]==='search')return {code:0,stdout:items.has(profile)?'[synthetic-item]\nlabel = test\n':''};
    if(args[0]==='lookup')return items.has(profile)&&!locked?{code:0,stdout:items.get(profile)}:{code:1,stdout:''};
    if(args[0]==='store'){items.set(profile,input);return {code:0,stdout:''};}
    if(args[0]==='clear'){if(locked)return {code:1,stdout:''};items.delete(profile);return {code:0,stdout:''};}
    assert.fail('Unexpected helper');
  };
  const credentials=new CredentialStore({platform:'linux',run,env:{}}),setup=new LocalSetup(f.hub,{credentials,gatewayPort:54321});
  await assert.rejects(setup.enable(f.id,confirm()),{code:'credential_store_unavailable'});assert.equal(setup.record(f.id).phase,'cleanup_required');assert.equal(items.size,0);
  available=true;assert.equal((await setup.revoke(f.id)).phase,'revoked');assert.equal(calls.filter(a=>a[0]==='clear').length,0,'Confirmed absence needs no deletion');
  const state=await setup.enable(f.id,confirm());assert.equal(state.grantActive,true);assert.equal(items.size,1);
  locked=true;await assert.rejects(credentials.create(state.profile,state.url,{token:'synthetic-conflict'}),{code:'profile_conflict'});assert.equal((await setup.revoke(f.id)).phase,'cleanup_required');assert.equal(items.size,1);assert.equal(calls.filter(a=>a[0]==='clear').length,0,'A locked item must not be deleted');
  locked=false;assert.equal((await setup.revoke(f.id)).phase,'revoked');assert.equal(items.size,0);
  await setup.enable(f.id,confirm());const profile=setup.record(f.id).profile;items.set(profile,Buffer.from(JSON.stringify({version:1,profile,url:'https://old.example',token:'synthetic-unowned-token'})).toString('base64'));
  assert.equal((await setup.revoke(f.id)).phase,'revoked');assert.equal(items.size,1,'A mismatched profile is retained');assert.ok(calls.filter(a=>a[0]==='search').every(a=>!a.includes('--unlock')));
});

test('revocation during pre-enrollment cleanup cancels the whole attempt and leaves every bearer revoked',async t=>{
  const f=await fixture(t);await f.setup.enable(f.id,confirm());const first=activeToken(f),originalGet=f.credentials.get.bind(f.credentials),originalForget=f.credentials.forget.bind(f.credentials);
  const bearer=(await f.credentials.get(f.setup.record(f.id).profile)).token;
  f.credentials.forget=unavailable;assert.equal((await f.setup.revoke(f.id)).phase,'cleanup_required');f.credentials.forget=originalForget;
  let release,started;const blocked=new Promise(r=>{release=r;}),entered=new Promise(r=>{started=r;});let pause=true;
  f.credentials.get=async profile=>{if(pause){pause=false;started();await blocked;}return originalGet(profile);};
  const enabling=f.setup.enable(f.id,confirm());await entered;const revoking=f.setup.revoke(f.id);release();
  await assert.rejects(enabling,{code:'setup_cancelled'});const disabled=await revoking;
  assert.equal(disabled.phase,'revoked');assert.equal(disabled.grantActive,false);assert.equal(f.credentials.items.size,0);assert.equal(f.credentials.creates,1,'No new token/profile may be minted after cancellation');
  assert.ok(f.store.tokens().every(token=>token.revoked));assert.equal(f.store.token(first.id).revoked,1);assert.throws(()=>f.hub.authenticate(bearer),{code:'invalid_token'});
});

test('a newer manual stop stays stopped after setup start fails or is cancelled',async t=>{
  for(const outcome of ['failure','cancel','success']){
    const f=await fixture(t);f.hub.designate(f.id,'demo-openchat',true);await f.hub.monitor(f.id,true);
    const driver=f.hub.driver(f.id);let release,started,starts=0,stops=0;const blocked=new Promise(r=>{release=r;}),entered=new Promise(r=>{started=r;});
    driver.startMonitor=async()=>{starts++;started();await blocked;if(outcome==='failure')throw new Error('synthetic delayed monitor failure');};driver.stopMonitor=async()=>{stops++;};
    const enabling=f.setup.enable(f.id,confirm());await entered;
    const stopping=f.hub.monitor(f.id,false);assert.equal(f.store.setting(`monitor:${f.id}`),false,'Manual stop immediately blocks capture');
    const cancelling=outcome==='cancel'?f.setup.revoke(f.id):null;release();
    await assert.rejects(enabling);await stopping;await cancelling;
    assert.equal(f.store.setting(`monitor:${f.id}`),false);assert.equal(activeToken(f).revoked,1);assert.equal(starts,1,'Rollback must not restart the receiver');assert.equal(stops,1,'Newer stop runs after the delayed start');assert.equal(f.credentials.items.size,0);
  }
});
