import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,rm,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {removeClientFixture} from './client-test-utils.mjs';
const exec=promisify(execFile),cli=resolve('bin/linebridge.mjs'),tray=resolve('server/tray.mjs');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function freePort(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function ports(){for(;;){const admin=await freePort(),gateway=await freePort();if(gateway<65535&&admin!==gateway&&admin!==gateway+1)return {admin,gateway};}}
async function run(data,command){return JSON.parse((await exec(process.execPath,[cli,command,'--data-dir',data],{windowsHide:true,timeout:20000})).stdout);}
function launch(data,p){
  const child=spawn(process.execPath,[tray,'--data-dir',data,'--admin-port',String(p.admin),'--gateway-port',String(p.gateway)],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  const closed=new Promise(r=>child.on('close',r));
  return {child,closed,get output(){return stdout;},async until(pattern){const end=Date.now()+40000;while(Date.now()<end){if(pattern.test(stdout))return stdout;if(child.exitCode!==null)throw new Error(stdout+stderr);await delay(30);}throw new Error('Tray timeout: '+stdout+stderr);}};
}
async function fixture(t){
  const directory=await mkdtemp(join(tmpdir(),'linebridge-tray-')),data=await realpath(directory),children=[];
  // Match the canonical data directory written by the real CLI and tray.
  t.after(async()=>{for(const item of children){item.child.stdin.end();await item.closed;}try{await run(data,'stop');}catch{}for(let i=0;i<50;i++){if((await run(data,'status')).status==='stopped')break;await delay(100);}await removeClientFixture(directory);});
  return {data,start(p){const item=launch(data,p);children.push(item);return item;}};
}
test('tray starts authenticated service, opens verified custom port, avoids duplicates, and detaches without stopping',async t=>{
  const {data,start}=await fixture(t),p=await ports(),first=start(p);
  await first.until(/ready\t/);
  const state=await run(data,'status');assert.equal(state.authentication,'token');assert.equal(state.adminPort,p.admin);
  first.child.stdin.write('open\n');await first.until(new RegExp(`open\\thttp://127.0.0.1:${p.admin}`));
  const second=start(p);assert.equal(await second.closed,0);assert.match(second.output,/open\thttp:\/\/127.0.0.1:/);assert.match(second.output,/quit\t/);
  assert.equal((await run(data,'status')).pid,state.pid);
  first.child.stdin.write('quit\n');assert.equal(await first.closed,0);assert.equal((await run(data,'status')).pid,state.pid);
  const attached=start({admin:p.admin+1,gateway:p.gateway+3});await attached.until(new RegExp(`ready\\thttp://127.0.0.1:${p.admin}`));
  attached.child.stdin.end();assert.equal(await attached.closed,0);assert.equal((await run(data,'status')).status,'running');
  const stopping=start(p);await stopping.until(/ready\t/);stopping.child.stdin.write('stop\n');assert.equal(await stopping.closed,0);assert.equal((await run(data,'status')).status,'stopped');
});
test('tray refuses an unrelated listener with stale metadata',async t=>{
  const {data,start}=await fixture(t),p=await ports();
  await writeFile(join(data,'service.json'),JSON.stringify({runtime:'node',pid:process.pid,adminPort:p.admin,gatewayPort:p.gateway,instance:'unverified',dataDir:data}));
  const item=start(p);assert.equal(await item.closed,1);assert.match(item.output,/cannot be verified/);assert.doesNotMatch(item.output,/ready\t|open\t/);
  await rm(join(data,'service.json'));
});
test('tray recovers stale service metadata after a crashed process exits',async t=>{
  const {data,start}=await fixture(t),p=await ports();
  const probe=spawn(process.execPath,['-e',''],{windowsHide:true,stdio:'ignore'});
  await new Promise(r=>probe.once('exit',r));
  await writeFile(join(data,'service.json'),JSON.stringify({runtime:'node',pid:probe.pid,adminPort:p.admin,gatewayPort:p.gateway,instance:'crashed',dataDir:data}));
  const item=start(p);await item.until(/ready\t/);item.child.stdin.write('stop\n');assert.equal(await item.closed,0);
});
test('occupied admin or gateway port fails without displacing its owner; released ports allow retry',async t=>{
  const {data,start}=await fixture(t),p=await ports();
  for(const port of [p.admin,p.gateway]){
    const occupied=createServer();await new Promise(r=>occupied.listen(port,'127.0.0.1',r));
    try{
      await assert.rejects(exec(process.execPath,[cli,'serve','--data-dir',data,'--admin-port',String(p.admin),'--gateway-port',String(p.gateway)],{windowsHide:true,timeout:15000}),e=>e.stderr.includes(`Port ${port} is already in use`));
      assert.equal(occupied.listening,true);assert.equal((await run(data,'status')).status,'stopped');
    }finally{await new Promise(r=>occupied.close(r));}
  }
  const item=start(p);await item.until(/ready\t/);item.child.stdin.write('stop\n');assert.equal(await item.closed,0);
});
