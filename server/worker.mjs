import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {HubError,SendRejectedError} from './errors.mjs';
import {VaultStorage} from './vault.mjs';
import {ACCOUNT_CHECK_TIMEOUT_MS,accountCheckError} from './account-health.mjs';

const encode=value=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?{$bigint:String(v)}:v);
const decode=value=>JSON.parse(value,(_,v)=>v&&typeof v==='object'&&'$bigint' in v?BigInt(v.$bigint):v);
// LINE runs in a private child with no database or HTTP listener. Storage and
// captured messages are acknowledged only after the parent commits them.
export class ProtocolWorker {
  constructor(store,vault,capture) {Object.assign(this,{store,vault,capture});this.pending=new Map();this.events=new Map();}
  start() {
    if(this.child)return;
    const child=spawn(process.execPath,[fileURLToPath(new URL('../protocol/worker.mjs',import.meta.url))],{windowsHide:true,stdio:['pipe','pipe','ignore']});
    this.child=child;
    child.stdin.on('error',()=>{});
    const input=createInterface({input:child.stdout,crlfDelay:Infinity});
    input.on('line',line=>{
      if(line.length>2_000_000){child.kill();return;}
      try{this.handle(decode(line));}catch{child.kill();}
    });
    const failed=()=>{
      if(this.child!==child)return;
      this.child=null;
      for(const request of this.pending.values()){clearTimeout(request.timer);request.reject(new HubError(502,'upstream_unavailable','The LINE worker stopped.'))}
      this.pending.clear();
      for(const emit of this.events.values())emit.fault?.('protocol_error');
    };
    child.on('error',failed);child.on('exit',failed);
  }
  write(value){this.child?.stdin.write(`${encode(value)}\n`);}
  handle(message) {
    if(message.type==='result'){
      const request=this.pending.get(message.id);if(!request)return;
      clearTimeout(request.timer);this.pending.delete(message.id);
      if(message.error){const e=message.error;request.reject(request.method==='check'?accountCheckError(e):new (e.rejected_send?SendRejectedError:HubError)(e.status||502,e.code||'upstream_unavailable',e.message||'LINE operation failed.'));}
      else request.resolve(message.result);
    }else if(message.type==='event'){
      const emit=this.events.get(message.accountId);if(message.event==='monitor_status')emit?.monitor?.(message.value);else emit?.[message.event]?.(message.value);
    }else if(message.type==='storage'||message.type==='capture'){
      let ok=false;
      try{
        if(!this.store.account(message.accountId))throw new Error('Unknown account');
        if(message.type==='capture')this.capture(message.accountId,message.chatId,message.message);
        else {
          if(typeof message.key!=='string'||message.key.length>256)throw new Error('Invalid storage key');
          if(message.operation==='delete')this.store.deleteSecret(message.accountId,message.key);
          else if(message.operation==='set')this.store.putSecret(message.accountId,message.key,this.vault.seal(message.value,`${message.accountId}:${message.key}`));
          else throw new Error('Invalid storage operation');
        }
        ok=true;
      }catch{}
      this.write({type:message.type==='capture'?'capture_ack':'storage_ack',id:message.id,ok});
    }
  }
  call(method,params={},timeout=40000,signal){
    if(signal?.aborted)return Promise.reject(signal.reason);
    this.start();const id=randomUUID();
    return new Promise((resolve,reject)=>{
      const finish=(callback,value)=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);this.pending.delete(id);callback(value);};
      const cancel=()=>finish(reject,signal.reason);
      const timer=setTimeout(()=>finish(reject,method==='check'?accountCheckError({name:'TimeoutError'}):new HubError(502,'upstream_unavailable','The LINE operation timed out.')),timeout);
      this.pending.set(id,{method,resolve:value=>finish(resolve,value),reject:error=>finish(reject,error),timer});
      signal?.addEventListener('abort',cancel,{once:true});this.write({id,method,params});
    });
  }
  driver(account,emit){
    const worker=this,id=account.id,storage=new VaultStorage(this.store,this.vault,id);
    this.events.set(id,emit);
    const call=(method,params)=>worker.call(method,{...params,accountId:id});
    return {
      ready:false,
      async login(qr){const profile=await worker.call('connect',{accountId:id,account,storage:storage.getAll(),qr},240000);this.ready=true;return profile;},
      check:signal=>worker.call('check',{accountId:id},ACCOUNT_CHECK_TIMEOUT_MS+5000,signal),discover:()=>call('discover'),
      read:(chat,limit,cursor)=>call('read',{chat,limit,cursor}),
      send:(chat,text)=>call('send',{chat,text}),
      resolveMessageNames:(chat,messages)=>call('resolve_names',{chat,messages}),
      startMonitor:(chats,reset)=>call('monitor_start',{chats,reset}),
      updateMonitor:chats=>call('monitor_update',{chats}),
      stopMonitor:()=>call('monitor_stop'),
      stop(){this.ready=false;worker.events.delete(id);if(worker.child)void call('disconnect').catch(()=>{});}
    };
  }
  close(){
    for(const request of this.pending.values()){clearTimeout(request.timer);request.reject(new HubError(502,'upstream_unavailable','The LINE worker stopped.'));}
    this.pending.clear();this.events.clear();this.child?.kill();this.child=null;
  }
}
