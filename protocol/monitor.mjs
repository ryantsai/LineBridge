import {normalizeMessage,squareMessages} from '../server/drivers.mjs';

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
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// Bounded polling avoids the library's unhandled push-loop failures. There are
// no read receipts or send calls in this listener. Cursors advance after durable ACK.
export class LiveMonitor {
  constructor(driver,event,capture){this.driver=driver;this.event=event;this.capture=capture;this.active=true;this.allowed=new Map();this.rooms=new Map();this.pollStates=new Map();void this.talkLoop();}
  update(chats){
    this.allowed=new Map(chats.map(c=>[c.id,c]));
    for(const [id,room] of this.rooms)if(!this.allowed.has(id)){room.active=false;this.rooms.delete(id);this.status(id,'stopped');}
    for(const chat of chats)if(chat.kind==='openchat'&&!this.rooms.has(chat.id)){const room={active:true,fresh:this.initialized};this.pollStates.delete(chat.id);this.rooms.set(chat.id,room);void this.squareLoop(chat.id,room);}this.initialized=true;
  }
  stop(){this.active=false;for(const room of this.rooms.values())room.active=false;}
  status(channel,status,error,success=false){
    if(!this.active)return;
    const now=new Date().toISOString(),previous=this.pollStates.get(channel);
    const state={channel,status,error,lastPoll:now,
      lastAttemptAt:status==='polling'?now:previous?.lastAttemptAt??null,
      lastSuccessAt:success?now:previous?.lastSuccessAt??null,
      ready:success?status==='running':previous?.ready??false};
    this.pollStates.set(channel,state);this.event('monitor_status',state);
  }
  async talkLoop(){
    let cursor,retries=0;
    while(this.active){
      if(![...this.allowed.values()].some(c=>c.kind!=='openchat')){await pause(1000);continue;}
      try{
        if(!cursor){cursor=await this.driver.storage.get('monitor.talk');if(!cursor){const revision=await this.driver.client.request.request([],'getLastOpRevision',4,false,'/S4');if(!['number','bigint'].includes(typeof revision))throw new Error('revision_unavailable');cursor={revision,globalRev:0,individualRev:0};}}
        this.status('talk','polling');
        const response=await this.driver.client.talk.sync({...cursor,limit:100,timeout:10000});
        if(!this.active)break;
        for(const operation of response.operationResponse?.operations ?? []){
          if(!['SEND_MESSAGE','RECEIVE_MESSAGE',25,26].includes(operation.type)||!operation.message)continue;
          const raw=operation.message,chatId=talkChatId(raw,this.driver.client.profile.mid);
          if(!this.active||!this.allowed.has(chatId))continue;
          let message;
          try{message=normalizeMessage(await this.driver.client.e2ee.decryptE2EEMessage(raw));}
          catch{message=normalizeMessage({...raw,text:''},{unavailableReason:'E2EE decryption failed; this message was not exposed.'});}
          if(this.active&&this.allowed.has(chatId)&&message.id){
            if(this.driver.resolveMessageNames)[message]=await this.driver.resolveMessageNames(this.allowed.get(chatId),[message]);
            if(this.active&&this.allowed.has(chatId))await this.capture(chatId,message);
          }
        }
        if(!this.active)break;
        cursor=nextTalkCursor(cursor,response);await this.driver.storage.set('monitor.talk',cursor);
        this.status('talk','running',undefined,true);retries=0;await pause(500);
      }catch{if(!this.active)break;this.status('talk','retrying','monitor_poll_failed');await pause(Math.min(30000,2000*2**Math.min(retries++,4)));}
    }
  }
  async squareLoop(chatId,room){
    let cursor,initialized=false,baseline=true,retries=0;
    while(this.active&&room.active){
      try{
        if(!initialized){const saved=room.fresh?undefined:await this.driver.storage.get(`monitor.square:${chatId}`);cursor=typeof saved==='string'?saved:saved?.syncToken;baseline=!cursor || (typeof saved==='object' && saved.ready!==true);initialized=true;}
        this.status(chatId,'polling');
        const response=await this.driver.client.square.fetchSquareChatEvents({squareChatMid:chatId,limit:100,direction:'FORWARD',...(cursor?{syncToken:cursor}:{})});
        if(!this.active||!room.active)break;
        // Drain the initial event snapshot in bounded pages without exposing it.
        // Persist readiness too: a restart during baseline must not import history.
        if(!baseline&&this.allowed.has(chatId)){
          let messages=squareMessages(response);
          if(this.driver.resolveMessageNames)messages=await this.driver.resolveMessageNames(this.allowed.get(chatId),messages);
          for(const message of messages)if(this.active&&room.active&&this.allowed.has(chatId))await this.capture(chatId,message);
        }
        if(!(response.events?.length))baseline=false;
        if(!response.syncToken)throw new Error('cursor_unavailable');
        cursor=response.syncToken;await this.driver.storage.set(`monitor.square:${chatId}`,{syncToken:cursor,ready:!baseline});
        this.status(chatId,baseline?'initializing':'running',undefined,true);retries=0;await pause(baseline?100:2000);
      }catch{if(!this.active||!room.active)break;this.status(chatId,'retrying','monitor_poll_failed');await pause(Math.min(30000,2000*2**Math.min(retries++,4)));}
    }
  }
}
