import {AsyncLocalStorage} from 'node:async_hooks';

const diagnostics=new WeakMap();
export const MAX_RETRY_AFTER_MS=300000;
export function retryAfterMs(value,now=Date.now()){
  if(typeof value!=='string'||value.length>80)return undefined;
  const seconds=/^\d{1,10}$/.test(value)?Number(value):undefined;
  const date=/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)?Date.parse(value):NaN;
  const ms=seconds===undefined?date-now:seconds*1000;
  return Number.isFinite(ms)?Math.min(MAX_RETRY_AFTER_MS,Math.max(0,ms)):undefined;
}
export function rpcDiagnostic(error){return error&&typeof error==='object'?diagnostics.get(error)??{}:{};}

// Per-RPC metadata, not SDK log strings (those contain credentials and bodies).
// WeakMap ownership prevents arbitrary upstream exception properties becoming telemetry.
export function guardRpcTransport(client){
  const context=new AsyncLocalStorage(),request=client.request,core=request.requestCore.bind(request);
  request.requestCore=function(...args){
    const state={},started=Date.now();
    return context.run(state,async()=>{
      try{return await core(...args);}
      catch(error){
        if(state.responseParse==='invalid_thrift'||state.responseParse==='invalid_legy')error=new Error('LINE response could not be decoded');
        if(error&&typeof error==='object'&&!diagnostics.has(error))diagnostics.set(error,{...state,rpcDurationMs:Math.max(0,Date.now()-started)});
        throw error;
      }
    });
  };
  function observe(response){
    const state=context.getStore();if(!state)return response;
    if(Number.isInteger(response.status)&&response.status>=100&&response.status<=599)state.httpStatus=response.status;
    const retry=[429,503].includes(response.status)?retryAfterMs(response.headers.get('retry-after')):undefined;
    if(retry!==undefined)state.retryAfterMs=retry;else delete state.retryAfterMs;
    const read=response.arrayBuffer.bind(response);
    response.arrayBuffer=async()=>{
      try{const body=await read();state.responseEmpty=body.byteLength===0;return body;}
      catch(error){state.responseParse='body_read_failed';throw error;}
    };
    return response;
  }
  const fetch=client.fetch.bind(client);
  client.fetch=async(...args)=>{
    const response=observe(await fetch(...args));
    if(response.status<200||response.status>=300){
      // Do not feed an HTTP error body to the SDK (its parse error embeds it).
      // Inspect at most the first chunk to distinguish empty; discard the rest.
      const state=context.getStore(),reader=response.body?.getReader();
      try{const first=reader?await reader.read():{done:true};if(state)state.responseEmpty=first.done&&!first.value?.byteLength;}
      catch{if(state)state.responseParse='body_read_failed';}
      finally{try{await reader?.cancel();}catch{}}
      throw Object.assign(new Error('LINE HTTP request failed'),{name:'RequestError'});
    }
    return response;
  };
  const legy=request.legyTransport,encrypted=legy.fetch.bind(legy);
  legy.fetch=async(inner,fetcher,options)=>{
    try{
      // LineJS 3.4.2 forwards the original signal itself. Observe its decoded
      // response without rebuilding Requests or patching dependency source.
      const response=await encrypted(inner,fetcher,options);
      inner.signal.throwIfAborted();return observe(response);
    }catch(error){
      const state=context.getStore();
      if(state?.httpStatus>=200&&state.httpStatus<300&&!inner.signal.aborted&&!['AbortError','TimeoutError'].includes(error?.name)&&!state.responseParse)state.responseParse='invalid_legy';
      throw error;
    }
  };
  const readThrift=client.thrift.readThrift.bind(client.thrift);
  client.thrift.readThrift=(...args)=>{
    try{return readThrift(...args);}
    catch(error){const state=context.getStore();if(state)state.responseParse='invalid_thrift';throw error;}
  };
}
