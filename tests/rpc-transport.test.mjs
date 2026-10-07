import test from 'node:test';
import assert from 'node:assert/strict';
import {LineDriver} from '../server/drivers.mjs';
import {rpcDiagnostic,retryAfterMs,MAX_RETRY_AFTER_MS} from '../server/rpc-transport.mjs';
import {monitorRetryMs} from '../server/monitor-policy.mjs';
import {pollDiagnostic} from '../protocol/monitor.mjs';
import {debugDetails} from '../server/debug-logging.mjs';

function driver(t,fetch,encrypted=false){
  const d=new LineDriver({device:'IOSIPAD'},{},{fault:()=>{}},{fetch});t.after(()=>d.stop());
  d.client.legy.encrypted=encrypted;d.client.authToken='synthetic-token-only';return d;
}
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
