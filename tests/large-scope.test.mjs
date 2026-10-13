import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createServer} from 'node:net';
import {resolve} from 'node:path';
import {Store} from '../server/store.mjs';
import {Vault} from '../server/vault.mjs';
import {Hub} from '../server/hub.mjs';
import {Tunnels} from '../server/tunnels.mjs';
import {LocalSetup} from '../server/local-setup.mjs';
import {createApps} from '../server/app.mjs';
import {MAX_SCOPE_CHATS} from '../server/limits.mjs';

async function freePort(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port;}

// Real LINE IDs are 33 characters. Before the fix the dashboard's 32 KB JSON limit
// rejected an enable at roughly 900 chats and a scope update at roughly 450.
test('dashboard enables and updates a Local AI scope with thousands of real-length chat IDs',async t=>{
  const store=new Store(':memory:'),vault=new Vault(randomBytes(32),'synthetic'),hub=new Hub(store,vault),items=new Map();
  const adminPort=await freePort(),gatewayPort=await freePort(),tunnels=new Tunnels(store,vault,resolve('.'),gatewayPort);
  const credentials={protection:'synthetic protected store',create:async(profile,url,value)=>{items.set(profile,{url,...value});},get:async profile=>{if(!items.has(profile))throw Object.assign(new Error('synthetic'),{code:'credentials_required'});return items.get(profile);},forget:async profile=>items.delete(profile)};
  const localSetup=new LocalSetup(hub,{credentials,gatewayPort}),apps=createApps({hub,tunnels,root:resolve('.'),adminPort,gatewayPort,localSetup});
  const admin=apps.admin.listen(adminPort,'127.0.0.1');
  t.after(()=>{hub.close();tunnels.close();admin.closeAllConnections();admin.close();store.close();});

  const a=await hub.addAccount({label:'Large account',kind:'demo'});
  const ids=Array.from({length:4000},(_,i)=>`${i%4?'u':'c'}${i.toString(16).padStart(32,'0')}`);
  for(const [i,id] of ids.entries())store.putChat(a.id,{id,name:`Chat ${i}`,kind:id.startsWith('c')?'group':'direct'});

  const local=`http://127.0.0.1:${adminPort}`,page=await fetch(local),cookie=page.headers.getSetCookie()[0].split(';')[0];
  const headers={Cookie:cookie,Origin:local,'X-Line-Bridge':'dashboard','Content-Type':'application/json'},route=`${local}/admin/accounts/${a.id}/local-setup`;

  const enable=JSON.stringify({chatIds:ids,read:true,send:true,confirmed:true,autoMonitorNewChats:true});
  assert.ok(enable.length>32*1024,'The request exceeds the old 32 KB limit');
  const enabled=await fetch(route,{method:'POST',headers,body:enable});
  assert.equal(enabled.status,200,await enabled.clone().text());
  assert.equal((await enabled.json()).chatIds.length,ids.length);

  const next=ids.slice(0,3500),update=JSON.stringify({chatIds:next,currentChatIds:ids,autoMonitorNewChats:true,confirmed:true});
  const updated=await fetch(`${route}/scope`,{method:'PUT',headers,body:update});
  assert.equal(updated.status,200,await updated.clone().text());
  assert.equal(localSetup.record(a.id).chatIds.length,next.length);
  assert.equal(store.chats(a.id).filter(c=>c.enabled).length,next.length);

  const tooMany=JSON.stringify({chatIds:Array.from({length:MAX_SCOPE_CHATS+1},(_,i)=>`u${i.toString(16).padStart(32,'0')}`),currentChatIds:next,autoMonitorNewChats:true,confirmed:true});
  assert.equal((await fetch(`${route}/scope`,{method:'PUT',headers,body:tooMany})).status,400,'The explicit cap still applies');
});
