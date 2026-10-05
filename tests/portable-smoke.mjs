import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {mkdir,mkdtemp,readFile,writeFile,readdir,copyFile} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {portablePlan} from '../scripts/portable.mjs';
import {root,sha256,verifyChecksum} from '../scripts/packaging.mjs';
import {VERSION} from '../server/version.mjs';
import {removeClientFixture} from './client-test-utils.mjs';

const plan=portablePlan(),fixture=await mkdtemp(join(tmpdir(),'linebridge-portable-'));
const extracted=join(fixture,'extracted 空間 !'),cwd=join(fixture,'caller folder'),emptyPath=join(fixture,'empty-path'),data=join(fixture,'synthetic data');
const env={...process.env};
for(const key of Object.keys(env))if(/^(path|node_options|node_path|line_bridge_.*|cf_access_.*)$/i.test(key))delete env[key];
env.PATH=emptyPath;env.LINE_BRIDGE_CLIENT_CONFIG=join(fixture,'synthetic-client');
let bin,service,serviceClosed,serviceOutput='',ownedPid;

function launch(args,extraEnv={}){
  if(process.platform==='win32'){
    // A .cmd launcher requires cmd; quote every token and disable AutoRun and
    // delayed expansion. Fixture arguments deliberately include spaces/Unicode.
    const quoted=[bin,...args].map(arg=>{assert.doesNotMatch(arg,/["%\r\n]/);return `"${arg}"`;}).join(' ');
    return spawn(join(process.env.SystemRoot,'System32','cmd.exe'),['/d','/v:off','/s','/c',`"${quoted}"`],{cwd,env:{...env,...extraEnv},windowsHide:true,windowsVerbatimArguments:true,stdio:['pipe','pipe','pipe']});
  }
  return spawn(bin,args,{cwd,env:{...env,...extraEnv},stdio:['pipe','pipe','pipe']});
}
async function run(args,{input='',credentials={}}={}){
  const child=launch(args,credentials);
  return new Promise((resolve,reject)=>{
    let stdout='',stderr='';
    const timer=setTimeout(()=>{child.kill();reject(new Error(`Portable command timed out: ${args[0]}`));},20000);
    child.stdout.on('data',b=>{stdout+=b;});child.stderr.on('data',b=>{stderr+=b;});
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr});});
    child.stdin.end(input);
  });
}
async function json(args,options){const result=await run(args,options);assert.equal(result.code,0,result.stderr||result.stdout);return JSON.parse(result.stdout);}
async function port(){
  const server=createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const value=server.address().port;await new Promise(resolve=>server.close(resolve));return value;
}
async function start(adminPort,gatewayPort){
  serviceOutput='';ownedPid=undefined;
  service=launch(['serve','--require-token','--data-dir',data,'--admin-port',String(adminPort),'--gateway-port',String(gatewayPort)]);
  service.stdout.on('data',b=>{serviceOutput+=b;});service.stderr.on('data',b=>{serviceOutput+=b;});
  serviceClosed=new Promise((resolve,reject)=>{service.once('close',resolve);service.once('error',reject);});
  for(let i=0;i<150;i++){
    if(service.exitCode!==null)throw new Error(`Portable service exited: ${serviceOutput}`);
    try{
      const meta=JSON.parse(await readFile(join(data,'service.json'),'utf8'));
      assert.equal(meta.dataDir,data);assert.equal(meta.adminPort,adminPort);assert.equal(meta.gatewayPort,gatewayPort);
      const response=await fetch(`http://127.0.0.1:${adminPort}`,{signal:AbortSignal.timeout(1000)});
      assert.equal(response.status,200);const cookie=response.headers.getSetCookie()[0]?.split(';')[0];
      assert.match(await response.text(),/LineBridge/);
      const base=`http://127.0.0.1:${adminPort}`;
      const call=async(path,method='GET',value)=>{
        const response=await fetch(`${base}/admin${path}`,{method,signal:AbortSignal.timeout(5000),headers:{Cookie:cookie,Origin:base,'X-Line-Bridge':'dashboard','Content-Type':'application/json'},...(value?{body:JSON.stringify(value)}:{})});
        const result=await response.json();assert.equal(response.ok,true,JSON.stringify(result));return result;
      };
      assert.equal((await call('/state')).instance,meta.instance);
      ownedPid=meta.pid;return call;
    }catch(error){if(error instanceof assert.AssertionError)throw error;}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error(`Portable service not ready: ${serviceOutput}`);
}
async function stop(){
  if(!service || service.exitCode!==null)return;
  assert.equal((await json(['stop','--data-dir',data])).status,'stopping');
  let timer;try{assert.equal(await Promise.race([serviceClosed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Portable service did not exit')),10000);})]),0,serviceOutput);}finally{clearTimeout(timer);}
  service=null;ownedPid=undefined;
}

try{
  await mkdir(extracted);await mkdir(cwd);await mkdir(emptyPath);
  const out=join(root,'release/portable',plan.slug),info=JSON.parse(await readFile(join(out,'build-info.json'),'utf8'));
  assert.equal(info.filename,basename(info.filename));assert.equal(info.directory,basename(info.directory));
  const archive=join(out,info.filename);verifyChecksum(await readFile(archive),info.sha256,info.filename);
  await copyFile(archive,join(extracted,'bundle.archive'));
  execFileSync('tar',['-xf','bundle.archive'],{cwd:extracted,windowsHide:true,stdio:'pipe'});
  const bundle=join(extracted,info.directory);bin=join(bundle,plan.launcher);
  const node=join(bundle,'runtime',plan.nodeName),nodeInfo=JSON.parse(await readFile(join(bundle,'runtime/node-source.json'),'utf8'));
  assert.equal(sha256(await readFile(node)),nodeInfo.sha256);
  assert.equal(nodeInfo.downloadSha256,plan.sha256);
  assert.deepEqual((await readdir(join(bundle,'runtime'))).sort(),[plan.nodeName,'node-LICENSE.txt','node-source.json'].sort());
  // This executable and all subsequent commands have an empty executable PATH.
  const actual=JSON.parse(execFileSync(node,['-p','JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch})'],{cwd,env,encoding:'utf8',windowsHide:true}));
  assert.equal(actual.version,info.nodeVersion);assert.equal(actual.platform,process.platform);assert.equal(actual.arch,process.arch);
  const version=await run(['--version']);assert.equal(version.code,0);assert.equal(version.stdout.trim(),VERSION);
  assert.ok((await json(['accounts','--help'])).commands.includes('send'));
  const invalid=await run(['send','--text','synthetic']);assert.equal(invalid.code,2);assert.equal(JSON.parse(invalid.stdout).error,'invalid_input');
  // Probe bundled worker startup/IPC without a real LINE account. A disconnect
  // preserves this error independently of health-check error normalization.
  const worker=JSON.parse(execFileSync(node,[join(bundle,'app/protocol/worker.mjs')],{cwd,env,encoding:'utf8',windowsHide:true,timeout:10000,input:JSON.stringify({id:'synthetic',method:'disconnect',params:{accountId:'missing'}})+'\n'}));
  assert.equal(worker.type,'result');assert.equal(worker.id,'synthetic');assert.equal(worker.error.status,409);assert.equal(worker.error.code,'account_disconnected');
  let adminPort=await port(),gatewayPort=await port();
  while(gatewayPort>=65535 || adminPort===gatewayPort || adminPort===gatewayPort+1)gatewayPort=await port();
  const call=await start(adminPort,gatewayPort),gateway=`http://127.0.0.1:${gatewayPort}`;
  async function nativeTray(stop=false){
    const native=join(bundle,process.platform==='win32'?'LineBridge.exe':'LineBridge.app/Contents/MacOS/LineBridge');
    const result=await new Promise((ok,fail)=>{
      const child=spawn(native,['--smoke-test',...(stop?['--smoke-stop']:[]),'--data-dir',data,'--admin-port',String(adminPort),'--gateway-port',String(gatewayPort)],{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
      let output='',errors='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>errors+=b);
      const timer=setTimeout(()=>{child.kill();fail(new Error('Native tray timed out: '+output+errors));},60000);
      child.once('error',e=>{clearTimeout(timer);fail(e);});
      child.once('close',code=>{clearTimeout(timer);ok({code,output,errors});});
    });
    assert.equal(result.code,0,result.output+result.errors);assert.doesNotMatch(result.output,/error\t/);
    assert.ok(result.output.includes(`open\thttp://127.0.0.1:${adminPort}`),result.output);
    assert.match(result.output,/quit\t/);
  }
  if(process.platform!=='linux'){
    assert.equal(info.tray,process.platform==='win32'?'LineBridge.exe':'LineBridge.app');
    await nativeTray();
    assert.equal((await json(['status','--data-dir',data])).pid,ownedPid,'Quitting an attached native tray keeps the service running.');
  }
  assert.equal((await fetch(`${gateway}/api/v1/accounts`)).status,401);
  assert.equal((await json(['status','--data-dir',data])).status,'running');
  const account=await call('/accounts','POST',{label:'Portable synthetic sandbox',kind:'demo'});
  await call(`/accounts/${account.id}/chats/demo-group`,'PATCH',{enabled:true});
  await call(`/accounts/${account.id}/monitor`,'POST',{enabled:true});
  const token=await call('/tokens','POST',{name:'Portable synthetic token',days:1,grants:[{accountId:account.id,read:true,send:true}]});
  const credentials={LINE_BRIDGE_TOKEN:token.token,LINE_BRIDGE_URL:gateway};
  assert.equal((await json(['accounts'],{credentials}))[0].id,account.id);
  assert.equal((await json(['chats','--account',account.id],{credentials}))[0].id,'demo-group');
  const text='會議 日本語 😀\nمتعدد الأسطر\r\nPortable archive\n';
  await writeFile(join(cwd,'message 空間.txt'),text);await writeFile(join(cwd,'query 空間.txt'),'會議');
  const target=['send','--account',account.id,'--chat','demo-group','--key','portable-synthetic-1'];
  const sent=await json([...target,'--text-file','message 空間.txt'],{credentials});assert.equal(sent.delivery,'sandbox_only');assert.equal(sent.replayed,false);
  const replay=await json([...target,'--stdin'],{credentials,input:text});assert.equal(replay.messageId,sent.messageId);assert.equal(replay.replayed,true);
  const search=['search','--account',account.id,'--query-file','query 空間.txt'];
  assert.equal((await json(search,{credentials})).results[0].message.text,text);
  assert.equal((await json(['events','--account',account.id],{credentials})).events[0].message.text,text);
  assert.equal((await json(['read','--account',account.id,'--chat','demo-group','--limit','1'],{credentials})).messages[0].text,text);
  await stop();
  await start(adminPort,gatewayPort);
  assert.equal((await json(search,{credentials})).results[0].message.text,text);
  assert.equal((await json(['events','--account',account.id],{credentials})).events[0].message.text,text);
  await stop();
  if(process.platform!=='linux'){
    // Native launcher starts a detached service, verifies the custom URL, then
    // exercises its Stop service and quit menu through the same IPC path.
    try{await nativeTray(true);assert.equal((await json(['status','--data-dir',data])).status,'stopped');}
    finally{await json(['stop','--data-dir',data]);}
  }
  console.log(`Portable ${plan.slug}: extracted archive, bundled runtime/worker, no Node/npm on PATH, Unicode paths, argument/stdin/exit forwarding, scoped CLI, synthetic sends, archive persistence and shutdown passed.`);
}finally{
  try{await stop();}catch(error){
    // Only a PID obtained from this fixture's verified service instance is ours.
    if(ownedPid)try{process.kill(ownedPid);}catch{}
    service?.kill();throw error;
  }finally{await removeClientFixture(fixture);}
}
