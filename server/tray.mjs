// Private, line-oriented controller for the native tray helpers. No credentials
// or chat content cross this pipe; all service checks use the public CLI.
import {parseArgs} from 'node:util';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,open,realpath,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';
import {DatabaseSync} from 'node:sqlite';
import {defaultDataDirectory} from './main.mjs';
import {randomUUID} from 'node:crypto';
import {lifecycleLease,maintenance,writeRecord,readRecord} from './maintenance.mjs';

const exec=promisify(execFile),cli=fileURLToPath(new URL('../bin/linebridge.mjs',import.meta.url));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const emit=(type,value='')=>console.log(`${type}\t${String(value).replace(/[\r\n\t]/g,' ')}`);
let lock,timer,maintenanceTimer,data,metadataWrite,closePromise,closing=false;
const instance=randomUUID();
const input=createInterface({input:process.stdin});
function close(){
  if(closing)return closePromise;closing=true;clearInterval(timer);clearInterval(maintenanceTimer);input.close();process.stdin.destroy();
  closePromise=(async()=>{
    try{await metadataWrite;if(data&&(await readRecord(data,'tray.json'))?.instance===instance)await rm(join(data,'tray.json'),{force:true});}
    finally{lock?.close();lock=undefined;}
  })();void closePromise.catch(()=>{process.exitCode=1;});return closePromise;
}
input.on('close',close);
try{
  const {values}=parseArgs({options:{'data-dir':{type:'string'},'admin-port':{type:'string'},'gateway-port':{type:'string'},'desktop-pid':{type:'string'}}});
  data=values['data-dir']?resolve(values['data-dir']):defaultDataDirectory();
  await mkdir(data,{recursive:true,mode:0o700});
  data=await realpath(data);
  const desktopPid=values['desktop-pid']===undefined?null:Number(values['desktop-pid']);
  if(desktopPid!==null&&desktopPid!==process.ppid)throw new Error('Desktop parent identity does not match.');
  async function command(name){
    try{return JSON.parse((await exec(process.execPath,[cli,name,'--data-dir',data],{windowsHide:true,timeout:15000})).stdout);}
    catch(error){try{const result=JSON.parse(error.stdout);if(result.status==='unavailable')return result;}catch{}throw error;}
  }
  async function running(){const state=await command('status');if(state.status!=='running')throw new Error('Service is not running. Quit the tray and restart LineBridge; inspect service.stderr.log if startup failed.');return state;}
  // SQLite provides a per-data-directory singleton released by the OS on crash.
  const gate=await lifecycleLease(data);let duplicate=false;
  try{
    if(await maintenance(data))throw new Error('維護中。更新完成後請先使用 serve --resume 及原資料目錄啟動。');
    if(!closing){
      lock=new DatabaseSync(join(data,'tray-lock.sqlite'),{timeout:0});
      try{lock.exec('CREATE TABLE IF NOT EXISTS tray_lock(id INTEGER PRIMARY KEY); BEGIN IMMEDIATE;');}
      catch{lock.close();lock=undefined;duplicate=true;}
      if(lock){metadataWrite=writeRecord(data,'tray.json',{runtime:'tray',instance,pid:process.pid,desktopPid,dataDir:data});await metadataWrite;}
    }
  }finally{gate.close();}
  if(duplicate){const state=await running();emit('open',state.dashboardUrl);emit('quit');await close();}
  if(!closing){
    let checking=false;
    maintenanceTimer=setInterval(async()=>{
      if(checking||closing)return;checking=true;
      try{const marker=await maintenance(data);if(marker?.tray?.instance===instance){emit('quit');await close();}}
      catch{emit('error','Maintenance state could not be verified.');emit('quit');await close();}
      finally{checking=false;}
    },200);
  }
  if(!closing){
    let state=await command('status');
    if(state.status==='unavailable'){
      // A crash/reboot can leave service.json behind. Only recover when its PID
      // is gone; startService still must obtain the data lease and bind ports.
      let alive=true;
      try{process.kill(state.pid,0);}catch(error){if(error.code==='ESRCH')alive=false;}
      if(alive)throw new Error('Existing service metadata cannot be verified. Check linebridge status before starting another service.');
      state={status:'stopped'};
    }
    if(state.status==='stopped'&&!closing){
      const stdout=await open(join(data,'service.stdout.log'),'a',0o600),stderr=await open(join(data,'service.stderr.log'),'a',0o600);
      let child;
      try{
        child=spawn(process.execPath,[cli,'serve','--require-token','--data-dir',data,...['admin-port','gateway-port'].flatMap(key=>values[key]?['--'+key,values[key]]:[])],{detached:true,windowsHide:true,stdio:['ignore',stdout.fd,stderr.fd]});
        await new Promise((ok,fail)=>{child.once('spawn',ok);child.once('error',fail);});child.unref();
      }finally{await stdout.close();await stderr.close();}
      const deadline=Date.now()+30000;
      while(Date.now()<deadline&&!closing){
        state=await command('status');if(state.status==='running')break;
        if(child.exitCode!==null)throw new Error('Service could not start. Check service.stderr.log in the data directory. For port conflicts, use --admin-port and --gateway-port (also leave gateway + 1 free).');
        await delay(250);
      }
      if(state.status!=='running')throw new Error('Service startup timed out. Inspect linebridge status and service.stderr.log before retrying.');
    }
    if(!closing){
      emit('ready',state.dashboardUrl);
      let busy=false;
      input.on('line',async action=>{
        // Do not drop menu clicks while a background status check is in flight.
        while(busy&&!closing)await delay(30);
        if(closing)return;busy=true;
        try{
          if(action==='open')emit('open',(await running()).dashboardUrl);
          else if(action==='stop'){
            const result=await command('stop');
            if(!['stopping','stopped'].includes(result.status))throw new Error('Service could not be stopped.');
            const deadline=Date.now()+15000;
            while((await command('status')).status!=='stopped'){
              if(Date.now()>deadline)throw new Error('Service shutdown is not yet confirmed.');await delay(250);
            }
            emit('quit');close();
          }else if(action==='quit'){emit('quit');close();}
        }catch(error){emit('error',error.message);}finally{busy=false;}
      });
      // Each check spawns the CLI; once a minute is enough for the tray's status line.
      timer=setInterval(async()=>{
        if(busy||closing)return;busy=true;
        try{const current=await command('status');if(!closing)emit('state',current.status==='running'?`Running on port ${current.adminPort}`:'Service unavailable');}
        catch{if(!closing)emit('state','Service unavailable');}finally{busy=false;}
      },60000);
    }
  }
}catch(error){emit('error',error.message);emit('quit');close();process.exitCode=1;}
