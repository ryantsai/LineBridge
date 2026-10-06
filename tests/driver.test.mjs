import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Agent } from 'undici';
import { LineDriver, squareMessages, joinedSquareRooms, discoveryErrorCode } from '../server/drivers.mjs';
test('monitor cancellation scopes SDK fetches and preserves request deadlines and concurrent account RPCs',async t=>{
  const requests=[];
  const driver=new LineDriver({device:'IOSIPAD'},{},{fault:()=>{}},{fetch:async(url,init)=>{requests.push(init);return new Response();}});t.after(()=>driver.stop());
  const receiver=new AbortController(),deadline=new AbortController(),other=new AbortController();
  await driver.monitorRequest(receiver.signal,async()=>{await new Promise(resolve=>setImmediate(resolve));await driver.client.fetch(new Request('https://synthetic.invalid/poll',{signal:deadline.signal}));});
  await driver.client.fetch(new Request('https://synthetic.invalid/profile',{signal:other.signal}));
  receiver.abort();assert.equal(requests[0].signal.aborted,true);assert.equal(requests[1].signal.aborted,false);
  assert.throws(()=>driver.monitorRequest(receiver.signal,()=>assert.fail('Stopped receiver must not dispatch')),{name:'AbortError'});
  const next=new AbortController();await driver.monitorRequest(next.signal,()=>driver.client.fetch(new Request('https://synthetic.invalid/poll',{signal:deadline.signal})));
  deadline.abort(new DOMException('synthetic deadline','TimeoutError'));assert.equal(requests[2].signal.reason.name,'TimeoutError');assert.equal(requests[1].signal.aborted,false);
  driver.stop();assert.equal(requests[1].signal.aborted,true);
});
test('LINE RPCs use a private HTTP/1.1 pool, so a held long-poll cannot stall other calls',async t=>{
  // Node 26's shared fetch would multiplex these onto one HTTP/2 connection.
  t.mock.method(globalThis,'fetch',async()=>assert.fail('LINE RPCs must not use the shared global fetch'));
  const held=[],sockets=new Set(),server=createServer((req,res)=>{
    sockets.add(req.socket.remotePort);let body='';req.on('data',chunk=>body+=chunk);
    req.on('end',()=>{if(req.url==='/long')held.push(res);else res.end(JSON.stringify({version:req.httpVersion,body,application:req.headers['x-line-application']}));});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${server.address().port}`,driver=new LineDriver({device:'IOSIPAD'},{},{fault:()=>{}});t.after(()=>driver.stop());
  assert.ok(driver.dispatcher instanceof Agent);
  const long=driver.client.fetch(new Request(`${base}/long`,{method:'POST',body:'long-poll'}));
  while(!held.length)await new Promise(resolve=>setTimeout(resolve,5));
  const short=await driver.client.fetch(new Request(`${base}/short`,{method:'POST',body:'thrift',headers:{'x-line-application':'synthetic'}}));
  assert.deepEqual(await short.json(),{version:'1.1',body:'thrift',application:'synthetic'});assert.equal(sockets.size,2);
  driver.stop();await assert.rejects(long,{name:'AbortError'});
});
test('token refresh is shared by concurrent calls and keeps LINE’s rotated refresh token',async t=>{
  const saved=new Map([['refreshToken','issued-at-login']]),storage={get:async key=>saved.get(key),set:async(key,value)=>{saved.set(key,value);},delete:async key=>{saved.delete(key);}};
  const driver=new LineDriver({device:'IOSIPAD'},storage,{fault:()=>{}},{fetch:async()=>assert.fail('No network in this test')});t.after(()=>driver.stop());
  const spent=[];let release;const gate=new Promise(resolve=>release=resolve);
  driver.client.auth.refresh=async({request})=>{spent.push(request.refreshToken);await gate;return {accessToken:`access-${spent.length}`,refreshToken:`rotated-${spent.length}`,tokenIssueTimeEpochSec:1000n,durationUntilRefreshInSec:60n};};
  const concurrent=[1,2,3].map(()=>driver.client.auth.tryRefreshToken());release();await Promise.all(concurrent);
  assert.deepEqual(spent,['issued-at-login']);assert.equal(driver.client.authToken,'access-1');
  assert.equal(saved.get('refreshToken'),'rotated-1');assert.equal(saved.get('expire'),1060n);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(saved.get('bridge.authToken'),'access-1');
  await driver.client.auth.tryRefreshToken();assert.deepEqual(spent,['issued-at-login','rotated-1']);assert.equal(saved.get('refreshToken'),'rotated-2');
  saved.delete('refreshToken');await assert.rejects(driver.client.auth.tryRefreshToken(),{name:'RefreshError'});assert.equal(spent.length,2);
});
test('expired device authorization requires QR login, while transient failures remain retryable',async()=>{
  const d=Object.create(LineDriver.prototype),error=Object.assign(new Error('private upstream details'),{name:'RequestError',data:{errorCode:'NOT_AUTHORIZED_DEVICE'}});
  d.storage={get:async()=> 'synthetic-token'};d.client={loginProcess:{login:async()=>{throw error;}}};
  await assert.rejects(d.login(false),{code:'login_required'});
  for(const code of ['AUTHENTICATION_FAILED',1]){error.data={code};await assert.rejects(d.login(false),{code:'login_required'});}
  error.data={errorCode:'INTERNAL_ERROR'};await assert.rejects(d.login(false),e=>e===error);
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
