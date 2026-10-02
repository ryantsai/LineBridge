import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {Store} from '../server/store.mjs';
import {Vault} from '../server/vault.mjs';
import {Hub,adminActor} from '../server/hub.mjs';
import {initializeSearch} from '../server/search.mjs';

async function setup(t,path=':memory:'){
  const store=new Store(path),vault=new Vault(randomBytes(32),'test'),hub=new Hub(store,vault);
  t.after(()=>{hub.close();store.close();});
  const {id}=await hub.addAccount({label:'Search sandbox',kind:'demo'});
  hub.designate(id,'demo-group',true);await hub.monitor(id,true);
  let next=0;
  return {hub,store,vault,id,add:(text,chat='demo-group')=>hub.capture(id,chat,{id:`search-${++next}`,senderId:'person',text,timestamp:new Date().toISOString()})};
}

test('language-independent Unicode substrings, phrases, terms and normalization',async t=>{
  const {hub,add}=await setup(t);
  const examples=[
    ['繁體中文與简体中文，今天開會','體中文'],['日本語の予定を確認','予定'],
    ['한국어 메시지 검색','메시지'],['ภาษาไทยไม่มีการเว้นวรรค','ไม่มี'],
    ['موعد الاجتماع غداً','الاجتماع'],['שלום עולם פגישה','עולם'],
    ['कल हमारी बैठक होगी','बैठक'],['Завтра встреча в Москве','ВСТРЕЧА'],
    ['Réunion à Montréal café','cafe\u0301'],['Καλημέρα κόσμε','κόσμε'],
    ['Swahili: mkutano kesho','mkutano'],['Mixed 🧑🏽‍💻 中文 café','🧑🏽‍💻'],
    ['Ｆｕｌｌｗｉｄｔｈ １２３','fullwidth 123'],['alpha\n\t beta gamma','alpha beta']
  ];
  for(const [message,query] of examples){add(message);const found=hub.search(adminActor,{query,mode:'phrase'});assert.equal(found.results.length,1,query);assert.equal(found.results[0].message.text,message);}
  const result=hub.search(adminActor,{query:'gamma alpha',mode:'all'});assert.equal(result.results.length,1);
  assert.equal(hub.search(adminActor,{query:'gamma alpha',mode:'phrase'}).results.length,0);
  assert.equal(hub.search(adminActor,{query:'中'}).results.length,2);
  assert.equal(hub.search(adminActor,{query:'" OR * - NEAR('}).results.length,0);
});

test('archive search enforces read grants, designation, revocation and pause without LINE calls',async t=>{
  const {hub,store,id,add}=await setup(t);add('searchable private first');
  const other=await hub.addAccount({label:'Other account',kind:'demo'});hub.designate(other.id,'demo-group',true);await hub.monitor(other.id,true);
  hub.capture(other.id,'demo-group',{id:'other',text:'searchable private second'});
  hub.driver(id).read=()=>{throw new Error('Search must not contact LINE');};hub.disconnect(id);
  const reader=hub.createToken({name:'Reader',grants:[{accountId:id,read:true,send:false}]}),actor=hub.authenticate(reader.token);
  assert.equal(hub.search(actor,{query:'private'}).results.length,1);
  assert.throws(()=>hub.search(actor,{query:'private',accountId:other.id}),{code:'scope_denied'});
  hub.designate(id,'demo-group',false);assert.equal(hub.search(actor,{query:'private'}).results.length,0);
  assert.equal(hub.search(adminActor,{query:'private'}).results.length,2);
  hub.designate(id,'demo-group',true);
  const sender=hub.createToken({name:'Sender',grants:[{accountId:id,read:false,send:true}]});
  assert.equal(hub.search(hub.authenticate(sender.token),{query:'private'}).results.length,0);
  assert.throws(()=>hub.search(hub.authenticate(sender.token),{query:'private',accountId:id}),{code:'scope_denied'});
  store.setSetting('aiEnabled',false);assert.throws(()=>hub.search(actor,{query:'private'}),{code:'gateway_paused'});store.setSetting('aiEnabled',true);
  store.revoke(reader.id);assert.throws(()=>hub.search(actor,{query:'private'}),{code:'invalid_token'});
  assert.throws(()=>hub.search(adminActor,{query:'x',chatId:'demo-group'}));
  assert.throws(()=>hub.search(adminActor,{query:'x',limit:101}));
});

test('newest-first pagination skips substring false positives and never loses candidates',async t=>{
  const {hub,add}=await setup(t);add('abcdef');
  // Contains every trigram, but not the requested phrase. No plaintext FTS positions.
  for(let i=0;i<502;i++)add('abc bcd cde def');
  const first=hub.search(adminActor,{query:'abcdef',limit:1});assert.equal(first.results.length,0);assert.equal(first.scanned,500);assert.equal(first.hasMore,true);
  const second=hub.search(adminActor,{query:'abcdef',limit:1,before:first.nextBefore});assert.equal(second.results.length,1);assert.equal(second.results[0].message.text,'abcdef');assert.equal(second.hasMore,false);
  add('abcdef last');const a=hub.search(adminActor,{query:'abcdef',limit:1});assert.equal(a.hasMore,true);
  const b=hub.search(adminActor,{query:'abcdef',limit:10,before:a.nextBefore});assert.ok(b.results.every(r=>r.sequence<a.results[0].sequence));
});

test('legacy ciphertext is backfilled, missing index rows repaired, capture/index is atomic and account deletion clears both',async t=>{
  const {hub,store,vault,id,add}=await setup(t);
  const event=randomUUID(),message={id:'legacy',text:'legacy archived 日本語'};
  store.db.prepare('INSERT INTO messages(event_id,account_id,chat_id,message_id,cipher,at) VALUES(?,?,?,?,?,?)').run(event,id,'demo-group',message.id,vault.seal(message,`message:${event}`),new Date().toISOString());
  initializeSearch(store,vault);assert.equal(hub.search(adminActor,{query:'日本語'}).results.length,1);
  store.db.exec('DELETE FROM message_search');initializeSearch(store,vault);assert.equal(hub.search(adminActor,{query:'legacy archived',mode:'phrase'}).results.length,1);
  const count=store.db.prepare('SELECT count(*) n FROM messages').get().n;
  const prepare=store.db.prepare.bind(store.db);
  store.db.prepare=sql=>{if(sql.startsWith('INSERT OR REPLACE INTO message_search'))throw new Error('synthetic persistence failure');return prepare(sql);};
  assert.throws(()=>add('must retry after persistence failure'));assert.equal(store.db.prepare('SELECT count(*) n FROM messages').get().n,count);
  store.db.prepare=prepare;const retry={id:'retry-fixed-id',text:'retry works'};
  assert.ok(hub.capture(id,'demo-group',retry)>0);assert.equal(hub.capture(id,'demo-group',retry),null);
  assert.equal(hub.search(adminActor,{query:'retry works',mode:'phrase'}).results.length,1);
  hub.remove(id);assert.equal(store.db.prepare('SELECT count(*) n FROM messages').get().n,0);assert.equal(store.db.prepare('SELECT count(*) n FROM message_search').get().n,0);
});

test('the SQLite database, WAL and contentless index contain no message plaintext',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'linebridge-search-')),path=join(directory,'bridge.sqlite');
  const {store,hub,add}=await setup(t,path),text='秘密UniquePlaintext🦜مرحبا';add(text);
  t.after(()=>{const target=resolve(directory);if(!target.startsWith(resolve(tmpdir())+sep)||!target.split(sep).at(-1).startsWith('linebridge-search-'))throw new Error('Unsafe cleanup');rmSync(target,{recursive:true,force:true});});
  assert.equal(hub.search(adminActor,{query:'UniquePlaintext'}).results.length,1);
  assert.equal(store.db.prepare('SELECT terms FROM message_search').get().terms,null);
  for(const suffix of ['', '-wal'])assert.equal(readFileSync(path+suffix).includes(Buffer.from(text)),false);
});
