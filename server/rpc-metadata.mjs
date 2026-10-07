// One allowlist for transport failures and optional debug records. Never copy
// upstream headers, URLs, bodies, exception text, or token rotation metadata.
export const MAX_RETRY_AFTER_MS=300000;
export function retryAfterMs(value,now=Date.now()){
  if(typeof value!=='string'||value.length>80)return undefined;
  const seconds=/^\d{1,10}$/.test(value)?Number(value):undefined;
  const date=/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)?Date.parse(value):NaN;
  const ms=seconds===undefined?date-now:seconds*1000;
  return Number.isFinite(ms)?Math.min(MAX_RETRY_AFTER_MS,Math.max(0,ms)):undefined;
}
export function rpcMetadata(value={}){
  const safe={};
  for(const key of ['httpStatus','outerHttpStatus','innerHttpStatus'])if(Number.isInteger(value[key])&&value[key]>=100&&value[key]<=599)safe[key]=value[key];
  for(const key of ['responseEmpty','outerResponseEmpty','innerResponseEmpty'])if(typeof value[key]==='boolean')safe[key]=value[key];
  for(const key of ['rpcDurationMs','rpcTimeoutMs'])if(Number.isFinite(value[key])&&value[key]>=0)safe[key]=Math.min(Number.MAX_SAFE_INTEGER,Math.floor(value[key]));
  for(const key of ['retryAfterMs','outerRetryAfterMs','innerRetryAfterMs'])if(Number.isFinite(value[key])&&value[key]>=0)safe[key]=Math.min(MAX_RETRY_AFTER_MS,Math.floor(value[key]));
  const enums={
    responseParse:['invalid_thrift','invalid_legy','body_read_failed'],
    responseLayer:['outer','inner'],
    rpcTransport:['plain','legy'],
    endpointClass:['talk_sync','talk','square','other'],
    networkTransport:['http1','custom'],
    rpcTimeoutSource:['request','sdk_default'],
    timeoutOrigin:['rpc_deadline','receiver_deadline','receiver_cancel','driver_stop','connect','headers','body','unknown']
  };
  for(const [key,allowed] of Object.entries(enums))if(allowed.includes(value[key]))safe[key]=value[key];
  return safe;
}
