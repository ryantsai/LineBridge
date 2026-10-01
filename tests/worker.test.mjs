import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {Store} from '../server/store.mjs';
import {Vault,VaultStorage} from '../server/vault.mjs';
import {ProtocolWorker} from '../server/worker.mjs';
import {capture} from '../server/inbox.mjs';
import {SendRejectedError} from '../server/errors.mjs';

test('private worker RPC returns bounded sanitized errors and stops cleanly',async t=>{
  const store=new Store(':memory:'),worker=new ProtocolWorker(store,new Vault(randomBytes(32),'test'),()=>{});t.after(()=>{worker.close();store.close();});
  await assert.rejects(worker.call('disconnect',{accountId:'missing'}),{code:'account_disconnected'});assert.equal(worker.pending.size,0);assert.ok(worker.child);
  worker.close();assert.equal(worker.child,null);
});
test('storage and incoming-message acknowledgements follow durable encrypted writes',async t=>{
  const store=new Store(':memory:'),vault=new Vault(randomBytes(32),'test'),a=store.addAccount('worker','demo','IOSIPAD');t.after(()=>store.close());
  const worker=new ProtocolWorker(store,vault,(id,chat,message)=>capture(store,vault,id,chat,message)),acks=[];worker.write=value=>acks.push(value);
  worker.handle({type:'storage',id:'s1',accountId:a.id,operation:'set',key:'monitor.talk',value:{revision:9007199254740995n}});
  assert.equal(acks.at(-1).ok,true);assert.equal((await new VaultStorage(store,vault,a.id).get('monitor.talk')).revision,9007199254740995n);
  worker.handle({type:'storage',id:'s2',accountId:'missing',operation:'set',key:'secret',value:'private'});assert.equal(acks.at(-1).ok,false);
  store.putChat(a.id,{id:'chat',name:'room',kind:'group'});store.designate(a.id,'chat',true);store.setSetting(`monitor:${a.id}`,true);
  worker.handle({type:'capture',id:'c1',accountId:a.id,chatId:'chat',message:{id:'m1',text:'private'}});assert.equal(acks.at(-1).ok,true);assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,1);
  worker.handle({type:'capture',id:'c2',accountId:a.id,chatId:'chat',message:{}});assert.equal(acks.at(-1).ok,false);
});
test('worker preserves preparation-rejected sends and rejects pending jobs when closing',async()=>{
  const worker=new ProtocolWorker(null,null,null);let error;worker.pending.set('send',{timer:setTimeout(()=>{},5000),reject:e=>{error=e;}});
  worker.handle({type:'result',id:'send',error:{status:502,code:'send_preparation_failed',message:'No message was sent.',rejected_send:true}});assert.ok(error instanceof SendRejectedError);
  worker.pending.set('read',{timer:setTimeout(()=>{},5000),reject:e=>{error=e;}});worker.close();assert.equal(error.code,'upstream_unavailable');assert.equal(worker.pending.size,0);
});
