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
    try{await assert.rejects(d.client.talk.sync({revision:1,timeout:25}),error=>{assert.equal(error.name,'TimeoutError');assert.equal(pollDiagnostic(error,'poll',25,25,2000).kind,'timeout');assert.equal(rpcDiagnostic(error).timeoutOrigin,'rpc_deadline');assert.equal(rpcDiagnostic(error).rpcTimeoutMs,25);return true;});assert.ok(seen.aborted);}
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
test('HTTP failures are classified before SDK parsing; only 410/429/503 carry bounded Retry-After',async t=>{
  for(const encrypted of [false,true])for(const status of [302,400,410,429,503]){
    const d=driver(t,async()=>new Response('SYNTHETIC_SECRET',{status,headers:{'retry-after':'9999999999','x-secret':'SYNTHETIC_SECRET'}}),encrypted);
    await assert.rejects(d.client.talk.sync({revision:1,timeout:1000}),error=>{
      const safe=pollDiagnostic(error,'poll',1,1000,2000);assert.equal(safe.httpStatus,status);assert.equal(safe.outerHttpStatus,status);assert.equal(safe.innerHttpStatus,undefined);assert.equal(safe.responseEmpty,false);assert.equal(safe.retryAfterMs,[410,429,503].includes(status)?300000:undefined);assert.equal(safe.kind,status===429?'rate_limit':'http');assert.equal(safe.responseParse,undefined);assert.ok(!JSON.stringify(safe).includes('SYNTHETIC_SECRET'));return true;
    });
  }
});

test('real LEGY inner 410/429/503 behind outer 200 cannot ACK Talk and enforce Retry-After',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.parse('2026-10-07T00:00:00Z')});
  for(const status of [410,429,503]){
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
    assert.equal(diagnostic.outerHttpStatus,200);assert.equal(diagnostic.innerHttpStatus,status);assert.equal(diagnostic.responseLayer,'inner');assert.equal(diagnostic.outerResponseEmpty,false);assert.equal(diagnostic.innerResponseEmpty,false);
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
  const assertion=assert.rejects(poll,error=>{assert.equal(error.name,'AbortError');assert.equal(rpcDiagnostic(error).timeoutOrigin,'receiver_cancel');return true;});
  while(!pending.length)await new Promise(resolve=>setImmediate(resolve));
  d.client.legy.encrypted=false;
  const other=d.client.talk.getProfile(),otherAssertion=assert.rejects(other,error=>{assert.equal(error.name,'AbortError');assert.equal(rpcDiagnostic(error).timeoutOrigin,'driver_stop');return true;});
  while(pending.length<2)await new Promise(resolve=>setImmediate(resolve));
  controller.abort();await assertion;assert.equal(pending[1].aborted,false);d.stop();await otherAssertion;
});

test('110-second empty HTTP 410 preserves the 180-second budget without inferring idle success or timeout',async t=>{
  const now=Date.parse('2026-10-07T00:00:00Z'),secret='SYNTHETIC_PRIVATE_SENTINEL';
  t.mock.timers.enable({apis:['Date'],now});
  for(const encrypted of [false,true]){
    t.mock.timers.setTime(now);
    const d=driver(t,async()=>{t.mock.timers.setTime(now+110000);return new Response(null,{status:410,headers:{'retry-after':'12','x-line-next-access':secret,'x-secret':secret}});},encrypted);
    let rotations=0;d.client.on('update:authtoken',()=>rotations++);
    await assert.rejects(d.client.talk.sync({revision:1,timeout:180000}),error=>{
      const safe=pollDiagnostic(error,'poll',110000,180000,2000);
      assert.equal(safe.kind,'http');assert.equal(safe.httpStatus,410);assert.equal(safe.outerHttpStatus,410);assert.equal(safe.innerHttpStatus,undefined);
      assert.equal(safe.responseEmpty,true);assert.equal(safe.outerResponseEmpty,true);assert.equal(safe.innerResponseEmpty,undefined);
      assert.equal(safe.rpcDurationMs,110000);assert.equal(safe.rpcTimeoutMs,180000);assert.equal(safe.rpcTimeoutSource,'request');assert.equal(safe.timeoutOrigin,undefined);
      assert.equal(safe.endpointClass,'talk_sync');assert.equal(safe.rpcTransport,encrypted?'legy':'plain');assert.equal(safe.networkTransport,'custom');
      assert.equal(safe.retryAfterMs,12000);assert.equal(safe.outerRetryAfterMs,12000);
      const debug=debugDetails({...safe,headers:secret,body:secret,endpoint:secret,'x-line-next-access':secret});
      assert.equal(debug.outerHttpStatus,410);assert.equal(debug.rpcTimeoutMs,180000);assert.ok(!JSON.stringify(debug).includes(secret));return true;
    });
    assert.equal(rotations,0);
  }
});
test('empty decoded LEGY 410 differs from empty outer 200 and invalid LEGY',async t=>{
  const d=legyDriver(t,frame=>new Response(frame('',{'x-lc':'410'}),{status:200}));
  await assert.rejects(d.client.talk.sync({revision:1}),error=>{
    const meta=rpcDiagnostic(error);assert.equal(meta.outerResponseEmpty,false);assert.equal(meta.innerResponseEmpty,true);assert.equal(meta.responseEmpty,true);assert.equal(meta.innerHttpStatus,410);assert.equal(meta.responseParse,undefined);return true;
  });
  for(const body of [null,'SYNTHETIC_PRIVATE_BAD_LEGY']){
    const other=driver(t,async()=>new Response(body),true);
    await assert.rejects(other.client.talk.sync({revision:1}),error=>{
      const meta=rpcDiagnostic(error);assert.equal(meta.outerHttpStatus,200);assert.equal(meta.innerHttpStatus,undefined);assert.equal(meta.outerResponseEmpty,body===null);assert.equal(meta.responseParse,body===null?'invalid_thrift':'invalid_legy');assert.ok(!error.message.includes('SYNTHETIC_PRIVATE'));return true;
    });
  }
});
test('a failed refreshed RPC reports the actual SDK fallback budget, not the original poll budget',async t=>{
  let calls=0;
  const d=driver(t,async()=>++calls===1?new Response(d.client.thrift.writeThrift([[12,1,LINEStruct.TalkException({code:'MUST_REFRESH_V3_TOKEN',reason:'synthetic'})]],'sync',Protocols[4])):new Response(null,{status:410}));
  d.client.storage={get:async()=> 'synthetic-refresh'};d.client.auth.tryRefreshToken=async()=>{};d.client.config.timeout=30000;
  await assert.rejects(d.client.talk.sync({revision:1,timeout:180000}),error=>{const meta=rpcDiagnostic(error);assert.equal(meta.rpcTimeoutMs,30000);assert.equal(meta.rpcTimeoutSource,'sdk_default');assert.equal(meta.outerHttpStatus,410);return true;});
});
test('transport timeouts retain an allowlisted origin while arbitrary metadata is dropped',async t=>{
  for(const [code,origin] of [['UND_ERR_CONNECT_TIMEOUT','connect'],['UND_ERR_HEADERS_TIMEOUT','headers'],['UND_ERR_BODY_TIMEOUT','body']]){
    const d=driver(t,async()=>{throw Object.assign(new TypeError('SYNTHETIC_PRIVATE'),{cause:{code}});});
    await assert.rejects(d.client.talk.sync({revision:1}),error=>{assert.equal(rpcDiagnostic(error).timeoutOrigin,origin);return true;});
  }
  assert.deepEqual(debugDetails({outerHttpStatus:999,innerHttpStatus:'410',rpcTransport:'SYNTHETIC_PRIVATE',timeoutOrigin:'SYNTHETIC_PRIVATE',endpointClass:'https://private',rpcTimeoutMs:Infinity,outerResponseEmpty:'private'}),{});
});

test('a receiver deadline is attributed separately from the RPC transport budget',async t=>{
  const d=driver(t,async(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true})),true);
  const keepAlive=setTimeout(()=>{},1000);
  try{await assert.rejects(d.monitorRequest(AbortSignal.timeout(25),()=>d.client.talk.sync({revision:1,timeout:1000})),error=>{
    const meta=rpcDiagnostic(error);assert.equal(error.name,'TimeoutError');assert.equal(meta.timeoutOrigin,'receiver_deadline');assert.equal(meta.rpcTimeoutMs,1000);return true;
  });}finally{clearTimeout(keepAlive);}
});
