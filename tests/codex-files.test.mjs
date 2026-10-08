import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rename} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {codexFileOps} from '../client/codex-files.mjs';
import {runCodex} from '../client/codex.mjs';
import {removeClientFixture} from './client-test-utils.mjs';

test('macOS metadata boundary rejects ACLs, xattrs, flags and unavailable/malformed inspection',async()=>{
  for(const [listing,flags,code] of [['-rw-------+ 1 user group 1 date config\n','0',0],['-rw-------@ 1 user group 1 date config\n','0',0],['-rw------- 1 user group 1 date config\n','2',0],['unexpected-synthetic-private-output','0',0],['-rw------- 1 user group 1 date config\n','0',1]]){
    const ops=codexFileOps({platform:'darwin',run:async(file,args,options)=>{assert.equal(options.env.LC_ALL,'C');return {code,stdout:file==='/bin/ls' ? listing : flags};}});
    await assert.rejects(ops.inspect('/synthetic/config.toml'),e=>e.code==='codex_metadata_unsupported'&&!e.message.includes('private-output'));
  }
  const calls=[],ops=codexFileOps({platform:'darwin',run:async(file,args)=>{calls.push({file,args});return {code:0,stdout:file==='/bin/ls' ? '-rw------- 1 user group 1 date config\n' : '0\n'};}});
  const metadata=await ops.inspect('/synthetic/config.toml');assert.equal(metadata.kind,'darwin');
  await ops.prepare('/synthetic/config.toml','/synthetic/empty.tmp',metadata);
  assert.deepEqual(calls.map(c=>c.file),['/bin/ls','/usr/bin/stat','/bin/chmod']);assert.deepEqual(calls[2].args,['-N','/synthetic/empty.tmp']);
});
test('Windows native boundary uses private Unicode-safe paths, checks custom protection, and never ignores metadata merge errors',async()=>{
  const calls=[],file='C:\\synthetic\\私人 $(`literal`)\\config.toml',temporary='C:\\synthetic\\empty.tmp';
  const ops=codexFileOps({platform:'win32',env:{SystemRoot:'C:\\Windows'},run:async(command,args,{input})=>{
    const data=JSON.parse(Buffer.from(input,'base64').toString('utf8'));calls.push(data);
    assert.equal(data.file,file);assert.ok(!args.join(' ').includes(file));assert.match(args.at(-1),/AreAccessRulesProtected/);assert.match(args.at(-1),/IsInherited/);assert.match(args.at(-1),/Get-Acl -LiteralPath \$i\.file -Audit/);assert.match(args.at(-1),/AreAuditRulesProtected/);assert.match(args.at(-1),/\$descriptor -match 'S:'/);assert.match(args.at(-1),/File\]::Replace\(\$i\.temporary,\$i\.file,\$null,\$false\)/);
    return {code:0,stdout:data.op==='inspect' ? '{"attributes":32,"descriptor":"synthetic-private-SDDL"}' : ''};
  }});
  const metadata=await ops.inspect(file);await ops.prepare(file,temporary,metadata);await ops.replace(temporary,file,metadata);
  assert.deepEqual(calls.map(c=>c.op),['inspect','prepare','replace']);assert.equal(calls[1].descriptor,'synthetic-private-SDDL');assert.match(metadata.signature,/^[a-f0-9]{64}$/);
  for(const code of [1,2])await assert.rejects(codexFileOps({platform:'win32',run:async()=>({code,stdout:'private-native-error'})}).inspect(file),e=>e.code==='codex_metadata_unsupported'&&!e.message.includes('private-native-error'));
});
async function fixture(t,fileOps,{existing=true}={}) {
  const directory=await mkdtemp(join(tmpdir(),'linebridge-codex-metadata-'));t.after(()=>removeClientFixture(directory));
  await mkdir(join(directory,'.codex'));const file=join(directory,'.codex','config.toml');if(existing)await writeFile(file,'model="synthetic-original"\n');
  const args=['--scope','project','--project',directory,'--profile','synthetic','--url','http://127.0.0.1:1'];
  const cli=async(argv,extra={})=>{let stdout='';const code=await runCodex(argv,{env:{LINE_BRIDGE_CLIENT_CONFIG:join(directory,'unused')},fileOps,launcher:{node:process.execPath,script:resolve('bin/linebridge.mjs')},store:{get:()=>assert.fail('No credential access')},fetchImpl:()=>assert.fail('No network'),stdout:{write:s=>{stdout+=s;}},stderr:{write:()=>{}},...extra});return {code,json:JSON.parse(stdout),stdout};};
  return {directory,file,args,cli};
}
test('new protection after preview fails closed before replacement and leaves no copied config',async t=>{
  let protectedFile=false;
  const ops=codexFileOps({platform:'darwin',run:async(file)=>({code:0,stdout:file==='/bin/ls' ? `-rw-------${protectedFile?'+':' '} 1 user group 1 date config\n` : '0\n'})});
  const f=await fixture(t,ops),preview=await f.cli(['preview',...f.args]);assert.equal(preview.code,0,preview.stdout);
  const result=await f.cli(['install',...f.args,'--consent',preview.json.consent],{beforeCommit:()=>{protectedFile=true;}});
  assert.equal(result.json.error,'codex_metadata_unsupported');assert.equal(await readFile(f.file,'utf8'),'model="synthetic-original"\n');assert.deepEqual(await readdir(join(f.directory,'.codex')),['config.toml']);
  assert.equal((await f.cli(['preview',...f.args])).json.error,'codex_metadata_unsupported');
});
test('first install refuses unavailable or unsupported candidate protection before writing or publishing',async t=>{
  for(const [platform,behavior] of [['win32','unavailable'],['win32','refused'],['darwin','unavailable'],['darwin','custom-acl']]){
    let calls=0;
    const ops=codexFileOps({platform,run:async(command,args,{input})=>{
      calls++;const candidate=platform==='win32' ? JSON.parse(Buffer.from(input,'base64').toString('utf8')).file : args.at(-1);
      assert.equal(await readFile(candidate,'utf8'),'');
      if(behavior==='unavailable')throw new Error('synthetic-private-helper-error');
      if(behavior==='refused')return {code:2,stdout:'synthetic-private-helper-error'};
      return {code:0,stdout:command==='/bin/ls' ? '-rw-------+ 1 user group 0 date candidate\n' : '0\n'};
    }});
    const f=await fixture(t,ops,{existing:false}),preview=await f.cli(['preview',...f.args]);assert.equal(preview.code,0);assert.equal(calls,0);
    const result=await f.cli(['install',...f.args,'--consent',preview.json.consent]);
    assert.equal(result.json.error,'codex_metadata_unsupported');assert.ok(calls>0);assert.ok(!result.stdout.includes('synthetic-private-helper-error'));
    await assert.rejects(readFile(f.file),{code:'ENOENT'});assert.deepEqual(await readdir(join(f.directory,'.codex')),[]);
    assert.equal((await f.cli(['verify','--scope','project','--project',f.directory])).json.error,'codex_not_installed');
  }
});
test('first install rechecks the completed candidate and refuses newly unsupported protection before publication',async t=>{
  let protectedFile=false;const observed=[];
  const ops=codexFileOps({platform:'darwin',run:async(command,args)=>{
    if(command==='/bin/ls')observed.push(await readFile(args.at(-1),'utf8'));
    return {code:0,stdout:command==='/bin/ls' ? `-rw-------${protectedFile?'+':' '} 1 user group 0 date candidate\n` : '0\n'};
  }});
  const f=await fixture(t,ops,{existing:false}),preview=await f.cli(['preview',...f.args]);assert.equal(preview.code,0);
  const result=await f.cli(['install',...f.args,'--consent',preview.json.consent],{beforeCommit:()=>{protectedFile=true;}});
  assert.equal(result.json.error,'codex_metadata_unsupported');assert.equal(observed[0],'');assert.ok(observed.some(text=>text.includes('[mcp_servers.linebridge]')));
  await assert.rejects(readFile(f.file),{code:'ENOENT'});assert.deepEqual(await readdir(join(f.directory,'.codex')),[]);
});
test('first install with supported modeled metadata remains verifiable and removable through the public command path',async t=>{
  for(const platform of ['darwin','win32']){
    const candidates=[];
    const ops=codexFileOps({platform,run:async(command,args,{input})=>{
      if(platform==='darwin'){
        if(command==='/bin/ls' && args.at(-1).endsWith('.tmp'))candidates.push(await readFile(args.at(-1),'utf8'));
        return {code:0,stdout:command==='/bin/ls' ? '-rw------- 1 user group 0 date candidate\n' : '0\n'};
      }
      const data=JSON.parse(Buffer.from(input,'base64').toString('utf8'));
      if(data.op==='inspect'){
        if(data.file.endsWith('.tmp'))candidates.push(await readFile(data.file,'utf8'));
        return {code:0,stdout:'{"descriptor":"synthetic-private-SDDL","attributes":32}'};
      }
      if(data.op==='prepare')assert.equal(await readFile(data.temporary,'utf8'),'');
      if(data.op==='replace')await rename(data.temporary,data.file);
      return {code:0,stdout:''};
    }});
    const f=await fixture(t,ops,{existing:false}),scope=['--scope','project','--project',f.directory];
    const preview=await f.cli(['preview',...f.args]);assert.equal(preview.code,0);
    const installed=await f.cli(['install',...f.args,'--consent',preview.json.consent]);assert.equal(installed.code,0,installed.stdout);assert.equal(candidates[0],'');assert.ok(candidates.some(text=>text.includes('[mcp_servers.linebridge]')));
    const verified=await f.cli(['verify',...scope]);assert.equal(verified.code,0,verified.stdout);assert.equal(verified.json.configured,true);assert.equal(verified.json.connected,false);
    const removal=await f.cli(['preview','--action','uninstall',...scope]);assert.equal(removal.code,0,removal.stdout);
    const removed=await f.cli(['uninstall',...scope,'--consent',removal.json.consent]);assert.equal(removed.code,0,removed.stdout);assert.equal(await readFile(f.file,'utf8'),'');
    assert.deepEqual(await readdir(join(f.directory,'.codex')),['config.toml']);assert.equal((await f.cli(['verify',...scope])).json.error,'codex_not_installed');
  }
});
test('Windows protection is applied to an empty candidate; unconfirmed replacement retains it for recovery without retry',async t=>{
  let replaced=0,prepared=0;
  const ops=codexFileOps({platform:'win32',run:async(file,args,{input})=>{
    const data=JSON.parse(Buffer.from(input,'base64').toString('utf8'));
    if(data.op==='inspect')return {code:0,stdout:'{"descriptor":"synthetic-private-SDDL","attributes":32}'};
    if(data.op==='prepare'){assert.equal(await readFile(data.temporary,'utf8'),'');prepared++;return {code:0,stdout:''};}
    replaced++;return {code:1,stdout:'never-echo-native-error'};
  }});
  const f=await fixture(t,ops),preview=await f.cli(['preview',...f.args]);assert.equal(preview.code,0);
  const result=await f.cli(['install',...f.args,'--consent',preview.json.consent]);assert.equal(result.json.error,'codex_replace_unconfirmed');assert.equal(prepared,1);assert.equal(replaced,1);
  assert.equal(await readFile(f.file,'utf8'),'model="synthetic-original"\n');const files=await readdir(join(f.directory,'.codex'));assert.equal(files.length,2);assert.ok(files.some(f=>/^\.linebridge-codex-.*\.tmp$/.test(f)));assert.ok(!result.stdout.includes('private-SDDL'));assert.ok(!result.stdout.includes('never-echo'));
});

test('macOS provenance is read opaquely; extra attributes, ACLs and malformed provenance still fail closed',async()=>{
  const listing='-rw-------@ 1 user group 1 date config\n\tcom.apple.provenance\t11 \n';
  const make=(text=listing,raw='01 02 00 00\n')=>codexFileOps({platform:'darwin',run:async(command)=>({code:0,stdout:command==='/bin/ls'?text:command==='/usr/bin/stat'?'0\n':raw})});
  const a=await make().inspect('/synthetic/config.toml');
  const b=await make(listing,'01 02 00 01\n').inspect('/synthetic/config.toml');
  assert.equal(a.kind,'darwin');assert.notEqual(a.signature,b.signature);
  for(const text of [listing+' 0: everyone allow read\n',listing+'\tcom.example.other\t1 \n',listing.replace('com.apple.provenance','com.apple.quarantine')])await assert.rejects(make(text).inspect('/synthetic/config.toml'),{code:'codex_metadata_unsupported'});
  for(const raw of ['', '0', 'private-native-error', '00'.repeat(4097)])await assert.rejects(make(listing,raw).inspect('/synthetic/config.toml'),{code:'codex_metadata_unsupported'});
});
test('a native replacement cannot change or drop the existing provenance',async t=>{
  for(const candidateSignature of ['different-provenance','absent-provenance']){
    const ops={inspect:async file=>({kind:'darwin',signature:file.endsWith('.tmp')?candidateSignature:'existing-provenance'}),prepare:async()=>{},replace:()=>assert.fail('No replacement may occur')};
    const f=await fixture(t,ops),preview=await f.cli(['preview',...f.args]);assert.equal(preview.code,0);
    const result=await f.cli(['install',...f.args,'--consent',preview.json.consent]);
    assert.equal(result.json.error,'codex_metadata_unsupported');
    assert.equal(await readFile(f.file,'utf8'),'model="synthetic-original"\n');
    assert.deepEqual(await readdir(join(f.directory,'.codex')),['config.toml']);
  }
});
