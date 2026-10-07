import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';
import {Protocols,LINEStruct} from '@evex/linejs/thrift';
import {encodeLegyHeaders} from '../node_modules/@evex/linejs/base/request/legy.js';
import {LineDriver} from '../server/drivers.mjs';
import {rpcDiagnostic,retryAfterMs,MAX_RETRY_AFTER_MS} from '../server/rpc-transport.mjs';
import {monitorRetryMs} from '../server/monitor-policy.mjs';
import {LiveMonitor,pollDiagnostic} from '../protocol/monitor.mjs';
import {debugDetails} from '../server/debug-logging.mjs';

function driver(t,fetch,encrypted=false){
  const d=new LineDriver({device:'IOSIPAD'},{},{fault:()=>{}},{fetch});t.after(()=>d.stop());
  d.client.legy.encrypted=encrypted;d.client.authToken='synthetic-token-only';return d;
}
function legyDriver(t,respond){
  // Known ephemeral test key allows real encrypted frames through the pinned
  // SDK decoder. Restore Node's random source immediately after construction.
  const key=Buffer.alloc(16,0x21),original=crypto.randomBytes;
  const random=t.mock.method(crypto,'randomBytes',size=>size===16?Buffer.from(key):original(size));syncBuiltinESMExports();
  const frame=(body,headers)=>{
    const cipher=crypto.createCipheriv('aes-128-cbc',key,Buffer.from([78,9,72,62,56,245,255,114,128,18,123,158,251,92,45,51]));
    return Buffer.concat([cipher.update(Buffer.concat([Buffer.from([7]),encodeLegyHeaders(headers),Buffer.from(body)])),cipher.final()]);
  };
  try{return driver(t,(...args)=>respond(frame,...args),true);}
  finally{random.mock.restore();syncBuiltinESMExports();}
}
const emptyTalk=client=>client.thrift.writeThrift([[12,0,[[12,1,[[15,1,[12,[]]]]]]]],'sync',Protocols[4]);
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('actual SDK plain and LEGY requests retain their deadline, including response body reads',async t=>{
  for(const encrypted of [false,true])for(const bodyPending of [false,true]){
    let seen;
    const d=driver(t,async(_url,{signal})=>{
      seen=signal;
      if(bodyPending)return new Response(new ReadableStream({start(controller){signal.addEventListener('abort',()=>controller.error(signal.reason),{once:true});}}));
      return new Promise((_resolve,reject)=>{signal.throwIfAborted();signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
    },encrypted);
    const keepAlive=setTimeout(()=>{},1000);
    try{await assert.rejects(d.client.talk.sync({revision:1,timeout:25}),error=>{assert.equal(error.name,'TimeoutError');assert.equal(pollDiagnostic(error,'poll',25,25,2000).kind,'timeout');return true;});assert.ok(seen.aborted);}
    finally{clearTimeout(keepAlive);}
  }
});
test('HTTP empty 200 and malformed thrift remain failures with safe, per-request metadata',async t=>{
  const secret='SYNTHETIC_PRIVATE_HEADER_BODY';let count=0;
  const d=driver(t,async()=>++count===1?new Response(null,{status:200,headers:{'x-secret':secret}}):new Response(secret,{status:200,headers:{'x-secret':secret}}));
  for(const expectedEmpty of [true,false])await assert.rejects(d.client.talk.sync({revision:1,timeout:1000}),error=>{
    const safe=pollDiagnostic(error,'poll',1,1000,2000);
    assert.equal(safe.httpStatus,200);assert.equal(safe.responseEmpty,expectedEmpty);assert.equal(safe.responseParse,'invalid_thrift');assert.equal(safe.kind,'protocol');assert.ok(safe.rpcDurationMs>=0);
    assert.ok(!JSON.stringify(safe).includes(secret));assert.ok(!error.message.includes(secret));assert.ok(!error.message.includes('headers='));
    assert.deepEqual(debugDetails({httpStatus:safe.httpStatus,responseEmpty:safe.responseEmpty,responseParse:safe.responseParse,headers:secret,body:secret}),{httpStatus:200,responseParse:'invalid_thrift',responseEmpty:expectedEmpty});return true;
  });
});
test('HTTP failures are classified before SDK parsing; only 429/503 carry bounded Retry-After',async t=>{
  for(const encrypted of [false,true])for(const status of [302,429,503]){
    const d=driver(t,async()=>new Response('SYNTHETIC_SECRET',{status,headers:{'retry-after':'9999999999','x-secret':'SYNTHETIC_SECRET'}}),encrypted);
    await assert.rejects(d.client.talk.sync({revision:1,timeout:1000}),error=>{
      const safe=pollDiagnostic(error,'poll',1,1000,2000);assert.equal(safe.httpStatus,status);assert.equal(safe.responseEmpty,false);assert.equal(safe.retryAfterMs,status===302?undefined:300000);assert.equal(safe.kind,status===429?'rate_limit':'http');assert.equal(safe.responseParse,undefined);assert.ok(!JSON.stringify(safe).includes('SYNTHETIC_SECRET'));return true;
    });
  }
});

test('real LEGY inner 429/503 behind outer 200 cannot ACK Talk and enforce Retry-After',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.parse('2026-10-07T00:00:00Z')});
  for(const status of [429,503]){
    let innerStatus=200,calls=0,checkpoints=0;
    const d=legyDriver(t,frame=>{calls++;return new Response(frame(emptyTalk(d.client),{'x-lc':String(innerStatus),'retry-after':'120','x-secret':'SYNTHETIC_PRIVATE_HEADER'}),{status:200});});
    assert.deepEqual((await d.client.talk.sync({revision:1,timeout:1000})).operationResponse.operations,[],'the encrypted payload is a valid successful Thrift response');
    innerStatus=status;
    d.storage={get:async()=>({revision:1}),set:async()=>{checkpoints++;}};
    const states=[],m=new LiveMonitor(d,(_event,state)=>states.push(state),()=>assert.fail('No capture from rejected HTTP'),{random:()=>0});
    t.after(async()=>{m.stop();await m.done();});m.update([{id:'synthetic',kind:'group'}]);
    t.mock.timers.tick(1000);await flush();
    assert.equal(calls,2);assert.equal(checkpoints,0);assert.equal(states.at(-1).lastSuccessAt,null);
    const diagnostic=states.at(-1).lastFailure;
    assert.equal(diagnostic.httpStatus,status);assert.equal(diagnostic.kind,status===429?'rate_limit':'http');assert.equal(diagnostic.retryAfterMs,120000);assert.equal(diagnostic.retryInMs,120000);assert.equal(diagnostic.responseParse,undefined);assert.equal(diagnostic.responseEmpty,false);
    assert.ok(!JSON.stringify(states).includes('SYNTHETIC_PRIVATE_HEADER'));
    t.mock.timers.tick(119999);await flush();assert.equal(calls,2);
    innerStatus=200;t.mock.timers.tick(1);await flush();assert.equal(calls,3);assert.equal(checkpoints,1);assert.ok(states.at(-1).lastSuccessAt);
    m.stop();await m.done();
  }
});

test('documented upstream limitation: a refreshed Talk RPC falls back to the SDK 30-second timeout',async t=>{
  let calls=0,refreshes=0;
  const d=driver(t,async()=>new Response(++calls===1
    ?d.client.thrift.writeThrift([[12,1,LINEStruct.TalkException({code:'MUST_REFRESH_V3_TOKEN',reason:'synthetic'})]],'sync',Protocols[4])
    :emptyTalk(d.client)));
  d.client.storage={get:async key=>key==='refreshToken'?'synthetic-refresh':undefined};
  d.client.auth.tryRefreshToken=async()=>{refreshes++;};d.client.config.timeout=30000;
  const timeout=AbortSignal.timeout,budgets=[];t.mock.method(AbortSignal,'timeout',ms=>{budgets.push(ms);return timeout(ms);});
  assert.deepEqual((await d.client.talk.sync({revision:1,timeout:180000})).operationResponse.operations,[]);
  assert.equal(calls,2);assert.equal(refreshes,1);assert.deepEqual(budgets,[180000,30000]);
});
test('sanitized transport metadata cannot be supplied by arbitrary upstream error properties',()=>{
  const error=Object.assign(new Error('private'),{httpStatus:429,retryAfterMs:9999999999,responseEmpty:true,responseParse:'private'});
  assert.deepEqual(rpcDiagnostic(error),{});assert.equal(pollDiagnostic(error,'poll',1,1000,2000).httpStatus,undefined);
});
test('Retry-After accepts delta seconds and IMF-fixdate, bounds values, and ignores malformed text',()=>{
  const now=Date.parse('2026-10-07T00:00:00Z');
  assert.equal(retryAfterMs('12',now),12000);assert.equal(retryAfterMs('Wed, 07 Oct 2026 00:00:25 GMT',now),25000);
  assert.equal(retryAfterMs('Tue, 06 Oct 2026 23:59:59 GMT',now),0);assert.equal(retryAfterMs('9999999999'),MAX_RETRY_AFTER_MS);
  for(const invalid of ['secret','-2','1.5','Infinity','2026-10-07','9'.repeat(100),null])assert.equal(retryAfterMs(invalid,now),undefined);
  assert.equal(monitorRetryMs(0,0,()=>0),2000);assert.equal(monitorRetryMs(0,0,()=>1),2400);assert.equal(monitorRetryMs(99,0,()=>1),30000);assert.equal(monitorRetryMs(0,120000,()=>1),120000);
});
test('actual LEGY receiver cancellation is isolated from concurrent plain profile requests',async t=>{
  const pending=[];
  const d=driver(t,async(_url,{signal})=>new Promise((_resolve,reject)=>{pending.push(signal);signal.addEventListener('abort',()=>reject(signal.reason),{once:true});}),true);
  const controller=new AbortController(),poll=d.monitorRequest(controller.signal,()=>d.client.talk.sync({revision:1,timeout:1000}));
  const assertion=assert.rejects(poll,{name:'AbortError'});
  while(!pending.length)await new Promise(resolve=>setImmediate(resolve));
  d.client.legy.encrypted=false;
  const other=d.client.talk.getProfile(),otherAssertion=assert.rejects(other,{name:'AbortError'});
  while(pending.length<2)await new Promise(resolve=>setImmediate(resolve));
  controller.abort();await assertion;assert.equal(pending[1].aborted,false);d.stop();await otherAssertion;
});
