import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { Store } from './store.mjs';
import { Vault } from './vault.mjs';
import { Hub } from './hub.mjs';
import { Tunnels } from './tunnels.mjs';
import { createApps } from './app.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const data=process.env.LINE_BRIDGE_DATA ? resolve(process.env.LINE_BRIDGE_DATA) : join(root,'data');
await mkdir(data,{recursive:true});
const adminPort=Number(process.env.LINE_BRIDGE_ADMIN_PORT ?? 3210),gatewayPort=Number(process.env.LINE_BRIDGE_GATEWAY_PORT ?? 3211);
if(![adminPort,gatewayPort].every(p=>Number.isInteger(p)&&p>1024&&p<65536)||adminPort===gatewayPort)throw new Error('Invalid service ports.');
const vault=await Vault.open(data),store=new Store(join(data,'bridge.sqlite')),hub=new Hub(store,vault),tunnels=new Tunnels(store,vault,root,gatewayPort);
const {admin,gateway}=createApps({hub,tunnels,root,adminPort,gatewayPort});
function listen(app,port) {return new Promise((resolve,reject)=>{const server=app.listen(port,'127.0.0.1',()=>resolve(server));server.on('error',reject);});}
let adminServer,gatewayServer;
try {adminServer=await listen(admin,adminPort);gatewayServer=await listen(gateway,gatewayPort);}
catch(error){adminServer?.close();hub.close();store.close();throw error;}
await writeFile(join(data,'server.pid'),String(process.pid));
console.log(`LINE Bridge dashboard: http://localhost:${adminPort}`);
console.log(`AI gateway: http://127.0.0.1:${gatewayPort} (Bearer authentication required)`);
console.log(`Credentials: ${vault.protection}`);
void hub.initialize();
let stopping=false;
async function stop() {
  if(stopping)return;stopping=true;hub.close();tunnels.close();
  adminServer.close();gatewayServer.close();adminServer.closeAllConnections();gatewayServer.closeAllConnections();
  await rm(join(data,'server.pid'),{force:true});
  // Leave time for aborted upstream jobs to settle before closing their store.
  const tails=[...hub.queues.values()].map(q=>q.tail);
  await Promise.allSettled(tails);store.close();process.exit(0);
}
process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
