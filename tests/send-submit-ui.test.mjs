import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {prepareSendIntent} from '../public/send-intent.js';

const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const start=source.indexOf("    textarea.addEventListener('keydown'"),end=source.indexOf('  }catch(error){if(accountId===selectedAccount',start);
assert.ok(start>=0&&end>start,'Actual compose handlers are present');

function fixture({confirm=true,failCapability=false}={}){
  let resolveCapability,keys=0,confirmations=0,lookups=0;
  const pending=new Promise(resolve=>{resolveCapability=resolve;}),jobs=[],posts=[],listeners={};
  const textarea={value:'synthetic text',addEventListener:(type,handler)=>{listeners[type]=handler;}};
  const button={disabled:false,classList:{add(){},remove(){}}},feedback={hidden:true};
  const form={elements:{text:textarea},querySelector:()=>button,addEventListener:(type,handler)=>{listeners[type]=handler;},requestSubmit(){listeners.submit({preventDefault(){},currentTarget:form});}};
  const context={textarea,sending:false,sendAttempt:null,accountId:'account',chatId:'chat',selectedAccount:'account',selectedChat:'chat',demo:false,chat:{kind:'direct'},
    $:selector=>selector==='#send-form'?form:feedback,
    action:job=>{const promise=job().catch(()=>{});jobs.push(promise);return promise;},
    prepareSendIntent:(previous,account,chat,text,options)=>prepareSendIntent(previous,account,chat,text,{...options,newKey:()=>`key-${++keys}`}),
    api:async(path,options)=>{if(path.endsWith('/text-capability')){lookups++;await pending;if(failCapability)throw Error('synthetic lookup failure');return {officialAccount:true};}posts.push(JSON.parse(options.body));return {messageId:'synthetic'};},
    window:{confirm:()=>{assert.equal(keys,0,'Confirmation precedes intent creation');confirmations++;return confirm;}},
    chatName:()=> 'Synthetic OA',toast(){},async readMessages(){},async refresh(){},flushDiscoveredChats(){}
  };
  vm.runInNewContext(source.slice(start,end),context);
  const keyboard=meta=>listeners.keydown({key:'Enter',ctrlKey:!meta,metaKey:meta,preventDefault(){}});
  return {context,keyboard,form,button,posts,jobs,resolveCapability,counts:()=>({keys,confirmations,lookups})};
}

test('delayed OA capability coalesces repeated Ctrl/Cmd+Enter and direct submits before intent creation',async()=>{
  const f=fixture();f.keyboard(false);f.keyboard(true);f.form.requestSubmit();
  assert.equal(f.context.sending,true);assert.equal(f.button.disabled,true);
  assert.deepEqual(f.counts(),{keys:0,confirmations:0,lookups:1});assert.equal(f.context.sendAttempt,null);assert.equal(f.posts.length,0);
  f.resolveCapability();await Promise.all(f.jobs);
  assert.deepEqual(f.counts(),{keys:1,confirmations:1,lookups:1});assert.equal(f.posts.length,1);
  assert.deepEqual(f.posts[0],{text:'synthetic text',idempotencyKey:'key-1',acknowledgeOaTransport:true});
  assert.equal(f.context.sending,false);assert.equal(f.button.disabled,false);
});

test('canceled confirmation and failed capability release the submit guard without creating a key or sending',async()=>{
  for(const options of [{confirm:false},{failCapability:true}]){
    const f=fixture(options);f.keyboard(false);f.keyboard(true);f.resolveCapability();await Promise.all(f.jobs);
    assert.equal(f.counts().lookups,1);assert.equal(f.counts().keys,0);assert.equal(f.posts.length,0);assert.equal(f.context.sending,false);assert.equal(f.button.disabled,false);
    f.keyboard(false);await Promise.all(f.jobs);assert.equal(f.counts().lookups,2);assert.equal(f.counts().keys,0);assert.equal(f.posts.length,0);
  }
});
