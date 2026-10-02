import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,readdir,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {Store} from '../server/store.mjs';
import {Vault} from '../server/vault.mjs';
const exec=promisify(execFile),cli=resolve('bin/linebridge.mjs'),wait=ms=>new Promise(r=>setTimeout(r,ms));
async function ports(){for(let i=0;i<30;i++){const p=15000+Math.floor(Math.random()*30000),servers=[];try{for(const port of [p,p+1,p+2]){const s=createServer();servers.push(s);await new Promise((r,j)=>{s.once('error',j);s.listen(port,'127.0.0.1',r);});}return {adminPort:p,gatewayPort:p+1};}catch{}finally{for(const s of servers)s.close();}}throw new Error('No free ports');}
async function run(data,...args){return exec(process.execPath,[cli,...args,'--data-dir',data],{windowsHide:true,timeout:15000});}
async function boot(data,p,...flags){
  const child=spawn(process.execPath,[cli,'serve','--data-dir',data,'--admin-port',String(p.adminPort),'--gateway-port',String(p.gatewayPort),...flags],{windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>{output+=b;});child.stderr.on('data',b=>{output+=b;});
  try{for(let i=0;i<150;i++){if(child.exitCode!==null)throw new Error(output);try{if((await fetch(`http://127.0.0.1:${p.gatewayPort}/health`)).ok)return child;}catch{}await wait(50);}throw new Error(`Service failed: ${output}`);}catch(e){child.kill();throw e;}
}
async function exit(child){if(child.exitCode!==null)return;await Promise.race([once(child,'exit'),wait(10000).then(()=>{throw new Error('Service did not exit');})]);}
test('CLI locks the data directory, backs up an existing SQLite store, persists the inbox, and stops by verified service identity',async t=>{
  const data=await mkdtemp(join(tmpdir(),'linebridge-service-test-')),p=await ports();let child;
  t.after(async()=>{if(child?.exitCode===null){child.kill();await exit(child);}const path=resolve(data),base=resolve(tmpdir())+sep;if(!path.startsWith(base)||!path.slice(base.length).startsWith('linebridge-service-test-'))throw new Error('Unsafe cleanup');await rm(path,{recursive:true,force:true});});
  // A schema-compatible database models the previous Rust store before migration.
  await Vault.open(data);const original=new Store(join(data,'bridge.sqlite')),a=original.addAccount('Migration account','demo','IOSIPAD');original.connect(a.id,true);original.putChat(a.id,{id:'demo-group',name:'room',kind:'group'});original.designate(a.id,'demo-group',true);original.setSetting(`monitor:${a.id}`,true);original.close();
  child=await boot(data,p,'--trust-local');const base=`http://127.0.0.1:${p.adminPort}`,page=await fetch(base),cookie=page.headers.getSetCookie()[0].split(';')[0];
  const call=async(path,method='GET',body)=>{const response=await fetch(`${base}/admin${path}`,{method,headers:{Cookie:cookie,Origin:base,'X-Line-Bridge':'dashboard','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});assert.ok(response.ok,await response.clone().text());return response.json();};
  const state=await call('/state');assert.equal(state.backend,'node');assert.equal(state.accounts[0].id,a.id);assert.equal(state.accounts[0].monitor.enabled,true);assert.equal(state.tunnel.provider,'local');assert.equal(state.tunnel.connected,true);
  const files=await readdir(join(data,'backups'));assert.equal(files.length,1);assert.ok(files[0].startsWith('before-archive-'));
  await assert.rejects(run(data,'serve','--admin-port',String(p.adminPort+10),'--gateway-port',String(p.gatewayPort+10)),e=>/bridge_already_running/.test(e.stderr));
  const info=JSON.parse((await run(data,'status')).stdout);assert.equal(info.status,'running');assert.equal(info.authentication,'local');assert.equal(info.mcpUrl,`http://127.0.0.1:${p.gatewayPort}/mcp`);
  assert.equal((await fetch(`http://127.0.0.1:${p.gatewayPort}/api/v1/accounts`)).status,200);
  await call(`/accounts/${a.id}/chats/demo-group/messages`,'POST',{text:'persistent synthetic text',idempotencyKey:'persist-0001'});assert.equal((await call(`/accounts/${a.id}/events`)).events.length,1);
  await call(`/accounts/${a.id}/local-access`,'PUT',{read:true,send:false});
  assert.equal((await fetch(`${base}/admin/shutdown`,{method:'POST',headers:{Cookie:cookie,Origin:base,'X-Line-Bridge':'dashboard','Content-Type':'application/json'},body:JSON.stringify({instance:'wrong'})})).status,409);
  if(process.platform!=='win32'){assert.equal((await stat(join(data,'vault-key.bin'))).mode&0o777,0o600);assert.equal((await stat(data)).mode&0o777,0o700);}
  await run(data,'stop');await exit(child);assert.equal(JSON.parse((await run(data,'status')).stdout).status,'stopped');
  child=await boot(data,p,'--trust-local');const again=await fetch(base),againCookie=again.headers.getSetCookie()[0].split(';')[0];
  const persisted=await (await fetch(`${base}/admin/accounts/${a.id}/events`,{headers:{Cookie:againCookie}})).json();assert.equal(persisted.events[0].message.text,'persistent synthetic text');assert.equal((await readdir(join(data,'backups'))).length,1);
  const localAccounts=await (await fetch(`http://127.0.0.1:${p.gatewayPort}/api/v1/accounts`)).json();assert.equal(localAccounts[0].permissions.send,false);
  // Simulate a crash: the OS releases the lock and stale metadata cannot block recovery.
  child.kill('SIGKILL');await exit(child);child=await boot(data,p,'--require-token');assert.equal((await fetch(`http://127.0.0.1:${p.gatewayPort}/api/v1/accounts`)).status,401);assert.equal(JSON.parse((await run(data,'status')).stdout).authentication,'token');
  const strictPage=await fetch(base),strictCookie=strictPage.headers.getSetCookie()[0].split(';')[0],strictState=await (await fetch(`${base}/admin/state`,{headers:{Cookie:strictCookie}})).json();assert.equal(strictState.tunnel.provider,'local','An upgrade preserves a legacy store with no explicit provider setting.');
  await run(data,'stop');await exit(child);
  assert.ok(!(await readFile(join(data,'bridge.sqlite'))).includes(Buffer.from('persistent synthetic text')));
});
