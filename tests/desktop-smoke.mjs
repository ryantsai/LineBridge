// Synthetic-only integration of the packaged runtime, archive and native lifetime.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {once} from 'node:events';
import {VERSION} from '../server/version.mjs';

const root=process.cwd(),serviceOnly=process.argv.includes('--service-only');
const data=await mkdtemp(join(tmpdir(),'linebridge-desktop-'));
const native=process.env.LINE_BRIDGE_DESKTOP_BINARY??(process.platform==='win32'?join(root,'target/release/LineBridge.exe'):join(root,'target/release/bundle/macos/LineBridge.app/Contents/MacOS/LineBridge'));
const node=join(root,'runtime',process.platform==='win32'?'node.exe':'node');
if(!existsSync(serviceOnly?node:native))throw new Error('Build the desktop first, or use --service-only after bundling the service.');
const admin='http://127.0.0.1:4530',gateway='http://127.0.0.1:4531';
let child,meta;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function start(){
  child=spawn(serviceOnly?node:native,serviceOnly?[join(root,'runtime/app/server/desktop.mjs')]:[],{cwd:root,env:{...process.env,LINE_BRIDGE_DATA:data,LINE_BRIDGE_ADMIN_PORT:'4530',LINE_BRIDGE_GATEWAY_PORT:'4531',LINE_BRIDGE_HIDE_WINDOW:'1',LINE_BRIDGE_CLOUDFLARED:join(root,'tools',process.platform==='win32'?'cloudflared.exe':'cloudflared')},stdio:['pipe','ignore','pipe'],windowsHide:true});
  let error,output='';child.on('error',e=>{error=e;});child.stderr.on('data',b=>{output+=b;});
  for(let i=0;i<200;i++){
    if(error)throw error;if(child.exitCode!==null||child.signalCode!==null)throw new Error(`Desktop exited before startup: ${output.slice(0,8000)}`);
    try{const health=await fetch(`${gateway}/health`,{signal:AbortSignal.timeout(300)});if(health.ok){assert.equal((await health.json()).version,VERSION);meta=JSON.parse(await readFile(join(data,'service.json'),'utf8'));return;}}catch{}
    await wait(100);
  }
  throw new Error(`Desktop did not start its bundled service: ${output.slice(0,8000)}`);
}
async function stop(){
  if(!child)return;
  if(child.exitCode===null&&child.signalCode===null){if(serviceOnly)child.stdin.write('shutdown\n');else child.kill();await Promise.race([once(child,'exit'),wait(15000)]);}
  // Parent death closes the private pipe; the service closes LINE and tunnels.
  for(let i=0;i<100;i++){if(!existsSync(join(data,'service.json')))break;await wait(100);}
  assert.equal(existsSync(join(data,'service.json')),false,'Owned service must not survive the desktop');
  let alive=true;for(let i=0;i<100;i++){try{process.kill(meta.pid,0);}catch{alive=false;break;}await wait(100);}assert.equal(alive,false,'No orphan Node service');
  child=null;
}
try{
  await start();
  let cookie;
  const session=async()=>{const page=await fetch(admin);assert.equal(page.status,200);assert.match(await page.text(),/封存搜尋/);cookie=page.headers.getSetCookie()[0].split(';')[0];};await session();
  const call=async(path,method='GET',body)=>{const response=await fetch(`${admin}/admin${path}`,{method,headers:{Cookie:cookie,Origin:admin,'X-Line-Bridge':'dashboard','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const value=await response.json();assert.equal(response.ok,true,JSON.stringify(value));return value;};
  const state=await call('/state');assert.equal(state.gateway.authentication,'token');assert.equal(state.tunnel.provider,'cloudflare_quick');assert.equal(state.tunnel.cloudflaredInstalled,true);
  assert.equal((await fetch(`${gateway}/api/v1/accounts`)).status,401);
  const account=await call('/accounts','POST',{label:'Bundled synthetic account',kind:'demo'});
  await call(`/accounts/${account.id}/chats/demo-group`,'PATCH',{enabled:true});await call(`/accounts/${account.id}/monitor`,'POST',{enabled:true});
  const text='Desktop archive 日本語 العربية 🧑🏽‍💻',token=await call('/tokens','POST',{name:'Synthetic reader',grants:[{accountId:account.id,read:true,send:false}]});
  await call(`/accounts/${account.id}/chats/demo-group/messages`,'POST',{text,idempotencyKey:'desktop-synthetic-0001'});
  const search=async()=>{const response=await fetch(`${gateway}/api/v1/messages/search`,{method:'POST',headers:{Authorization:`Bearer ${token.token}`,'Content-Type':'application/json'},body:JSON.stringify({query:'日本語 العربية',mode:'all'})});assert.equal(response.status,200);const value=await response.json();assert.equal(value.results[0].message.text,text);return value;};
  await search();assert.equal((await call('/state')).accounts[0].monitor.storedMessages,1);
  await stop();await start();await session();await search();
  assert.equal((await call('/state')).accounts[0].monitor.enabled,true);
  await stop();
  console.log(`${serviceOnly?'Bundled service':'Native desktop'}: scoped auth, multilingual archive search, encrypted restart persistence, restored monitor preferences and owned-process shutdown passed. Synthetic sends only.`);
}finally{
  if(child)await stop();
  const target=resolve(data);if(!target.startsWith(resolve(tmpdir())+sep)||!target.split(sep).at(-1).startsWith('linebridge-desktop-'))throw new Error('Unsafe cleanup');await rm(target,{recursive:true,force:true});
}
