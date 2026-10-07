import {DatabaseSync} from 'node:sqlite';
import {readFile,writeFile,rename,rm,realpath,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {HubError} from './errors.mjs';
import {validPort} from './service-location.mjs';

export const MAINTENANCE_FILE='maintenance.json';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const fail=(code,message)=>{throw new HubError(409,code,message);};
export function alive(pid){if(!Number.isInteger(pid)||pid<1)return false;try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}}
export async function readRecord(data,name){
  try{return JSON.parse(await readFile(join(data,name),'utf8'));}
  catch(error){if(error.code==='ENOENT')return null;fail('invalid_instance_metadata','Instance metadata cannot be verified.');}
}
export async function writeRecord(data,name,value){
  const temp=`${name}.${randomUUID()}.tmp`;
  try{await writeFile(join(data,temp),JSON.stringify(value),{mode:0o600,flag:'wx'});await rename(join(data,temp),join(data,name));}
  finally{await rm(join(data,temp),{force:true});}
}
// All startup, shutdown-marker and resume decisions use the same short lease.
// Service/tray lifetime leases remain separate and are released by the OS.
export function tryLease(data,name){
  const db=new DatabaseSync(join(data,`${name}-lock.sqlite`),{timeout:0});
  try{db.exec('CREATE TABLE IF NOT EXISTS lifecycle_lock(id INTEGER PRIMARY KEY); BEGIN IMMEDIATE;');return db;}
  catch(error){db.close();if(error.errcode===5||error.errcode===6)return null;throw error;}
}
export async function lifecycleLease(data,deadline=Date.now()+30000){
  for(;;){const lock=tryLease(data,'lifecycle');if(lock)return lock;if(Date.now()>=deadline)fail('shutdown_timeout','Shutdown/startup is still in progress. Retry with the same data directory.');await delay(Math.min(50,Math.max(1,deadline-Date.now())));}
}
const identity=(value,data)=>value&&value.dataDir===data&&typeof value.instance==='string'&&value.instance.length>0&&value.instance.length<=128&&Number.isInteger(value.pid)&&value.pid>0;
function serviceIdentity(value,data){return identity(value,data)&&value.runtime==='node'&&validPort(value.adminPort)&&validPort(value.gatewayPort)&&validPort(value.gatewayPort+1)&&value.adminPort!==value.gatewayPort&&value.adminPort!==value.gatewayPort+1;}
function trayIdentity(value,data){return identity(value,data)&&value.runtime==='tray'&&(value.desktopPid==null||Number.isInteger(value.desktopPid)&&value.desktopPid>0);}
export async function maintenance(data){
  const value=await readRecord(data,MAINTENANCE_FILE);
  if(value&&(value.version!==1||value.dataDir!==data||typeof value.id!=='string'||value.service&&!serviceIdentity(value.service,data)||value.tray&&!trayIdentity(value.tray,data)))fail('invalid_maintenance','Maintenance metadata cannot be verified; leave it in place.');
  return value;
}
export async function portsReleased(ports){
  for(const port of ports){
    const server=createServer();
    const free=await new Promise(resolve=>{server.once('error',()=>resolve(false));server.listen(port,'127.0.0.1',()=>server.close(()=>resolve(true)));});
    if(!free)return false;
  }
  return true;
}
export function leasesReleased(data,names=['service','tray']){
  const held=[];
  try{for(const name of names){const lock=tryLease(data,name);if(!lock)return false;held.push(lock);}return true;}
  finally{for(const lock of held)lock.close();}
}
export async function assertResume(data,marker){
  if(!leasesReleased(data)||alive(marker.tray?.pid)||alive(marker.tray?.desktopPid)||alive(marker.service?.pid))fail('maintenance_busy','The previous desktop/service has not exited. Retry shutdown before resuming.');
}
export async function verifyMaintenance(data,instance,id){
  const marker=await maintenance(data);
  if(!marker||marker.id!==id||marker.service?.instance!==instance)fail('instance_mismatch','The maintenance request does not match this service.');
}
function budget(deadline){const left=deadline-Date.now();if(left<=0)fail('shutdown_timeout','Shutdown is not confirmed. Maintenance remains active; do not replace files or resume yet.');return left;}
async function probeService(m,deadline){
  const base=`http://127.0.0.1:${m.adminPort}`;
  const request=(path,options={})=>fetch(base+path,{...options,headers:{Connection:'close',...options.headers},redirect:'error',signal:AbortSignal.timeout(Math.min(5000,budget(deadline)))});
  let cookie,state;
  try{
    const index=await request('/');cookie=index.headers.getSetCookie()[0]?.split(';')[0];void index.body?.cancel().catch(()=>{});
    if(!index.ok||!cookie)throw new Error();
    const response=await request('/admin/status',{headers:{Cookie:cookie}});if(!response.ok)throw new Error();state=await response.json();
  }catch{fail('instance_unavailable','The service identity cannot be verified. No unrelated process was stopped.');}
  if(state.instance!==m.instance||state.backend!=='node')fail('instance_mismatch','The service instance does not match.');
  if(state.maintenanceVersion!==1)fail('shutdown_unsupported','This service predates maintenance shutdown. Exit its desktop once before installing the update.');
  if(state.dataDir!==m.dataDir)fail('instance_mismatch','The service data directory does not match.');
  return async marker=>{
    const response=await request('/admin/shutdown',{method:'POST',headers:{Cookie:cookie,Origin:base,'X-Line-Bridge':'dashboard','Content-Type':'application/json'},body:JSON.stringify({instance:m.instance,maintenanceId:marker.id})});
    void response.body?.cancel().catch(()=>{});
    if(!response.ok)fail('shutdown_rejected','The service did not accept maintenance shutdown. Maintenance remains active.');
  };
}

export async function shutdownDesktop({dataDir,instance,timeoutMs=30000}){
  if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>120000)fail('invalid_timeout','Use --timeout-ms between 1000 and 120000.');
  const deadline=Date.now()+timeoutMs,data=await realpath(resolve(dataDir));
  // Refuse a typo/empty directory without creating a vault, database or profile.
  if(!(await Promise.all(['service-lock.sqlite','tray-lock.sqlite',MAINTENANCE_FILE].map(name=>stat(join(data,name)).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;})))).some(Boolean))fail('unknown_data_directory','No LineBridge instance exists in this data directory.');
  const gate=await lifecycleLease(data,deadline);let marker,requestStop;
  try{
    marker=await maintenance(data);
    const service=await readRecord(data,'service.json'),tray=await readRecord(data,'tray.json');
    if(service&&!serviceIdentity(service,data)||tray&&!trayIdentity(tray,data))fail('instance_mismatch','The instance metadata does not match this data directory.');
    const expected=service?.instance??marker?.service?.instance;
    if(instance!==undefined&&instance!==expected)fail('instance_mismatch','The requested service instance does not match.');
    if(marker&&(service&&service.instance!==marker.service?.instance||tray&&tray.instance!==marker.tray?.instance))fail('instance_mismatch','A different instance appeared during maintenance.');
    if(!marker){
      if(service&&alive(service.pid))requestStop=await probeService(service,deadline);
      else if(!leasesReleased(data,['service']))fail('instance_unavailable','The data lock is owned by an unverifiable service.');
      if(!tray&&!leasesReleased(data,['tray']))fail('shutdown_unsupported','This tray predates maintenance shutdown. Exit it once before installing the update.');
      marker={version:1,id:randomUUID(),dataDir:data,service,tray,serviceDrained:!requestStop};
      await writeRecord(data,MAINTENANCE_FILE,marker);
    }else if(service&&alive(service.pid)&&!leasesReleased(data,['service'])){
      // A prior request may have timed out while the worker drains. If its HTTP
      // listener is already gone, the marker and leases still prevent startup.
      try{requestStop=await probeService(service,deadline);}catch(error){if(error.code!=='instance_unavailable')throw error;}
    }
    if(requestStop)await requestStop(marker);
  }finally{gate.close();}
  const ports=marker.service?[marker.service.adminPort,marker.service.gatewayPort,marker.service.gatewayPort+1]:[];
  for(;;){
    budget(deadline);
    if(leasesReleased(data)&&!alive(marker.service?.pid)&&!alive(marker.tray?.pid)&&!alive(marker.tray?.desktopPid)&&await portsReleased(ports)){
      const completed=await maintenance(data);
      if(completed?.id!==marker.id)fail('instance_mismatch','Maintenance changed while waiting for shutdown.');
      if(completed.serviceDrained!==true)fail('drain_unconfirmed','The process exited without confirming a graceful drain. Maintenance remains active; inspect local service errors before explicitly resuming.');
      return {status:'stopped',maintenance:true,dataDir:data,instance:marker.service?.instance??null};
    }
    await delay(Math.min(100,budget(deadline)));
  }
}
