import timers from 'node:timers/promises';
import {squareMessages} from '../server/drivers.mjs';
import {SQUARE_CONCURRENCY,SQUARE_RECONCILE_MS} from '../server/monitor-policy.mjs';
import {rpcDiagnostic} from '../server/rpc-transport.mjs';
import {squarePageDiagnostic} from './pagination-diagnostics.mjs';

export const SQUARE_BASELINE_PAGE_DELAY_MS=250;
export const SQUARE_BASELINE_MAX_PAGES=20;
export const SQUARE_BASELINE_BURST_MS=5000;
export const SQUARE_ACCOUNT_KEY='monitor.square.account.v1';
const pause=(ms,signal)=>timers.setTimeout(ms,undefined,{signal});
const token=value=>typeof value==='string'&&value.length>0&&value.length<=16384;
function page(response){
  if(!response||!Array.isArray(response.events)||response.events.length>1000||!token(response.syncToken)||
    (response.continuationToken!=null&&response.continuationToken!==''&&!token(response.continuationToken)))throw Object.assign(new Error('Invalid Square event page'),{name:'RequestError'});
  return response;
}
// MyEvents contains NOTIFICATION_MESSAGE (sometimes a coalesced notification,
// with requiredToFetchChatEvents), membership and control events. Use room event
// cursors for complete ordered messages; never treat the last notification as a
// complete backlog. Ignore undesignated rooms before hydration/name resolution.
export function squareEventRooms(events,rooms){
  const result=new Set();
  for(const event of events)for(const payload of Object.values(event?.payload??{})){
    const id=payload?.squareChatMid??payload?.chat?.squareChatMid??payload?.squareChat?.squareChatMid;
    if(typeof id==='string'&&rooms.has(id))result.add(id);
  }
  return result;
}

export class SquareRoom {
  constructor(id,{fresh=false}={}){this.id=id;this.fresh=fresh;this.active=true;this.abort=new AbortController();this.initialized=false;this.baseline=true;this.recovery=true;this.page=0;this.lastReconcile=0;}
  stop(){this.active=false;this.abort.abort();}
  async drain(monitor,signal,{shared=false}={}){
    signal=AbortSignal.any([signal,this.abort.signal]);
    const current=()=>monitor.active&&this.active&&!signal.aborted;
    const timeoutMs=monitor.driver.client.config?.timeout??30000;
    let stage='initialize',started=Date.now();
    try{
      if(!this.initialized){
        const saved=this.fresh?undefined:await monitor.driver.storage.get(`monitor.square:${this.id}`);
        signal.throwIfAborted();
        this.cursor=typeof saved==='string'?saved:saved?.syncToken;
        this.baseline=!token(this.cursor)||(typeof saved==='object'&&saved.ready!==true);
        // Re-selection must not resume an old disabled room's cursor on restart.
        if(this.fresh){stage='checkpoint';await monitor.driver.storage.set(`monitor.square:${this.id}`,{ready:false});signal.throwIfAborted();}
        this.initialized=true;
      }
      const burstStarted=Date.now();
      for(let count=0;count<SQUARE_BASELINE_MAX_PAGES&&current();count++){
        if(count&&Date.now()-burstStarted>=SQUARE_BASELINE_BURST_MS)return false;
        stage='poll';started=Date.now();
        monitor.status(this.id,'polling',undefined,false,{pollTimeoutMs:timeoutMs,source:'room_events'});
        const response=page(await monitor.request(signal,()=>monitor.driver.client.square.fetchSquareChatEvents({squareChatMid:this.id,limit:100,direction:'FORWARD',...(this.cursor?{syncToken:this.cursor}:{})})));
        signal.throwIfAborted();
        const diagnostic=monitor.diagnostics?squarePageDiagnostic({response,cursor:this.cursor,baseline:this.baseline,page:++this.page,startedAt:started,continuationTokenSent:false}):undefined;
        if(diagnostic)monitor.pageDiagnostic(this.id,diagnostic);
        if(!this.baseline){
          // A malformed cross-room envelope must not escape the room boundary.
          for(const event of response.events){
            const payload=event?.payload?.receiveMessage??event?.payload?.sendMessage??event?.payload?.notificationMessage;
            if(payload&&(payload.squareChatMid&&payload.squareChatMid!==this.id||payload.squareMessage?.message?.to&&payload.squareMessage.message.to!==this.id))throw Object.assign(new Error('Square room mismatch'),{name:'RequestError'});
          }
          let messages=squareMessages(response);
          stage='resolve_names';if(messages.length&&monitor.driver.resolveMessageNames)messages=await monitor.request(signal,()=>monitor.driver.resolveMessageNames(monitor.allowed.get(this.id),messages));
          stage='capture';for(const message of messages){signal.throwIfAborted();if(!current()||!monitor.allowed.has(this.id))return false;await monitor.capture(this.id,message);}
        }
        signal.throwIfAborted();
        const baseline=this.baseline&&response.events.length>0,advanced=this.cursor!==response.syncToken;
        stage='checkpoint';await monitor.driver.storage.set(`monitor.square:${this.id}`,{syncToken:response.syncToken,ready:!baseline});
        // Only ACKed pages change the in-memory cursor or readiness.
        this.cursor=response.syncToken;this.baseline=baseline;signal.throwIfAborted();
        monitor.status(this.id,response.events.length?'initializing':'running',undefined,true,{keepError:shared,...(diagnostic?{pagination:{...diagnostic,checkpointSucceeded:true,baselineAfter:baseline,elapsedMs:Date.now()-started}}:{})});
        if(!response.events.length){this.recovery=false;this.lastReconcile=Date.now();return true;}
        // Empty events, not an opaque continuation flag, delimit room catch-up.
        // An unchanged token yields at the regular interval instead of spinning.
        if(!advanced||count+1===SQUARE_BASELINE_MAX_PAGES||Date.now()-burstStarted>=SQUARE_BASELINE_BURST_MS)return false;
        await pause(SQUARE_BASELINE_PAGE_DELAY_MS,signal);
      }
      return false;
    }catch(error){
      if(signal.aborted)throw signal.reason;
      throw {squareFailure:true,error,stage,started,timeoutMs};
    }
  }
}

// One account feed; at most two room hydration requests concurrently. A batch
// stays uncommitted until every selected target finishes durable catch-up. Room
// checkpoints allow replay after crash without losing an already archived page.
export class SquareSync {
  constructor(monitor){this.monitor=monitor;this.rooms=monitor.rooms;this.changed=new AbortController();}
  update(chats){
    let changed=false;
    const selected=new Set(chats.filter(c=>c.kind==='openchat').map(c=>c.id));
    for(const [id,room] of this.rooms)if(!selected.has(id)){room.stop();this.rooms.delete(id);this.monitor.status(id,'stopped');changed=true;}
    for(const id of selected)if(!this.rooms.has(id)){this.rooms.set(id,new SquareRoom(id,{fresh:this.initialized}));this.monitor.pollStates.delete(id);changed=true;}
    this.initialized=true;
    if(changed){this.changed.abort();this.changed=new AbortController();}
    if(!this.task)this.task=this.run();
  }
  async hydrate(targets,signal){
    const entries=[...targets],m=this.monitor;let index=0,failed;
    await Promise.all(Array.from({length:Math.min(SQUARE_CONCURRENCY,entries.length)},async()=>{
      while(index<entries.length&&!failed&&!signal.aborted){
        const room=entries[index++];
        if(!room.active||this.rooms.get(room.id)!==room){targets.delete(room);continue;}
        try{if(await room.drain(m,signal,{shared:true}))targets.delete(room);}
        catch(error){
          const metadata=rpcDiagnostic(error?.squareFailure?error.error:error),prior=rpcDiagnostic(failed?.squareFailure?failed.error:failed);
          if(!failed||(metadata.retryAfterMs??0)>(prior.retryAfterMs??0)||metadata.httpStatus===429&&prior.httpStatus!==429&&!prior.retryAfterMs)failed=error;
        }
      }
    }));
    signal.throwIfAborted();if(failed)throw failed;
  }
  async run(){
    const m=this.monitor;let cursor,loaded=false,pending,retries=0,feedPages=0,burstStarted=0;
    while(m.active){
      const signal=AbortSignal.any([m.abort.signal,this.changed.signal]);
      let stage='initialize',started=Date.now(),timeoutMs=m.driver.client.config?.timeout??30000;
      try{
        if(!this.rooms.size){await pause(1000,signal);continue;}
        if(!loaded){const saved=await m.driver.storage.get(SQUARE_ACCOUNT_KEY);signal.throwIfAborted();cursor=token(saved?.syncToken)?{syncToken:saved.syncToken,...(token(saved.continuationToken)?{continuationToken:saved.continuationToken}:{})}:{};loaded=true;}
        if(!pending){
          stage='poll';started=Date.now();if(!feedPages)burstStarted=started;
          for(const id of this.rooms.keys())m.status(id,'polling',undefined,false,{pollTimeoutMs:timeoutMs,source:'account_events'});
          const response=page(await m.request(signal,()=>m.driver.client.square.fetchMyEvents({limit:100,...cursor})));
          signal.throwIfAborted();
          const mentioned=squareEventRooms(response.events,this.rooms),targets=new Set();
          for(const room of this.rooms.values())if(room.recovery||!room.initialized||room.baseline||mentioned.has(room.id)||Date.now()-room.lastReconcile>=SQUARE_RECONCILE_MS)targets.add(room);
          pending={response,targets,rooms:[...this.rooms.values()]};
        }
        // A selection change can interrupt hydration while retaining the account
        // page for replay. Newly selected room generations need their own baseline.
        for(const room of this.rooms.values())if(!room.initialized||room.recovery)pending.targets.add(room);
        stage='process';await this.hydrate(pending.targets,signal);
        if(pending.targets.size){feedPages=0;await m.waitForNextPoll(signal,{jitter:true});continue;}
        stage='checkpoint';
        const next={syncToken:pending.response.syncToken,...(token(pending.response.continuationToken)?{continuationToken:pending.response.continuationToken}:{})};
        if(pending.response.events.length&&next.syncToken===cursor.syncToken&&next.continuationToken===cursor.continuationToken){pending=undefined;throw Object.assign(new Error('Square account cursor stalled'),{name:'RequestError'});}
        await m.driver.storage.set(SQUARE_ACCOUNT_KEY,next);cursor=next;signal.throwIfAborted();
        for(const room of pending.rooms)if(room.active&&this.rooms.get(room.id)===room&&!room.recovery&&!room.baseline)m.status(room.id,'running',undefined,true,{source:'account_events'});
        const more=!!next.continuationToken&&pending.response.events.length>0;
        pending=undefined;retries=0;feedPages++;
        if(more&&feedPages<SQUARE_BASELINE_MAX_PAGES&&Date.now()-burstStarted<SQUARE_BASELINE_BURST_MS){await pause(SQUARE_BASELINE_PAGE_DELAY_MS,signal);if(Date.now()-burstStarted>=SQUARE_BASELINE_BURST_MS){feedPages=0;await m.waitForNextPoll(signal,{jitter:true});}}
        else{feedPages=0;await m.waitForNextPoll(signal,{jitter:true});}
      }catch(failure){
        if(!m.active)break;
        if(signal.aborted)continue;
        const error=failure?.squareFailure?failure.error:failure;
        if(failure?.squareFailure){stage=failure.stage;started=failure.started;timeoutMs=failure.timeoutMs;}
        const retryInMs=m.retryDelay(retries++,error);feedPages=0;
        for(const id of this.rooms.keys())m.status(id,'retrying','monitor_poll_failed',false,{diagnostic:m.diagnostic(error,stage,Date.now()-started,timeoutMs,retryInMs)});
        // Selection/interval changes must not bypass a server's retry delay.
        try{await pause(retryInMs,m.abort.signal);}catch{}
      }
    }
  }
}
