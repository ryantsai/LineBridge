import test from 'node:test';
import assert from 'node:assert/strict';
import {squarePageDiagnostic} from '../protocol/pagination-diagnostics.mjs';

test('OpenChat diagnostic counts payload shapes, enum values and cursor equality without copying values',t=>{
  t.mock.timers.enable({apis:['Date'],now:10000});
  const diagnostic=squarePageDiagnostic({response:{syncToken:'next-secret',continuationToken:'continuation-secret',events:[
    {type:'RECEIVE_MESSAGE',eventStatus:'NORMAL',syncToken:'input-secret',payload:{receiveMessage:{}}},
    {type:1,eventStatus:2,syncToken:'next-secret',payload:{sendMessage:{}}},
    {type:'NOTIFICATION_MESSAGE',eventStatus:'ALERT_DISABLED',payload:{notificationMessage:{}}},
    {type:62,eventStatus:1,payload:{unrecognized:{}}}
  ]},cursor:'input-secret',baseline:true,page:3,startedAt:9750,continuationTokenSent:'previous-secret'});
  assert.deepEqual(diagnostic,{page:3,elapsedMs:250,eventCount:4,eventsTruncated:false,recognizedMessageCount:3,
    eventTypeCounts:{0:1,1:1,29:1,62:1},eventStatusCounts:{1:2,2:2},cursorProvided:true,cursorChanged:true,
    continuationPresent:true,continuationSent:true,eventTokenEqualsInputCount:1,eventTokenEqualsOutputCount:1,
    baselineBefore:true,checkpointSucceeded:false});
  assert.doesNotMatch(JSON.stringify(diagnostic),/secret/);
});

test('adversarial upstream strings and nested contents never become diagnostic values or keys',()=>{
  const privateValue='PRIVATE message token account-id https://secret.invalid';
  const opaque={toString(){throw new Error('must not coerce upstream objects');},toJSON(){throw new Error('must not serialize upstream objects');}};
  const message={get text(){throw new Error('must not inspect message content');},id:privateValue};
  const events=[
    {type:privateValue,eventStatus:privateValue,syncToken:privateValue,payload:{receiveMessage:{squareMessage:{message}}}},
    {type:'__proto__',eventStatus:'constructor',payload:{notificationMessage:{privateValue}}},
    {type:opaque,eventStatus:opaque,payload:{sendMessage:{message:opaque}}},
    {type:35,eventStatus:0},null,privateValue
  ];
  const diagnostic=squarePageDiagnostic({response:{events,syncToken:privateValue,continuationToken:opaque,
    headers:{authorization:privateValue},error:privateValue},cursor:opaque,baseline:privateValue,page:opaque,startedAt:opaque});
  assert.deepEqual(diagnostic.eventTypeCounts,{other:6});
  assert.deepEqual(diagnostic.eventStatusCounts,{other:6});
  assert.equal(diagnostic.recognizedMessageCount,3);
  assert.equal(diagnostic.cursorProvided,false);assert.equal(diagnostic.cursorChanged,false);
  assert.equal(diagnostic.continuationPresent,false);assert.equal(diagnostic.baselineBefore,false);
  assert.equal(diagnostic.eventTokenEqualsInputCount,0);assert.equal(diagnostic.eventTokenEqualsOutputCount,1);
  assert.equal(diagnostic.checkpointSucceeded,false);
  assert.doesNotMatch(JSON.stringify(diagnostic),/PRIVATE|secret|__proto__|constructor|authorization|account-id/);
});

test('event inspection is capped at the requested page size and reports truncation',()=>{
  const events=Array.from({length:101},()=>({type:0,eventStatus:1,payload:{receiveMessage:{}}}));
  Object.defineProperty(events,100,{get(){throw new Error('read beyond diagnostic page limit');}});
  const result=squarePageDiagnostic({response:{events}});
  assert.equal(result.eventCount,100);assert.equal(result.eventsTruncated,true);
  assert.equal(result.recognizedMessageCount,100);
  assert.deepEqual(result.eventTypeCounts,{0:100});assert.deepEqual(result.eventStatusCounts,{1:100});
});

test('only published event codes are accepted, including gaps and numeric lookalike rejection',()=>{
  const events=Array.from({length:63},(_,type)=>({type,eventStatus:type%2+1}));
  events.push({type:'0',eventStatus:'1'},{type:Infinity,eventStatus:NaN},{type:1.5,eventStatus:3});
  const result=squarePageDiagnostic({response:{events}});
  assert.equal(result.eventTypeCounts.other,6);
  for(const code of [35,44,45])assert.equal(Object.hasOwn(result.eventTypeCounts,code),false);
  assert.equal(result.eventTypeCounts[0],1);assert.equal(result.eventTypeCounts[62],1);
  assert.equal(result.eventStatusCounts.other,3);
});

test('missing or malformed metadata stays finite, empty tokens never compare as a match',t=>{
  t.mock.timers.enable({apis:['Date'],now:10000});
  for(const response of [undefined,null,[],{events:'private'},{events:{length:Infinity}}]){
    const result=squarePageDiagnostic({response,page:NaN,startedAt:Infinity});
    assert.equal(result.eventCount,0);assert.equal(result.page,0);assert.equal(result.elapsedMs,0);
    assert.equal(result.cursorChanged,false);assert.equal(result.checkpointSucceeded,false);
  }
  const empty=squarePageDiagnostic({response:{syncToken:'',events:[{syncToken:''}]},cursor:'',page:1e9,startedAt:-1e100,continuationTokenSent:true});
  assert.equal(empty.page,1000000);assert.equal(empty.elapsedMs,86400000);assert.equal(empty.continuationSent,true);
  assert.equal(empty.eventTokenEqualsInputCount,0);assert.equal(empty.eventTokenEqualsOutputCount,0);
  assert.equal(squarePageDiagnostic({startedAt:20000}).elapsedMs,0);
  assert.equal(squarePageDiagnostic({response:{syncToken:'same'},cursor:'same'}).cursorChanged,false);
});

test('diagnostics do not modify caller data or mark unacknowledged checkpoints successful',()=>{
  const events=Object.freeze([Object.freeze({type:0,eventStatus:1,syncToken:'input'})]);
  const response=Object.freeze({events,syncToken:'next'}),input=Object.freeze({response,cursor:'input',baseline:true,page:1});
  const result=squarePageDiagnostic(input);
  result.checkpointSucceeded=true;
  assert.equal(squarePageDiagnostic(input).checkpointSucceeded,false);
  assert.equal(response.syncToken,'next');assert.equal(events[0].syncToken,'input');
});
