import {normalizeMessage,squareMessages} from '../server/drivers.mjs';
import timers from 'node:timers/promises';
import {TALK_POLL_TIMEOUT_MS} from '../server/monitor-policy.mjs';

export function talkChatId(message,ownMid){
  return message.to===ownMid ? String(message.from ?? '') : String(message.to ?? '');
}
export function nextTalkCursor(previous,response){
  const result={...previous},op=response.operationResponse;
  if(response.fullSyncResponse?.nextRevision!=null)result.revision=response.fullSyncResponse.nextRevision;
  if(op?.globalEvents?.lastRevision!=null)result.globalRev=op.globalEvents.lastRevision;
  if(op?.individualEvents?.lastRevision!=null)result.individualRev=op.individualEvents.lastRevision;
  for(const event of op?.operations ?? [])if(event.revision!=null)result.revision=event.revision;
  return result;
}
const pause=(ms,signal)=>timers.setTimeout(ms,undefined,{signal}).catch(error=>{if(!signal.aborted)throw error;});
const errorNames=new Set(['Error','TimeoutError','AbortError','TypeError','RequestError','ClientClosed']);
const networkCodes=new Set(['ECONNRESET','ECONNREFUSED','ETIMEDOUT','ENOTFOUND','EAI_AGAIN','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_SOCKET']);
const protocolCodes=new Set(['NOT_AUTHORIZED_DEVICE','AUTHENTICATION_FAILED','NOT_AUTHORIZED','FORBIDDEN','NOT_FOUND','INTERNAL_ERROR','INVALID_PARAMETER','MUST_REFRESH_V3_TOKEN','EXCESSIVE_ACCESS','NOT_IMPLEMENTED','UNKNOWN']);
export function pollDiagnostic(error,stage,elapsedMs,pollTimeoutMs,retryInMs){
  // Never copy messages, stacks, URLs, headers, payloads, or arbitrary codes.
  // In particular, SDK parse failures embed raw response headers and bodies.
  const errorName=errorNames.has(error?.name)?error.name:'UnknownError';
  const candidate=error?.code??error?.cause?.code;
  const upstream=error?.data?.errorCode??error?.data?.code;
  const code=networkCodes.has(candidate)?candidate:protocolCodes.has(upstream)?upstream:undefined;
  const kind=stage==='checkpoint'?'storage':stage==='capture'?'capture':errorName==='TimeoutError'?'timeout':errorName==='AbortError'||errorName==='ClientClosed'?'cancelled':networkCodes.has(code)?'network':errorName==='RequestError'?'protocol':'unknown';
  return {kind,stage,errorName,...(code?{code}:{}),elapsedMs,pollTimeoutMs,retryInMs};
}

// Bounded polling avoids the library's unhandled push-loop failures. There are
// no read receipts or send calls in this listener. Cursors advance after durable ACK.
export class LiveMonitor {
  constructor(driver,event,capture){this.driver=driver;this.event=event;this.capture=capture;this.active=true;this.abort=new AbortController();this.allowed=new Map();this.rooms=new Map();this.pollStates=new Map();this.talkTask=this.talkLoop();}
  update(chats){
    this.allowed=new Map(chats.map(c=>[c.id,c]));
    for(const [id,room] of this.rooms)if(!this.allowed.has(id)){room.active=false;room.abort.abort();this.rooms.delete(id);this.status(id,'stopped');}
    for(const chat of chats)if(chat.kind==='openchat'&&!this.rooms.has(chat.id)){const room={active:true,fresh:this.initialized,abort:new AbortController()};this.pollStates.delete(chat.id);this.rooms.set(chat.id,room);room.task=this.squareLoop(chat.id,room);}this.initialized=true;
  }
  stop(){this.active=false;this.abort.abort();for(const room of this.rooms.values()){room.active=false;room.abort.abort();}}
  request(signal,operation){signal.throwIfAborted();return this.driver.monitorRequest?this.driver.monitorRequest(signal,operation):operation();}
  status(channel,status,error,success=false,details={}){
    if(!this.active)return;
    const now=new Date().toISOString(),previous=this.pollStates.get(channel);
    const state={channel,status,error:success?undefined:error??previous?.error,lastPoll:now,
      lastAttemptAt:status==='polling'?now:previous?.lastAttemptAt??null,
      lastSuccessAt:success?now:previous?.lastSuccessAt??null,
      ready:success?status==='running':previous?.ready??false,
      pollTimeoutMs:details.pollTimeoutMs??previous?.pollTimeoutMs??null,
      pollDeadlineAt:status==='polling'&&details.pollTimeoutMs?new Date(Date.parse(now)+details.pollTimeoutMs).toISOString():null,
      lastFailure:details.diagnostic?{at:now,...details.diagnostic}:previous?.lastFailure??null};
    this.pollStates.set(channel,state);this.event('monitor_status',state);
  }
  async talkLoop(){
    let cursor,retries=0;
    const signal=this.abort.signal;
    while(this.active){
      if(![...this.allowed.values()].some(c=>c.kind!=='openchat')){await pause(1000,signal);continue;}
      let stage='initialize',startedAt=Date.now(),timeoutMs=this.driver.client.config?.timeout??30000;
      try{
        if(!cursor){cursor=await this.driver.storage.get('monitor.talk');if(!cursor){const revision=await this.request(signal,()=>this.driver.client.request.request([],'getLastOpRevision',4,false,'/S4'));if(!['number','bigint'].includes(typeof revision))throw new Error('revision_unavailable');cursor={revision,globalRev:0,individualRev:0};}}
        stage='poll';startedAt=Date.now();timeoutMs=TALK_POLL_TIMEOUT_MS;
        this.status('talk','polling',undefined,false,{pollTimeoutMs:timeoutMs});
        const response=await this.request(signal,()=>this.driver.client.talk.sync({...cursor,limit:100,timeout:timeoutMs}));
        if(!this.active)break;
        for(const operation of response.operationResponse?.operations ?? []){
          if(!['SEND_MESSAGE','RECEIVE_MESSAGE',25,26].includes(operation.type)||!operation.message)continue;
          const raw=operation.message,chatId=talkChatId(raw,this.driver.client.profile.mid);
          if(!this.active||!this.allowed.has(chatId))continue;
          let message;
          stage='decrypt';try{message=normalizeMessage(await this.request(signal,()=>this.driver.client.e2ee.decryptE2EEMessage(raw)));}
          catch{message=normalizeMessage({...raw,text:''},{unavailableReason:'E2EE decryption failed; this message was not exposed.'});}
          if(this.active&&this.allowed.has(chatId)&&message.id){
            stage='resolve_names';if(this.driver.resolveMessageNames)[message]=await this.request(signal,()=>this.driver.resolveMessageNames(this.allowed.get(chatId),[message]));
            stage='capture';if(this.active&&this.allowed.has(chatId))await this.capture(chatId,message);
          }
        }
        if(!this.active)break;
        stage='checkpoint';const next=nextTalkCursor(cursor,response);await this.driver.storage.set('monitor.talk',next);cursor=next;
        this.status('talk','running',undefined,true);retries=0;await pause(500,signal);
      }catch(error){if(!this.active)break;const retryInMs=Math.min(30000,2000*2**Math.min(retries++,4));this.status('talk','retrying','monitor_poll_failed',false,{diagnostic:pollDiagnostic(error,stage,Date.now()-startedAt,timeoutMs,retryInMs)});await pause(retryInMs,signal);}
    }
  }
  async squareLoop(chatId,room){
    let cursor,initialized=false,baseline=true,retries=0;
    const signal=AbortSignal.any([this.abort.signal,room.abort.signal]);
    while(this.active&&room.active){
      let stage='initialize',startedAt=Date.now(),timeoutMs=this.driver.client.config?.timeout??30000;
      try{
        if(!initialized){const saved=room.fresh?undefined:await this.driver.storage.get(`monitor.square:${chatId}`);cursor=typeof saved==='string'?saved:saved?.syncToken;baseline=!cursor || (typeof saved==='object' && saved.ready!==true);initialized=true;}
        stage='poll';startedAt=Date.now();this.status(chatId,'polling',undefined,false,{pollTimeoutMs:timeoutMs});
        const response=await this.request(signal,()=>this.driver.client.square.fetchSquareChatEvents({squareChatMid:chatId,limit:100,direction:'FORWARD',...(cursor?{syncToken:cursor}:{})}));
        if(!this.active||!room.active)break;
        // Drain the initial event snapshot in bounded pages without exposing it.
        // Persist readiness too: a restart during baseline must not import history.
        if(!baseline&&this.allowed.has(chatId)){
          let messages=squareMessages(response);
          stage='resolve_names';if(this.driver.resolveMessageNames)messages=await this.request(signal,()=>this.driver.resolveMessageNames(this.allowed.get(chatId),messages));
          stage='capture';for(const message of messages)if(this.active&&room.active&&this.allowed.has(chatId))await this.capture(chatId,message);
        }
        if(!this.active||!room.active)break;
        const nextBaseline=baseline&&!!response.events?.length;
        if(!response.syncToken)throw new Error('cursor_unavailable');
        stage='checkpoint';await this.driver.storage.set(`monitor.square:${chatId}`,{syncToken:response.syncToken,ready:!nextBaseline});cursor=response.syncToken;baseline=nextBaseline;
        if(!this.active||!room.active)break;
        this.status(chatId,baseline?'initializing':'running',undefined,true);retries=0;await pause(baseline?100:2000,signal);
      }catch(error){if(!this.active||!room.active)break;const retryInMs=Math.min(30000,2000*2**Math.min(retries++,4));this.status(chatId,'retrying','monitor_poll_failed',false,{diagnostic:pollDiagnostic(error,stage,Date.now()-startedAt,timeoutMs,retryInMs)});await pause(retryInMs,signal);}
    }
  }
}
