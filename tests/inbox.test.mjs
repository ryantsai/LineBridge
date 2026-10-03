import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {Store} from '../server/store.mjs';
import {Vault,VaultStorage} from '../server/vault.mjs';
import {Hub,adminActor} from '../server/hub.mjs';
import {monitorStatus} from '../server/inbox.mjs';

async function setup(t){const store=new Store(':memory:'),vault=new Vault(randomBytes(32),'test'),hub=new Hub(store,vault),account=await hub.addAccount({label:'Inbox test',kind:'demo'});t.after(()=>{hub.close();store.close();});return {hub,store,vault,id:account.id};}
test('health checks every designated stream and cannot hide missing, stale, disabled or disconnected reception',t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  const a=store.addAccount('Synthetic LINE status','line','IOSIPAD');
  for(const c of [{id:'group',kind:'group'},{id:'room',kind:'openchat'}]){store.putChat(a.id,{...c,name:c.id});store.designate(a.id,c.id,true);}
  store.setSetting(`monitor:${a.id}`,true);
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-03T00:02:00Z')});
  const recent='2026-10-03T00:01:59Z',old='2026-10-03T00:00:00Z';
  const streams={talk:{status:'polling',lastSuccessAt:recent},room:{status:'polling',lastSuccessAt:old}};
  let status=monitorStatus(store,a.id,streams);
  assert.equal(status.health,'stale');assert.equal(status.streams.talk.health,'healthy');assert.equal(status.streams.room.health,'stale');
  assert.equal(status.checkedAt,'2026-10-03T00:02:00.000Z');assert.equal(status.staleAfterMs,60000);
  delete streams.room;status=monitorStatus(store,a.id,streams);assert.equal(status.health,'waiting');assert.equal(status.streams.room.lastSuccessAt,null);
  streams.room={status:'polling',lastSuccessAt:recent,ready:false};assert.equal(monitorStatus(store,a.id,streams).health,'initializing');
  streams.room.ready=true;assert.equal(monitorStatus(store,a.id,streams).health,'healthy');
  streams.room.status='stopped';assert.equal(monitorStatus(store,a.id,streams).health,'waiting');streams.room.status='polling';
  assert.equal(monitorStatus(store,a.id,streams,'error').health,'disconnected');
  store.setSetting(`monitor:${a.id}`,false);assert.equal(monitorStatus(store,a.id,streams).health,'off');
  store.setSetting(`monitor:${a.id}`,true);store.designate(a.id,'room',false);store.designate(a.id,'group',false);
  status=monitorStatus(store,a.id,streams);assert.equal(status.health,'no_chats');assert.deepEqual(status.streams,{});
});
test('encrypted inbox only captures designated chats while monitoring; deduplicates and filters revoked chat access',async t=>{
  const {hub,store,vault,id}=await setup(t),message={id:'new-message',senderId:'person',text:'private inbox text',timestamp:'2026-10-01T00:00:00Z'};
  assert.equal(hub.capture(id,'demo-group',message),null);hub.designate(id,'demo-group',true);assert.equal(hub.capture(id,'demo-group',message),null);
  await hub.monitor(id,true);const seq=hub.capture(id,'demo-group',message);assert.ok(seq>0);assert.equal(hub.capture(id,'demo-group',message),null);assert.equal(hub.capture(id,'demo-openchat',message),null);
  const encrypted=store.db.prepare('SELECT * FROM messages').get();assert.ok(!encrypted.cipher.includes(message.text));assert.throws(()=>vault.unseal(encrypted.cipher,'wrong-event'));
  const token=hub.createToken({name:'reader',grants:[{accountId:id,read:true,send:false}]}),actor=hub.authenticate(token.token);
  assert.equal(hub.events(actor,id).events[0].message.text,message.text);assert.deepEqual(hub.events(actor,id,seq).events,[]);
  hub.designate(id,'demo-group',false);assert.deepEqual(hub.events(actor,id).events,[]);hub.designate(id,'demo-group',true);
  store.revoke(token.id);assert.throws(()=>hub.events(actor,id),{code:'invalid_token'});
  await hub.monitor(id,false);assert.equal(hub.capture(id,'demo-group',{...message,id:'off-message'}),null);
});
test('account-bound aliases enrich inbox and local history; the archive retains every capture',async t=>{
  const {hub,store,vault,id}=await setup(t);hub.designate(id,'demo-openchat',true);await hub.monitor(id,true);
  await new VaultStorage(store,vault,id).set('bridge.aliases.v1',[['square:person',{name:'繁體暱稱',source:'square_member',expires:Date.now()+60000}],['talk:person',{name:'Other identity',expires:Date.now()+60000}]]);
  for(let i=0;i<1002;i++)hub.capture(id,'demo-openchat',{id:`m-${i}`,senderId:'person',text:`inbox-${i}`,timestamp:`2026-10-01T00:00:${String(i%60).padStart(2,'0')}Z`});
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,1002);
  assert.equal(hub.search(adminActor,{query:'inbox-0',mode:'phrase'}).results[0].message.id,'m-0');
  assert.equal(hub.events(adminActor,id).events[0].message.senderName,'繁體暱稱');
  hub.driver(id).read=async()=>{throw new Error('upstream history unavailable with secret');};
  const result=await hub.read(adminActor,id,'demo-openchat',10);assert.equal(result.messages.length,10);assert.equal(result.messages[0].senderName,'繁體暱稱');assert.equal(result.upstreamError,'upstream_unavailable');
});
test('read permission is checked again after an upstream call finishes',async t=>{
  const {hub,store,id}=await setup(t);hub.designate(id,'demo-group',true);
  const token=hub.createToken({name:'reader',grants:[{accountId:id,read:true,send:false}]}),actor=hub.authenticate(token.token);
  let release;hub.driver(id).read=()=>new Promise(r=>{release=r;});const read=hub.read(actor,id,'demo-group');await new Promise(r=>setImmediate(r));store.revoke(token.id);release({messages:[{id:'private',text:'revoked'}]});await assert.rejects(read,{code:'invalid_token'});
});
