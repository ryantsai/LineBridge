import {z} from 'zod';
import {publicError} from './errors.mjs';

const settingsInput=z.object({enabled:z.boolean()}).strict();
const numericFields=['durationMs','accounts','connected','monitoring','storedMessages','messages','intervalSeconds','pollTimeoutMs','retryInMs','rpcDurationMs'];
const enums={
  channel:['talk','openchat'],
  status:['polling','running','initializing','retrying','stopped','healthy','auth_invalid'],
  failureKind:['timeout','cancelled','network','protocol','storage','capture','auth','service','http','rate_limit','unknown'],
  responseParse:['invalid_thrift','invalid_legy','body_read_failed'],
  stage:['initialize','poll','process','decrypt','resolve_names','capture','checkpoint']
};

// Debug records contain bounded operational metadata, never response bodies,
// messages, credentials, cursors, URLs, stacks, or arbitrary upstream strings.
export function debugDetails(value={}){
  const safe={};
  for(const field of numericFields)if(Number.isFinite(value[field])&&value[field]>=0)safe[field]=Math.min(Number.MAX_SAFE_INTEGER,Math.floor(value[field]));
  if(Number.isInteger(value.httpStatus)&&value.httpStatus>=100&&value.httpStatus<=599)safe.httpStatus=value.httpStatus;
  if(Number.isFinite(value.retryAfterMs)&&value.retryAfterMs>=0)safe.retryAfterMs=Math.min(300000,Math.floor(value.retryAfterMs));
  for(const [field,allowed] of Object.entries(enums))if(allowed.includes(value[field]))safe[field]=value[field];
  if(typeof value.gatewayEnabled==='boolean')safe.gatewayEnabled=value.gatewayEnabled;
  if(typeof value.responseEmpty==='boolean')safe.responseEmpty=value.responseEmpty;
  if(typeof value.lastSuccessAt==='string'&&Number.isFinite(Date.parse(value.lastSuccessAt)))safe.lastSuccessAt=new Date(value.lastSuccessAt).toISOString();
  return safe;
}

export class DebugLogging {
  constructor(store){this.store=store;}
  settings(){return {enabled:this.store.setting('debugLoggingEnabled',false)===true};}
  configure(value){
    const settings=settingsInput.parse(value);
    this.store.transaction(()=>{
      this.store.setSetting('debugLoggingEnabled',settings.enabled);
      this.store.audit('local-admin','debug.toggle',null,null,settings.enabled?'enabled':'disabled');
    });
    return settings;
  }
  record(action,outcome,details,accountId=null,chatId=null){
    // Optional diagnostics must not interrupt reception if their write fails.
    try{if(this.settings().enabled)this.store.audit('system',`debug.${action}`,accountId,chatId,outcome,debugDetails(details));}catch{}
  }
  refresh(startedAt,state,error){
    this.record('refresh',error?'failed':'ok',{
      durationMs:Date.now()-startedAt,
      ...(error?{failureKind:'service',httpStatus:publicError(error).status}:{
        accounts:state.accounts.length,connected:state.accounts.filter(a=>a.status==='connected').length,
        monitoring:state.accounts.filter(a=>a.monitor?.enabled).length,
        storedMessages:state.accounts.reduce((sum,a)=>sum+(a.monitor?.storedMessages??0),0),
        gatewayEnabled:state.gateway.enabled,intervalSeconds:state.refresh.intervalSeconds
      })
    });
  }
  poll(accountId,stream,previous){
    if(!enums.status.includes(stream.status))return;
    // Pagination diagnostics can repeat a status without another poll.
    if(previous&&['status','lastPoll','lastAttemptAt','lastSuccessAt'].every(key=>previous[key]===stream[key])&&previous.lastFailure?.at===stream.lastFailure?.at)return;
    const failed=stream.status==='retrying',pending=stream.status==='polling';
    this.record('poll',failed?'failed':pending?'polling':stream.status==='stopped'?'stopped':'ok',{
      channel:stream.channel==='talk'?'talk':'openchat',status:stream.status,
      durationMs:pending?undefined:failed?stream.lastFailure?.elapsedMs:Date.parse(stream.lastPoll)-Date.parse(stream.lastAttemptAt),
      pollTimeoutMs:stream.pollTimeoutMs,lastSuccessAt:stream.lastSuccessAt,
      ...(failed?{failureKind:stream.lastFailure?.kind??'unknown',stage:stream.lastFailure?.stage,retryInMs:stream.lastFailure?.retryInMs,httpStatus:stream.lastFailure?.httpStatus,responseEmpty:stream.lastFailure?.responseEmpty,responseParse:stream.lastFailure?.responseParse,rpcDurationMs:stream.lastFailure?.rpcDurationMs,retryAfterMs:stream.lastFailure?.retryAfterMs}:{})
    },accountId,stream.channel==='talk'?null:stream.channel);
  }
}
