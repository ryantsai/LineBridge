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

test('empty successful polls establish liveness; a later failure preserves the last success',async()=>{
  const states=[];let monitor,polls=0,finish;
  const done=new Promise(resolve=>{finish=resolve;});
  const driver={storage:{get:async()=>({revision:1}),set:async()=>{}},client:{talk:{sync:async()=>{
    if(++polls===1)return {operationResponse:{operations:[]}};
    throw new Error('synthetic network outage');
  }}}};
  monitor=new LiveMonitor(driver,(_event,state)=>{states.push(state);if(state.status==='retrying'){monitor.stop();finish();}},()=>{throw new Error('No messages should be captured');});
  monitor.update([{id:'chosen',kind:'group'}]);
  const timer=setTimeout(finish,4000);
  try{
    await done;
    const first=states.find(s=>s.status==='polling'),success=states.find(s=>s.status==='running'),failure=states.at(-1);
    assert.equal(first.lastSuccessAt,null);assert.ok(first.lastAttemptAt);
    assert.ok(success.lastSuccessAt);assert.equal(success.ready,true);
    assert.equal(failure.status,'retrying');assert.equal(failure.lastSuccessAt,success.lastSuccessAt);
    assert.ok(Date.parse(failure.lastAttemptAt)>Date.parse(success.lastSuccessAt));
  }finally{clearTimeout(timer);monitor.stop();}
});

test('a failed durable checkpoint never reports a successful poll',async()=>{
  const states=[];let monitor,finish;
  const done=new Promise(resolve=>{finish=resolve;});
  const driver={storage:{get:async()=>({revision:1}),set:async()=>{throw new Error('synthetic storage failure');}},client:{talk:{sync:async()=>({operationResponse:{operations:[]}})}}};
  monitor=new LiveMonitor(driver,(_event,state)=>{states.push(state);if(state.status==='retrying'){monitor.stop();finish();}},()=>{});
  monitor.update([{id:'chosen',kind:'group'}]);
  const timer=setTimeout(finish,4000);
  try{await done;assert.equal(states.at(-1).status,'retrying');assert.ok(states.every(s=>s.lastSuccessAt===null));}
  finally{clearTimeout(timer);monitor.stop();}
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
