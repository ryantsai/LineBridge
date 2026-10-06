import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {Store} from '../server/store.mjs';
import {Vault} from '../server/vault.mjs';
import {Hub} from '../server/hub.mjs';
import {LocalSetup} from '../server/local-setup.mjs';
import {ChatAccess} from '../server/chat-access.mjs';
import {createApps} from '../server/app.mjs';
import {toggleChatAccess} from '../public/chat-access.js';

async function fixture(t,{path=':memory:',enroll=true}={}){
  const store=new Store(path),vault=new Vault(randomBytes(32),'synthetic'),hub=new Hub(store,vault);
  const items=new Map(),credentials={protection:'synthetic',creates:0,async create(profile,url,value){this.creates++;items.set(profile,{url,...value});},async get(profile){if(!items.has(profile))throw Error('locked');return items.get(profile);},async forget(profile){items.delete(profile);}};
  const setup=new LocalSetup(hub,{credentials}),access=new ChatAccess(setup,{ownershipTimeoutMs:20});
  const {id}=await hub.addAccount({label:'Synthetic',kind:'demo'});
  if(enroll)await setup.enable(id,{chatIds:['demo-group'],read:true,send:true,confirmed:true});
  t.after(()=>{hub.close();store.close();});
  const preview=(chat='demo-openchat')=>access.preview(id,chat),apply=(enabled,chat='demo-openchat',extra={})=>access.apply(id,chat,{enabled,confirmed:true,snapshot:preview(chat).snapshot},extra);
  return {store,hub,setup,credentials,items,access,id,preview,apply,vault};
}
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};

test('toggle synchronizes only the selected chat and existing managed credential; last OFF stays empty',async t=>{
  const f=await fixture(t),record=f.setup.record(f.id),credential=await f.credentials.get(record.profile),token=f.store.token(record.tokenId),actor=f.hub.authenticate(credential.token);
  const other=f.hub.createToken({name:'unrelated',grants:[{accountId:f.id,read:true,send:false,chatIds:['demo-group']}]});
  const on=await f.apply(true);assert.equal(on.permissions.send,true);assert.equal(on.chat.enabled,true);
  assert.deepEqual(f.hub.chats(actor,f.id).map(c=>c.id).sort(),['demo-group','demo-openchat']);
  await f.apply(false);await assert.rejects(f.hub.read(actor,f.id,'demo-openchat'),{code:'chat_not_designated'});
  await f.apply(false,'demo-group');assert.deepEqual(f.store.token(record.tokenId).grants[0].chatIds,[]);assert.deepEqual(f.setup.record(f.id).chatIds,[]);
  assert.equal(f.store.token(record.tokenId).hash,token.hash);assert.equal(f.store.token(record.tokenId).expires_at,token.expires_at);assert.equal(f.credentials.creates,1);assert.deepEqual(await f.credentials.get(record.profile),credential);assert.deepEqual(f.store.token(other.id).grants,other.grants);
  assert.doesNotMatch(JSON.stringify([on,f.store.audits()]),new RegExp(credential.token));
  await f.apply(true);assert.equal(f.preview().permissions.read,true);
});

test('missing, revoked, expired, malformed and locked profiles never gain access; OFF still denies access',async t=>{
  for(const mode of ['missing','revoked','expired','wildcard','remote','locked','mismatch']){
    const f=await fixture(t,{enroll:mode!=='missing'}),r=f.setup.record(f.id);
    if(mode==='revoked')f.store.revoke(r.tokenId);
    if(mode==='expired')f.store.db.prepare('UPDATE tokens SET expires_at=? WHERE id=?').run('2000-01-01',r.tokenId);
    if(['wildcard','remote','mismatch'].includes(mode)){const g=f.store.token(r.tokenId).grants[0];if(mode==='wildcard')delete g.chatIds;if(mode==='remote')g.localOnly=false;if(mode==='mismatch')g.chatIds=[];f.store.setTokenGrants(r.tokenId,[g]);}
    if(mode==='locked')f.credentials.get=async()=>{throw Error('synthetic secret');};
    await assert.rejects(f.apply(true),e=>['managed_setup_required','managed_profile_unavailable'].includes(e.code));assert.equal(f.preview().chat.enabled,false);
    f.hub.designate(f.id,'demo-group',true);await f.apply(false,'demo-group');assert.equal(f.store.chat(f.id,'demo-group').enabled,0);assert.equal(f.credentials.creates,mode==='missing'?0:1);
  }
});

test('manual overlapping/wildcard and token-free grants cannot accidentally gain a newly enabled chat',async t=>{
  for(const chatIds of [undefined,['demo-openchat']]){
    const f=await fixture(t),other=f.hub.createToken({name:'manual',grants:[{accountId:f.id,read:true,send:false,...(chatIds?{chatIds}:{})}]});
    await assert.rejects(f.apply(true),{code:'manual_grant_conflict'});assert.deepEqual(f.store.token(other.id).grants,other.grants);assert.equal(f.preview().chat.enabled,false);
  }
  const f=await fixture(t);f.access.authentication=()=> 'local';await assert.rejects(f.apply(true),{code:'local_access_conflict'});
});

test('stale UI, concurrent toggles, revoke, cancel, grant changes and ABA fail closed after credential await',async t=>{
  for(const mutate of ['toggle','revoke','cancel','grant','designationABA','setupABA','grantABA','manual']){
    const f=await fixture(t),gate=deferred(),r=f.setup.record(f.id),credential=await f.credentials.get(r.profile),controller=new AbortController();
    f.credentials.get=()=>gate.promise;f.access.ownershipTimeoutMs=1000;
    const pending=f.apply(true,'demo-openchat',{signal:controller.signal});
    if(mutate==='toggle')await f.apply(false,'demo-group');
    if(mutate==='revoke')f.store.revoke(r.tokenId);
    if(mutate==='cancel')controller.abort();
    if(mutate==='grant')f.store.setTokenGrants(r.tokenId,[]);
    if(mutate==='designationABA'){f.store.designate(f.id,'demo-openchat',true);f.store.designate(f.id,'demo-openchat',false);}
    if(mutate==='setupABA'){f.setup.save(f.id,{...r,autoMonitorNewChats:true});f.setup.save(f.id,r);}
    if(mutate==='grantABA'){const g=f.store.token(r.tokenId).grants;f.store.setTokenGrants(r.tokenId,[]);f.store.setTokenGrants(r.tokenId,g);}
    if(mutate==='manual')f.hub.createToken({name:'racing manual',grants:[{accountId:f.id,read:true,send:false}]});
    gate.resolve(credential);await assert.rejects(pending,e=>['chat_access_changed','toggle_cancelled'].includes(e.code));assert.equal(f.preview().chat.enabled,false);
  }
  const f=await fixture(t),p=f.preview();f.store.touchToken(f.setup.record(f.id).tokenId);assert.equal(f.preview().snapshot,p.snapshot);
  await assert.rejects(f.access.apply(f.id,'demo-openchat',{enabled:true}),/./);
});

test('atomic rollback, bounded ownership, and independent receiver errors',async t=>{
  const f=await fixture(t),before=f.preview(),audit=f.store.audit;
  f.store.audit=()=>{throw Error('disk failure');};await assert.rejects(f.apply(true),/disk failure/);f.store.audit=audit;
  assert.deepEqual(f.preview(),before);
  const get=f.credentials.get;f.credentials.get=()=>new Promise(()=>{});await assert.rejects(f.apply(true),{code:'managed_profile_unavailable'});assert.deepEqual(f.preview(),before);f.credentials.get=get;
  f.hub.updateMonitor=async()=>{throw Error('LINE offline');};assert.equal((await f.apply(true)).chat.enabled,true);await new Promise(r=>setImmediate(r));assert.equal(f.hub.runtime.get(f.id).monitorStreams.worker.status,'retrying');
  f.hub.updateMonitor=()=>new Promise(()=>{});assert.equal((await f.apply(false)).chat.enabled,false);
});

test('committed scope and monotonic snapshot survive reopening the database',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'linebridge-chat-access-')),path=join(directory,'bridge.sqlite');
  // This test owns the freshly allocated exact directory only.
  const f=await fixture(t,{path});t.after(()=>rmSync(directory,{recursive:true,force:true}));
  await f.apply(true);await f.apply(false,'demo-group');const saved=f.preview();
  const reopened=new Store(path),hub=new Hub(reopened,f.vault),setup=new LocalSetup(hub,{credentials:f.credentials}),access=new ChatAccess(setup);
  try{assert.deepEqual(access.preview(f.id,'demo-openchat'),saved);assert.deepEqual(setup.record(f.id).chatIds,['demo-openchat']);assert.deepEqual(reopened.token(setup.record(f.id).tokenId).grants[0].chatIds,['demo-openchat']);}finally{hub.close();reopened.close();}
});

test('HTTP toggle requires dashboard session, origin, explicit confirmation and current scope',async t=>{
  const portProbe=createServer();await new Promise(r=>portProbe.listen(0,'127.0.0.1',r));const port=portProbe.address().port;await new Promise(r=>portProbe.close(r));
  const f=await fixture(t),apps=createApps({hub:f.hub,localSetup:f.setup,tunnels:{config:()=>({provider:'local'})},root:resolve('.'),adminPort:port}),server=apps.admin.listen(port,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>{server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${server.address().port}`,path=`/admin/accounts/${f.id}/chats/demo-openchat`,headers={};
  assert.equal((await fetch(base+path+'/access',{headers})).status,401);
  const page=await fetch(base,{headers});headers.Cookie=page.headers.get('set-cookie').split(';')[0];headers['Content-Type']='application/json';
  const preview=await (await fetch(base+path+'/access',{headers})).json(),body=JSON.stringify({enabled:true,confirmed:true,snapshot:preview.snapshot});
  assert.equal((await fetch(base+path,{method:'PATCH',headers,body})).status,403);
  headers.Origin=base;headers['X-Line-Bridge']='dashboard';
  assert.equal((await fetch(base+path,{method:'PATCH',headers,body:'{"enabled":true}'})).status,400);
  assert.equal((await fetch(base+path,{method:'PATCH',headers,body})).status,200);
  assert.equal((await fetch(base+path,{method:'PATCH',headers,body})).status,409);
});

test('browser confirms exact scope, cancels without PATCH, and reconciles lost response without retry',async()=>{
  const preview={snapshot:'x'.repeat(64),chat:{id:'chat',name:'Synthetic chat',kind:'group',enabled:false},profile:'synthetic-profile',chatIds:['existing'],selectedChatIds:['existing'],managed:true,gatewayEnabled:true,setupRequired:false};
  let calls=[],message;const fetcher=async(url,options)=>{calls.push(options);return {ok:true,json:async()=>preview};};
  assert.equal((await toggleChatAccess({accountId:'a',chatId:'chat',enabled:true,fetcher,confirm:text=>{message=text;return false;}})).cancelled,true);assert.equal(calls.length,1);assert.match(message,/synthetic-profile/);assert.match(message,/existing\nchat/);assert.match(message,/讀取／傳送/);
  calls=[];let reads=0;const states=[];
  await assert.rejects(toggleChatAccess({accountId:'a',chatId:'chat',enabled:true,confirm:()=>true,onState:s=>states.push(s),fetcher:async(url,options)=>{calls.push(options);if(options.method==='PATCH')throw Error('lost response');reads++;return {ok:true,json:async()=>({...preview,chat:{...preview.chat,enabled:reads>1}})};}}),/已重新讀取/);
  assert.equal(calls.filter(c=>c.method==='PATCH').length,1);assert.equal(states.at(-1).chat.enabled,true);
  await assert.rejects(toggleChatAccess({accountId:'a',chatId:'chat',enabled:true,fetcher:async()=>({ok:true,json:async()=>({...preview,setupRequired:true})}),confirm:()=>{throw Error('must not confirm');}}),/連線/);
});

test('browser deadlines release a hung preview and reconcile an ambiguous timed-out PATCH',async()=>{
  const hung=(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('deadline')),{once:true}));
  await assert.rejects(toggleChatAccess({accountId:'a',chatId:'chat',enabled:true,fetcher:hung,timeoutMs:5}),/deadline/);
  const preview={snapshot:'x'.repeat(64),chat:{id:'chat',name:'Synthetic',kind:'group',enabled:false},profile:'fixture',chatIds:[],selectedChatIds:[],managed:true,gatewayEnabled:true};let patches=0,reads=0;
  await assert.rejects(toggleChatAccess({accountId:'a',chatId:'chat',enabled:true,confirm:()=>true,timeoutMs:5,fetcher:(url,options)=>{
    if(options.method==='PATCH'){patches++;return hung(url,options);}reads++;return Promise.resolve({ok:true,json:async()=>preview});
  }}),/已重新讀取/);assert.equal(patches,1);assert.equal(reads,2);
});
