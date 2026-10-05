import {fileURLToPath} from 'node:url';
import {dirname,join,resolve} from 'node:path';
import {mkdir,readFile,writeFile,rm,stat,chmod} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {DatabaseSync,backup} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {Store} from './store.mjs';
import {Vault} from './vault.mjs';
import {Hub} from './hub.mjs';
import {Tunnels} from './tunnels.mjs';
import {createApps} from './app.mjs';
import {HubError} from './errors.mjs';
import {defaultDataDirectory,metadata,validPort} from './service-location.mjs';
export {defaultDataDirectory,metadata,validPort} from './service-location.mjs';

export const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
function alive(pid){if(!Number.isInteger(pid)||pid<1)return false;try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}}
async function lease(data){
  // An OS-released SQLite lock survives neither crashes nor stale PID files.
  // It lives in a separate database so normal store writes remain available.
  const lock=new DatabaseSync(join(data,'service-lock.sqlite'),{timeout:0});
  try{
    lock.exec('CREATE TABLE IF NOT EXISTS service_lock(id INTEGER PRIMARY KEY); BEGIN IMMEDIATE;');
    let pid;try{pid=Number(await readFile(join(data,'server.pid'),'utf8'));}catch{}
    const m=await metadata(data);
    if(alive(pid)&&!(m?.runtime==='node'&&m.pid===pid))throw new HubError(409,'bridge_already_running','Another LineBridge is using this data directory. Stop it first.');
    return lock;
  }catch(e){lock.close();if(e instanceof HubError)throw e;throw new HubError(409,'bridge_already_running','Another LineBridge is using this data directory.');}
}
async function migrationBackup(data){
  const path=join(data,'bridge.sqlite');try{await stat(path);}catch{return;}
  const db=new DatabaseSync(path,{readOnly:true});
  try{
    const marker=db.prepare("SELECT value FROM settings WHERE key IN ('archiveMigrationBackup','messageSearchVersion')").get();if(marker)return;
    const directory=join(data,'backups');await mkdir(directory,{recursive:true,mode:0o700});
    const name=`before-archive-${new Date().toISOString().replace(/[:.]/g,'-')}.sqlite`,destination=join(directory,name);
    await backup(db,destination);if(process.platform!=='win32')await chmod(destination,0o600);return name;
  }finally{db.close();}
}
function listen(app,port){return new Promise((ok,reject)=>{
  // Express 5 calls the listen callback on errors too. Never publish readiness
  // for a failed bind (the callback runs before a later error listener).
  const server=app.listen(port,'127.0.0.1',error=>error?reject(error):ok(server));
});}
export async function startService({dataDir=defaultDataDirectory(),adminPort=Number(process.env.LINE_BRIDGE_ADMIN_PORT??3210),gatewayPort=Number(process.env.LINE_BRIDGE_GATEWAY_PORT??3211),requireToken=process.env.LINE_BRIDGE_TRUST_LOCAL!=='1'||process.env.LINE_BRIDGE_REQUIRE_TOKEN==='1',defaultProvider=requireToken?'cloudflare_quick':'local'}={}){
  if(!['win32','darwin'].includes(process.platform))throw new Error('LineBridge supports Windows and macOS only.');
  const data=resolve(dataDir),instance=randomUUID();
  if(![adminPort,gatewayPort,gatewayPort+1].every(validPort)||adminPort===gatewayPort||adminPort===gatewayPort+1)throw new HubError(400,'invalid_ports','Use distinct ports between 1025 and 65534; reserve gateway+1 for connector health.');
  await mkdir(data,{recursive:true,mode:0o700});if(process.platform!=='win32')await chmod(data,0o700);
  const lock=await lease(data);let store,hub,tunnels,adminServer,gatewayServer,stopPromise;
  const closeServers=()=>{for(const server of [adminServer,gatewayServer]){server?.close();server?.closeAllConnections();}};
  async function shutdown(){
    if(stopPromise)return stopPromise;
    stopPromise=(async()=>{
      hub?.close();closeServers();await tunnels?.close();
      await Promise.allSettled([...[...hub?.queues.values()??[]].map(q=>q.tail),...hub?.monitorQueues.values()??[]]);
      const m=await metadata(data);if(m?.instance===instance){await rm(join(data,'service.json'),{force:true});await rm(join(data,'server.pid'),{force:true});}
      store?.close();lock.close();process.off('SIGINT',signal);process.off('SIGTERM',signal);
    })();return stopPromise;
  }
  const signal=()=>{void shutdown().catch(()=>{process.exitCode=1;});};
  try{
    const existingDatabase=existsSync(join(data,'bridge.sqlite'));
    const vault=await Vault.open(data),savedBackup=await migrationBackup(data);
    store=new Store(join(data,'bridge.sqlite'));if(savedBackup)store.setSetting('archiveMigrationBackup',savedBackup);
    if(process.platform!=='win32')for(const name of ['bridge.sqlite','service-lock.sqlite'])await chmod(join(data,name),0o600);
    if(!existingDatabase&&!store.setting('tunnel',null))store.setSetting('tunnel',{provider:defaultProvider,hostname:'',teamDomain:'',audience:''});
    hub=new Hub(store,vault);tunnels=new Tunnels(store,vault,root,gatewayPort,gatewayPort+1,data);
    const apps=createApps({hub,tunnels,root,adminPort,gatewayPort,instance,shutdown,requireToken});
    adminServer=await listen(apps.admin,adminPort);gatewayServer=await listen(apps.gateway,gatewayPort);
    await writeFile(join(data,'service.json'),JSON.stringify({runtime:'node',pid:process.pid,instance,adminPort,gatewayPort,dataDir:data}),{mode:0o600});
    await writeFile(join(data,'server.pid'),String(process.pid),{mode:0o600});
    process.on('SIGINT',signal);process.on('SIGTERM',signal);void hub.initialize();
    return {hub,tunnels,adminPort,gatewayPort,dataDir:data,instance,shutdown};
  }catch(error){await shutdown();throw error;}
}
