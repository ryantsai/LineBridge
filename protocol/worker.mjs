import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import {BaseStorage} from 'lineclientbot';
import {LineDriver} from '../server/drivers.mjs';
import {HubError,SendRejectedError,publicError} from '../server/errors.mjs';
import {LiveMonitor} from './monitor.mjs';
import {accountCheckError} from '../server/account-health.mjs';

// This process owns only LINE RPCs. The parent owns policy, storage and HTTP.
// stdout is a private JSON pipe; never attach the adapter's raw logging events.
console.log=()=>{};console.error=()=>{};
const drivers=new Map(),writes=new Map(),monitors=new Map();
const emit=value=>process.stdout.write(JSON.stringify(value,(_,v)=>typeof v==='bigint'?{$bigint:String(v)}:v)+'\n');
class PipeStorage extends BaseStorage {
  constructor(accountId,initial){super();this.accountId=accountId;this.data=new Map(Object.entries(initial));}
  async get(key){return this.data.get(key);}
  async set(key,value){await this.persist('set',key,value);this.data.set(key,value);}
  async delete(key){await this.persist('delete',key);this.data.delete(key);}
  async clear(){for(const key of this.data.keys())await this.delete(key);}
  getAll(){return Object.fromEntries(this.data);}
  async migrate(storage){for(const [key,value] of this.data)await storage.set(key,value);}
  async persist(operation,key,value){
    const id=randomUUID();
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{writes.delete(id);reject(new Error('vault_write_failed'));},10000);
      writes.set(id,{resolve:()=>{clearTimeout(timer);resolve();},reject:()=>{clearTimeout(timer);reject(new Error('vault_write_failed'));}});
      emit({type:'storage',id,accountId:this.accountId,operation,key,value});
    });
  }
}
async function handle(request){
  const {id,method,params={}}=request,accountId=params.accountId;
  try{
    let result;
    if(method==='connect'){
      monitors.get(accountId)?.stop();monitors.delete(accountId);
      drivers.get(accountId)?.stop();
      const storage=new PipeStorage(accountId,params.storage ?? {});
      let driver;
      const event=(event,value)=>{if(drivers.get(accountId)===driver)emit({type:'event',accountId,event,value});};
      driver=new LineDriver(params.account,storage,{qr:v=>event('qr',v),pin:v=>event('pin',v),fault:v=>event('fault',v)});
      drivers.set(accountId,driver);result=await driver.login(!!params.qr);
    }else{
      const driver=drivers.get(accountId);if(!driver)throw new HubError(409,'account_disconnected','Account is not connected.');
      switch(method){
        case 'disconnect':monitors.get(accountId)?.stop();monitors.delete(accountId);driver.stop();drivers.delete(accountId);result={ok:true};break;
        case 'check':result=await driver.check();break;
        case 'discover':result=await driver.discover();break;
        case 'read':result=await driver.read(params.chat,params.limit,params.cursor);break;
        case 'resolve_names':result=await driver.resolveMessageNames(params.chat,(params.messages ?? []).slice(0,100));break;
        case 'send':result=await driver.send(params.chat,params.text);break;
        case 'monitor_start':{
          monitors.get(accountId)?.stop();
          if(params.reset)for(const key of Object.keys(driver.storage.getAll()))if(key.startsWith('monitor.'))await driver.storage.delete(key);
          const monitor=new LiveMonitor(driver,(event,value)=>emit({type:'event',accountId,event,value}),async(chatId,message)=>{
            const ackId=randomUUID();await new Promise((resolve,reject)=>{
              const timer=setTimeout(()=>{writes.delete(ackId);reject(new Error('capture_failed'));},10000);
              writes.set(ackId,{resolve:()=>{clearTimeout(timer);resolve();},reject:()=>{clearTimeout(timer);reject(new Error('capture_failed'));}});
              emit({type:'capture',id:ackId,accountId,chatId,message});
            });
          },{refreshIntervalMs:params.refreshIntervalMs});monitor.update(params.chats ?? []);monitors.set(accountId,monitor);result={ok:true};break;
        }
        case 'monitor_update':monitors.get(accountId)?.update(params.chats ?? []);result={ok:true};break;
        case 'monitor_interval':monitors.get(accountId)?.setRefreshInterval(params.refreshIntervalMs);result={ok:true};break;
        case 'monitor_stop':monitors.get(accountId)?.stop();monitors.delete(accountId);result={ok:true};break;
        default:throw new Error('Unknown worker operation');
      }
    }
    emit({type:'result',id,result});
  }catch(error){
    const checked=method==='check'?accountCheckError(error):error,safe=publicError(checked);
    emit({type:'result',id,error:{status:safe.status,code:safe.code,message:safe.message,rejected_send:error instanceof SendRejectedError,...(method==='check'?{accountDiagnostic:checked.accountDiagnostic}:{})}});
  }
}
const input=createInterface({input:process.stdin,crlfDelay:Infinity});
input.on('line',line=>{
  if(line.length>2_000_000){process.exit(2);return;}
  try{const message=JSON.parse(line,(_,v)=>v&&typeof v==='object'&&'$bigint'in v?BigInt(v.$bigint):v);
    if(['storage_ack','capture_ack'].includes(message.type)){const pending=writes.get(message.id);writes.delete(message.id);message.ok?pending?.resolve():pending?.reject();}
    else void handle(message);
  }catch{process.exit(2);}
});
input.on('close',()=>{for(const m of monitors.values())m.stop();for(const d of drivers.values())d.stop();process.exit(0);});
