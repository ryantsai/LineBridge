import {AsyncLocalStorage} from 'node:async_hooks';
import {rpcMetadata,retryAfterMs} from './rpc-metadata.mjs';
export {retryAfterMs,MAX_RETRY_AFTER_MS} from './rpc-metadata.mjs';

const diagnostics=new WeakMap();
export function rpcDiagnostic(error){return error&&typeof error==='object'?{...diagnostics.get(error)}:{};}

// Per-RPC ownership prevents arbitrary upstream exception properties becoming
// telemetry. Nested refresh/retry RPCs keep their own effective SDK deadline.
export function guardRpcTransport(client,{driverSignal,receiverSignal=()=>undefined,networkTransport='custom'}={}){
  const context=new AsyncLocalStorage(),request=client.request,core=request.requestCore.bind(request);
  request.requestCore=function(...args){
    const path=args[0],started=Date.now(),state={metadata:{
      endpointClass:path==='/SYNC4'?'talk_sync':['/S3','/S4'].includes(path)?'talk':['/SQ1','/SQS1'].includes(path)?'square':'other',
      rpcTransport:'plain',networkTransport,
      rpcTimeoutMs:args[8]??client.config.timeout,rpcTimeoutSource:args[8]===undefined?'sdk_default':'request'
    }};
    return context.run(state,async()=>{
      try{return await core(...args);}
      catch(error){
        const meta=state.metadata;
        if(!meta.timeoutOrigin){
          const code=error?.code??error?.cause?.code;
          const origin={UND_ERR_CONNECT_TIMEOUT:'connect',UND_ERR_HEADERS_TIMEOUT:'headers',UND_ERR_BODY_TIMEOUT:'body'}[code];
          if(origin)meta.timeoutOrigin=origin;
          else if(['TimeoutError','AbortError'].includes(error?.name))meta.timeoutOrigin='unknown';
        }
        if(meta.responseParse==='invalid_thrift'||meta.responseParse==='invalid_legy')error=new Error('LINE response could not be decoded');
        if(error&&typeof error==='object'&&!diagnostics.has(error))diagnostics.set(error,rpcMetadata({...meta,rpcDurationMs:Math.max(0,Date.now()-started)}));
        throw error;
      }finally{state.cleanup?.();}
    });
  };
  function observe(response,layer){
    const meta=context.getStore()?.metadata;if(!meta)return response;
    meta.responseLayer=layer;
    if(Number.isInteger(response.status)&&response.status>=100&&response.status<=599){meta.httpStatus=response.status;meta[`${layer}HttpStatus`]=response.status;}
    // A bounded 410 delay is evidence, not a successful poll or idle verdict.
    const retry=[410,429,503].includes(response.status)?retryAfterMs(response.headers.get('retry-after')):undefined;
    if(retry!==undefined){meta.retryAfterMs=retry;meta[`${layer}RetryAfterMs`]=retry;}else delete meta.retryAfterMs;
    const read=response.arrayBuffer.bind(response);
    response.arrayBuffer=async()=>{
      try{const body=await read();meta.responseEmpty=meta[`${layer}ResponseEmpty`]=body.byteLength===0;return body;}
      catch(error){meta.responseParse='body_read_failed';throw error;}
    };
    return response;
  }
  async function checkedResponse(response,layer){
    observe(response,layer);
    if(response.status<200||response.status>=300){
      const meta=context.getStore()?.metadata,reader=response.body?.getReader();
      try{const first=reader?await reader.read():{done:true};if(meta)meta.responseEmpty=meta[`${layer}ResponseEmpty`]=first.done&&!first.value?.byteLength;}
      catch{if(meta)meta.responseParse='body_read_failed';}
      // Neither error bytes nor raw headers leave this boundary. Do not await
      // arbitrary upstream cancellation after the first bounded observation.
      finally{void reader?.cancel().catch(()=>{});}
      throw Object.assign(new Error('LINE HTTP request failed'),{name:'RequestError'});
    }
    return response;
  }
  const fetch=client.fetch.bind(client);
  client.fetch=async(...args)=>{
    const state=context.getStore(),signal=args[0]?.signal,receiver=receiverSignal();
    const signals=[[driverSignal,'driver_stop'],[receiver,'receiver_cancel'],[signal,'rpc_deadline']];
    // Capture the first observed abort, not a guess based on elapsed time.
    const listeners=signals.filter(([s])=>s).map(([s,origin])=>{
      const record=()=>{if(state&&!state.metadata.timeoutOrigin)state.metadata.timeoutOrigin=s===receiver&&s.reason?.name==='TimeoutError'?'receiver_deadline':origin;};
      if(s.aborted)record();else s.addEventListener('abort',record,{once:true});return [s,record];
    });
    // Keep attribution alive through body reads and LEGY decoding.
    if(state)state.cleanup=()=>{for(const [s,record] of listeners)s.removeEventListener('abort',record);};
    try{return await checkedResponse(await fetch(...args),'outer');}
    finally{if(!state)for(const [s,record] of listeners)s.removeEventListener('abort',record);}
  };
  const legy=request.legyTransport,encrypted=legy.fetch.bind(legy);
  legy.fetch=async(inner,fetcher,options)=>{
    const meta=context.getStore()?.metadata;if(meta)meta.rpcTransport='legy';
    try{
      const response=await encrypted(inner,fetcher,options);
      inner.signal.throwIfAborted();
      // LineJS passes through an empty outer body without decoding a frame.
      // Do not invent an inner response in that case.
      return meta?.outerResponseEmpty===true?response:await checkedResponse(response,'inner');
    }catch(error){
      if(meta?.outerHttpStatus>=200&&meta.outerHttpStatus<300&&meta.responseLayer!=='inner'&&!inner.signal.aborted&&!['AbortError','TimeoutError'].includes(error?.name)&&!meta.responseParse)meta.responseParse='invalid_legy';
      throw error;
    }
  };
  const readThrift=client.thrift.readThrift.bind(client.thrift);
  client.thrift.readThrift=(...args)=>{
    try{return readThrift(...args);}
    catch(error){const meta=context.getStore()?.metadata;if(meta)meta.responseParse='invalid_thrift';throw error;}
  };
}
