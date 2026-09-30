import test from 'node:test';
import assert from 'node:assert/strict';
import {LiveMonitor,nextTalkCursor,talkChatId} from '../protocol/monitor.mjs';
test('talk routing handles incoming direct chats and group/outgoing messages',()=>{
  assert.equal(talkChatId({from:'friend',to:'self'},'self'),'friend');
  assert.equal(talkChatId({from:'friend',to:'group'},'self'),'group');
  assert.equal(talkChatId({from:'self',to:'friend'},'self'),'friend');
});
test('OpenChat baseline is discarded before new events are captured with an encrypted checkpoint',async()=>{
  const saved=[],captured=[],resolved=[];let monitor,index=0,finish;const done=new Promise(resolve=>{finish=resolve;});
  const envelope=(id,text)=>({payload:{receiveMessage:{squareMessage:{message:{id,from:'person',text}}}}});
  const driver={storage:{get:async()=>undefined,set:async(key,value)=>{saved.push(value);if(value.syncToken==='live'){monitor.stop();finish();}}},client:{square:{fetchSquareChatEvents:async request=>{assert.equal(request.direction,'FORWARD');const pages=[{events:[envelope('old','history')],syncToken:'baseline'},{events:[],syncToken:'ready'},{events:[envelope('new','incoming')],syncToken:'live'}];return pages[index++];}}}};
  driver.resolveMessageNames=async(chat,messages)=>{resolved.push(...messages.map(m=>m.id));return messages.map(m=>({...m,senderName:'OpenChat nickname'}));};
  monitor=new LiveMonitor(driver,()=>{},async(id,message)=>captured.push([id,message]));monitor.update([{id:'room',kind:'openchat'}]);
  const timer=setTimeout(finish,5000);try{await done;assert.equal(index,3);assert.equal(captured.length,1);assert.deepEqual(resolved,['new']);assert.equal(captured[0][1].senderName,'OpenChat nickname');assert.equal(captured[0][1].text,'incoming');assert.deepEqual(saved[0],{syncToken:'baseline',ready:false});assert.deepEqual(saved[1],{syncToken:'ready',ready:true});}finally{clearTimeout(timer);monitor.stop();}
});
test('sync cursor preserves bigint revisions and global/individual checkpoints',()=>{
  assert.deepEqual(nextTalkCursor({revision:1n,globalRev:2,individualRev:3},{operationResponse:{operations:[{revision:9007199254740999n}],globalEvents:{lastRevision:8},individualEvents:{lastRevision:9}}}),{revision:9007199254740999n,globalRev:8,individualRev:9});
});
test('listener discards undesignated messages before decryption and waits for storage ACK',async()=>{
  const decrypted=[],saved=[],captured=[],resolved=[];let monitor;
  const driver={storage:{get:async()=>({revision:1,globalRev:0,individualRev:0}),set:async(k,v)=>{saved.push([k,v]);monitor.stop();}},client:{profile:{mid:'self'},talk:{sync:async()=>({operationResponse:{operations:[{type:'RECEIVE_MESSAGE',revision:2,message:{id:'private',from:'person',to:'excluded',text:'private'}},{type:26,revision:3,message:{id:'allowed',from:'person',to:'chosen',text:'visible'}}]}})},e2ee:{decryptE2EEMessage:async raw=>{decrypted.push(raw.id);return raw;}}}};
  let acknowledge;const ack=new Promise(resolve=>{acknowledge=resolve;});
  driver.resolveMessageNames=async(chat,messages)=>{resolved.push(chat.id);return messages.map(m=>({...m,senderName:'Contact alias'}));};
  monitor=new LiveMonitor(driver,()=>{},async(id,message)=>{captured.push([id,message]);await ack;});monitor.update([{id:'chosen',kind:'group'}]);
  try{await new Promise(resolve=>setTimeout(resolve,1100));assert.deepEqual(decrypted,['allowed']);assert.deepEqual(resolved,['chosen']);assert.equal(captured[0][1].senderName,'Contact alias');assert.equal(captured[0][0],'chosen');assert.equal(saved.length,0);acknowledge();await new Promise(resolve=>setTimeout(resolve,50));assert.equal(saved[0][1].revision,3);}
  finally{acknowledge();monitor.stop();}
});
