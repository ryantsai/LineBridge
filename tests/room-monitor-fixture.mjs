import timers from 'node:timers/promises';
import {LiveMonitor} from '../protocol/monitor.mjs';
import {SquareRoom} from '../protocol/square-sync.mjs';

// Isolate the room pager's baseline/ACK/burst invariants from the new account
// scheduler. Production never starts a polling loop per room. The real account
// orchestration and its SDK requests are tested in square-sync.test.mjs.
export class RoomMonitor extends LiveMonitor {
  constructor(driver,event,capture,options){super(driver,event,capture,{random:()=>0,pollJitter:()=>0.5,talkRearmMs:options?.refreshIntervalMs??500,...options});}
  update(chats){
    this.allowed=new Map(chats.map(c=>[c.id,c]));
    for(const [id,room] of this.rooms)if(!this.allowed.has(id)){room.stop();this.rooms.delete(id);this.status(id,'stopped');}
    for(const chat of chats)if(chat.kind==='openchat'&&!this.rooms.has(chat.id)){
      const room=new SquareRoom(chat.id,{fresh:this.initialized});this.rooms.set(chat.id,room);
      room.task=(async()=>{
        const signal=AbortSignal.any([this.abort.signal,room.abort.signal]);let retries=0;
        while(!signal.aborted){
          try{await room.drain(this,signal);retries=0;await this.waitForNextPoll(signal);}
          catch(failure){
            if(signal.aborted)break;
            const delay=this.retryDelay(retries++,failure.error);
            this.status(chat.id,'retrying','monitor_poll_failed',false,{diagnostic:this.diagnostic(failure.error,failure.stage,Date.now()-failure.started,failure.timeoutMs,delay)});
            try{await timers.setTimeout(delay,undefined,{signal});}catch{}
          }
        }
      })();
    }
    this.initialized=true;
  }
}
