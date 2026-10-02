import test from 'node:test';
import assert from 'node:assert/strict';
import { LineDriver, squareMessages, joinedSquareRooms, discoveryErrorCode } from '../server/drivers.mjs';
test('expired device authorization requires QR login, while transient failures remain retryable',async()=>{
  const d=Object.create(LineDriver.prototype),error=Object.assign(new Error('private upstream details'),{name:'RequestError',data:{errorCode:'NOT_AUTHORIZED_DEVICE'}});
  d.storage={get:async()=> 'synthetic-token'};d.client={loginProcess:{login:async()=>{throw error;}}};
  await assert.rejects(d.login(false),{code:'login_required'});
  error.data.errorCode='INTERNAL_ERROR';await assert.rejects(d.login(false),e=>e===error);
});
test('Square receive and send event envelopes are normalized and deduplicated',()=>{
  const message={id:'message-01',from:'member-01',text:'sample',createdTime:1750000000000};
  const events=[{payload:{receiveMessage:{squareChatMid:'room',squareMessage:{message},senderDisplayName:'Member'}}},{payload:{sendMessage:{squareMessage:{message}}}},{payload:{notifiedJoinSquareChat:{}}}];
  const result=squareMessages({events});assert.equal(result.length,1);assert.equal(result[0].text,'sample');assert.ok(result[0].timestamp);
});
test('personal history uses the bounded Talk RPC and never exposes undecrypted chunks',async()=>{
  const d=Object.create(LineDriver.prototype);let args;
  d.client={request:{request:async(...a)=>{args=a;return [{id:'encrypted'}];}},thrift:{rename_thrift:()=>({id:'encrypted',from:'user',chunks:['private cipher'],text:'untrusted fallback',contentType:'NONE'})},e2ee:{decryptE2EEMessage:async()=>{throw new Error('private failure');}}};
  const response=await d.read({id:'u123',kind:'direct'},12);
  assert.equal(args[1],'getRecentMessagesV2');assert.deepEqual(args[0],[[11,2,'u123'],[8,3,12]]);
  assert.equal(response.messages[0].text,'');assert.ok(!JSON.stringify(response).includes('private cipher'));assert.ok(response.messages[0].unavailableReason);
});
test('Letter Sealing sends contain only encrypted chunks and require a message ID',async()=>{
  const d=Object.create(LineDriver.prototype);let options;
  d.client={e2ee:{encryptE2EEMessage:async()=>['cipher']},talk:{sendMessage:async o=>{options=o;return {id:'accepted'};}}};
  assert.equal((await d.send({id:'u123',kind:'direct'},'hello')).messageId,'accepted');assert.equal(options.e2ee,true);
  assert.equal(options.text,undefined);assert.deepEqual(options.chunks,['cipher']);
  d.client.talk.sendMessage=async()=>({});await assert.rejects(d.send({id:'u123',kind:'direct'},'hello'),{code:'send_unconfirmed'});
});
test('contact discovery unwraps V2 entries and reports only usable chat IDs',async()=>{
  const d=Object.create(LineDriver.prototype);
  d.client={talk:{getAllChatMids:async()=>({memberChatMids:[]}),getAllContactIds:async()=>['u123'],getContactsV2:async()=>({contacts:{u123:{userStatus:'NORMAL',contact:{mid:'u123',displayName:'Friend'}}}})},square:{fetchMyEvents:async()=>({events:[]})}};
  const result=await d.discover();assert.deepEqual(result.chats,[{id:'u123',name:'Friend',kind:'direct'}]);assert.equal(result.stages.direct.count,1);
});
test('OpenChat sends unwrap LINE’s createdSquareMessage response',async()=>{
  const d=Object.create(LineDriver.prototype);let options;
  d.client={square:{sendMessage:async o=>{options=o;return {createdSquareMessage:{message:{id:'square-accepted',createdTime:1750000000000}}};}}};
  assert.equal((await d.send({id:'m123',kind:'openchat'},'hello')).messageId,'square-accepted');
  assert.deepEqual(options,{squareChatMid:'m123',text:'hello'});
});
test('OpenChat discovery reads joined membership snapshots, deduplicates and paginates',async()=>{
  const d=Object.create(LineDriver.prototype);const tokens=[];
  const room=(id,state='JOINED')=>({payload:{notifiedCreateSquareChatMember:{chat:{squareChatMid:id,name:id},chatMember:{membershipState:state}}}});
  d.client={talk:{getAllChatMids:async()=>{throw new Error('private upstream details');},getAllContactIds:async()=>[]},square:{fetchMyEvents:async options=>{
    tokens.push(options.continuationToken);return options.continuationToken?{events:[room('joined-1'),room('joined-2',1)]}:{events:[room('joined-1'),room('left','LEFT'),room('pending','JOIN_RESERVED')],continuationToken:'next'};
  }}};
  const result=await d.discover();assert.deepEqual(tokens,[undefined,'next']);assert.deepEqual(result.chats.map(c=>c.id),['joined-1','joined-2']);
  assert.equal(result.stages.openchat.count,2);assert.equal(result.stages.groups.status,'failed');assert.equal(result.stages.direct.status,'ok');
  assert.ok(!JSON.stringify(result).includes('private upstream details'));assert.equal(joinedSquareRooms({events:[]}).length,0);
  assert.equal(discoveryErrorCode({data:{errorCode:'NOT_IMPLEMENTED'}}),'NOT_IMPLEMENTED');
});
test('standard personal messaging is used only for LINE’s explicit E2EE_RETRY_PLAIN response',async()=>{
  const d=Object.create(LineDriver.prototype);let options,calls=0;
  const error=Object.assign(new Error('private details'),{name:'RequestError',data:{code:'E2EE_RETRY_PLAIN'}});
  d.client={e2ee:{encryptE2EEMessage:async()=>{throw error;}},talk:{sendMessage:async o=>{options=o;calls++;return {id:'standard-message'};}}};
  const result=await d.send({id:'c123',kind:'group'},'hello');assert.equal(result.protection,'line_transport');assert.deepEqual(options,{to:'c123',text:'hello',e2ee:false});
  error.data.code='NOT_FOUND';await assert.rejects(d.send({id:'c123',kind:'group'},'hello'),{code:'send_preparation_failed'});assert.equal(calls,1);
});
test('LINE rejections are distinct from timeouts and missing acknowledgement IDs',async()=>{
  const d=Object.create(LineDriver.prototype);d.client={square:{sendMessage:async()=>{throw Object.assign(new Error('private details'),{name:'RequestError',data:{errorCode:'FORBIDDEN'}});}}};
  await assert.rejects(d.send({id:'m123',kind:'openchat'},'hello'),{code:'line_send_rejected'});
  d.client.square.sendMessage=async()=>{throw new Error('timeout');};await assert.rejects(d.send({id:'m123',kind:'openchat'},'hello'),{message:'timeout'});
});
