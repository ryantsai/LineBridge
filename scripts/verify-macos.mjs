import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildPlan,root,runtimes} from './packaging.mjs';

const plan=buildPlan(process.platform,process.arch,'macos');
const app=join(root,'target/release/bundle/macos/LineBridge.app');
const bin=join(app,'Contents/MacOS'),resources=join(app,'Contents/Resources');
execFileSync('codesign',['--verify','--deep','--strict',app],{stdio:'inherit'});
for(const name of ['LineBridge','node','cloudflared']){
  const arches=execFileSync('lipo',['-archs',join(bin,name)],{encoding:'utf8'}).trim();
  assert.equal(arches,plan.arch==='x64'?'x86_64':'arm64',`${name} must match the DMG architecture`);
}
assert.equal(execFileSync(join(bin,'node'),['--version'],{encoding:'utf8'}).trim(),`v${runtimes.nodeVersion}`);
assert.match(execFileSync(join(bin,'cloudflared'),['--version'],{encoding:'utf8'}),new RegExp(`cloudflared version ${runtimes.cloudflaredVersion.replaceAll('.','\\.')}`));
// Exercise the signed worker with an account that does not exist; no LINE login or send.
const request=JSON.stringify({id:'packaging-check',method:'check',params:{accountId:'synthetic-missing'}})+'\n';
const worker=JSON.parse(execFileSync(join(bin,'node'),[join(resources,'protocol/line-worker.cjs')],{input:request,encoding:'utf8',timeout:20000}).trim());
assert.equal(worker.id,'packaging-check');assert.equal(worker.error.code,'account_disconnected');
const data=await mkdtemp(join(tmpdir(),'linebridge-package-'));
const child=spawn(join(bin,'LineBridge'),[],{env:{...process.env,LINE_BRIDGE_DATA:data,LINE_BRIDGE_ROOT:resources,LINE_BRIDGE_HIDE_WINDOW:'1'},stdio:'ignore'});
let spawnError;child.on('error',error=>{spawnError=error;});
try{
  let ready=false;
  for(let i=0;i<60;i++){
    if(spawnError)throw spawnError;
    if(child.exitCode!==null)throw new Error(`The bundled Mac app exited before becoming ready (${child.exitCode}).`);
    try{
      const health=await (await fetch('http://127.0.0.1:3211/health',{signal:AbortSignal.timeout(500)})).json();
      if(health.backend==='rust'){ready=true;break;}
    }catch{}
    await new Promise(resolve=>setTimeout(resolve,300));
  }
  assert.ok(ready,'The bundled Mac app must start its Rust gateway');
  const response=await fetch('http://127.0.0.1:3210/');assert.equal(response.status,200);assert.match(await response.text(),/LineBridge/);
  console.log(`macOS ${plan.arch}: signatures, native helpers, private worker and native app startup passed. No live LINE messages were sent.`);
}finally{
  if(child.exitCode===null && !spawnError){child.kill();await once(child,'exit');}
  await rm(data,{recursive:true,force:true});
}
