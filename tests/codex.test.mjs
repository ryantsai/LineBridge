import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,lstat,symlink,link,chmod,chown} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {parse as parseToml} from 'smol-toml';
import {runCodex} from '../client/codex.mjs';
import {READ_TOOLS,SEND_TOOLS} from '../client/mcp.mjs';
import {removeClientFixture} from './client-test-utils.mjs';
import {syntheticCodexFiles} from './codex-test-utils.mjs';

async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'linebridge-codex-'));t.after(()=>removeClientFixture(root));
  const project=join(root,'project'),home=join(root,'codex-home'),profiles=join(root,'protected-profiles');
  await mkdir(project);await mkdir(home);
  const context={env:{CODEX_HOME:home,LINE_BRIDGE_CLIENT_CONFIG:profiles,LINE_BRIDGE_TOKEN:'do-not-copy-environment-secret'},fileOps:syntheticCodexFiles,launcher:{node:process.execPath,script:resolve('bin/linebridge.mjs')},store:{get:()=>assert.fail('No credential access')},fetchImpl:()=>assert.fail('No network')};
  const scope=['--scope','project','--project',project],settings=['--profile','existing-profile','--url','http://127.0.0.1:3211'];
  const cli=async(args,extra={})=>{let stdout='',stderr='';const code=await runCodex(args,{...context,...extra,stdout:{write:s=>{stdout+=s;}},stderr:{write:s=>{stderr+=s;}}});return {code,json:JSON.parse(stdout),stdout,stderr};};
  const file=join(project,'.codex','config.toml');
  return {root,project,home,profiles,context,scope,settings,cli,file,
    install:async(extra=[])=>{const preview=await cli(['preview',...scope,...settings,...extra]);assert.equal(preview.code,0,preview.stdout);const result=await cli(['install',...scope,...settings,...extra,'--consent',preview.json.consent]);assert.equal(result.code,0,result.stdout);return result;}};
}
test('preview is offline and nonmutating; install needs an exact reviewed operation and scope',async t=>{
  const f=await fixture(t),args=[...f.scope,...f.settings];
  const preview=await f.cli(['preview',...args]);assert.equal(preview.code,0);assert.equal(preview.json.change,'add');assert.equal(preview.json.applied,false);
  assert.deepEqual(await readdir(f.project),[]);assert.deepEqual(await readdir(f.home),[]);
  assert.equal(preview.json.profile,'existing-profile');assert.deepEqual(preview.json.configuration.enabled_tools,READ_TOOLS);assert.ok(!preview.stdout.includes('do-not-copy-environment-secret'));
  assert.equal((await f.cli(['install',...args])).code,2);
  for(const changes of [['--tools','read-send'],['--name','different']])assert.equal((await f.cli(['install',...args,...changes,'--consent',preview.json.consent])).json.error,'codex_consent_stale');
  assert.equal((await f.cli(['install','--scope','user',...f.settings,'--consent',preview.json.consent])).json.error,'codex_consent_stale');
  assert.equal((await f.cli(['uninstall',...f.scope,'--consent',preview.json.consent])).json.error,'codex_consent_stale');
  assert.deepEqual(await readdir(f.project),[]);
  await f.install();assert.deepEqual(await readdir(f.home),[]);
  assert.equal((await f.cli(['verify',...f.scope])).json.connected,false);
});
test('install and uninstall preserve comments, profiles, unrelated servers and exact original bytes',async t=>{
  const f=await fixture(t);await mkdir(join(f.project,'.codex'));
  const original='# private synthetic config\r\nmodel = "example"\r\nlarge = 9223372036854775807\r\nwhen = 2026-10-08T01:02:03Z\r\n[profiles.daily]\r\nmodel_reasoning_effort = "medium"\r\n[mcp_servers.other]\r\ncommand = "example"\r\nsecret = "existing-synthetic-do-not-echo"';
  await writeFile(f.file,original,{mode:0o600});
  await writeFile(join(f.home,'special.config.toml'),'# separate profile must survive\n');
  const added=await f.install();assert.ok(!added.stdout.includes('existing-synthetic-do-not-echo'));
  const installed=await readFile(f.file,'utf8');assert.ok(installed.startsWith(original));assert.equal(parseToml(installed,{integersAsBigInt:'asNeeded'}).mcp_servers.linebridge.args[3],'existing-profile');
  assert.equal((await f.install()).json.change,'none');assert.equal(await readFile(f.file,'utf8'),installed);
  const preview=await f.cli(['preview','--action','uninstall',...f.scope]);assert.equal(preview.code,0,preview.stdout);
  const removed=await f.cli(['uninstall',...f.scope,'--consent',preview.json.consent]);assert.equal(removed.code,0,removed.stdout);
  assert.equal(await readFile(f.file,'utf8'),original);assert.equal(await readFile(join(f.home,'special.config.toml'),'utf8'),'# separate profile must survive\n');
  assert.deepEqual(await readdir(join(f.project,'.codex')),['config.toml']);
});
test('explicit user location and replacement preserve scope; removal retains profiles and later unrelated changes',async t=>{
  const f=await fixture(t),scope=['--scope','user','--codex-home',f.home];
  await mkdir(f.profiles);await writeFile(join(f.profiles,'unrelated.dpapi'),'synthetic ciphertext');
  const preview=await f.cli(['preview',...scope,...f.settings]);assert.equal(preview.json.file,join(f.home,'config.toml'));
  assert.equal((await f.cli(['install',...scope,...f.settings,'--consent',preview.json.consent])).code,0);
  const replacement=[...scope,...f.settings,'--tools','read-send'];
  assert.equal((await f.cli(['preview',...replacement])).json.error,'codex_replace_required');
  const p=await f.cli(['preview',...replacement,'--replace']);assert.equal(p.code,0,p.stdout);assert.equal(p.json.change,'replace');
  assert.equal((await f.cli(['install',...replacement,'--replace','--consent',p.json.consent])).code,0);
  assert.deepEqual(parseToml(await readFile(join(f.home,'config.toml'),'utf8')).mcp_servers.linebridge.enabled_tools,[...READ_TOOLS,...SEND_TOOLS]);
  const other='\n[profiles.new]\nmodel = "keep-me"\n';await writeFile(join(f.home,'config.toml'),(await readFile(join(f.home,'config.toml'),'utf8'))+other);
  const remove=await f.cli(['preview','--action','uninstall',...scope]);assert.equal(remove.code,0,remove.stdout);
  assert.equal((await f.cli(['uninstall',...scope,'--consent',remove.json.consent])).code,0);
  assert.equal(await readFile(join(f.home,'config.toml'),'utf8'),other);assert.equal(await readFile(join(f.profiles,'unrelated.dpapi'),'utf8'),'synthetic ciphertext');
});
test('stale preview, changed paths, and edits during commit cannot overwrite the newer config',async t=>{
  const f=await fixture(t),args=[...f.scope,...f.settings],p=await f.cli(['preview',...args]);
  await mkdir(join(f.project,'.codex'));await writeFile(f.file,'model = "newer"\n');
  assert.equal((await f.cli(['install',...args,'--consent',p.json.consent])).json.error,'codex_consent_stale');
  const fresh=await f.cli(['preview',...args]);
  const raced=await f.cli(['install',...args,'--consent',fresh.json.consent],{beforeCommit:()=>writeFile(f.file,'model = "concurrent"\n')});
  assert.equal(raced.json.error,'codex_config_changed');assert.equal(await readFile(f.file,'utf8'),'model = "concurrent"\n');
  assert.deepEqual(await readdir(join(f.project,'.codex')),['config.toml']);
});
test('foreign, malformed, duplicated and modified entries fail closed without revealing file contents',async t=>{
  const f=await fixture(t);await mkdir(join(f.project,'.codex'));
  for(const text of ['[mcp_servers.linebridge]\nurl="https://foreign.example/mcp"\n','mcp_servers = { linebridge = { command = "foreign" } }\n','mcp_servers."linebridge".command="foreign"\n',"['mcp_servers'.'linebridge']\ncommand='foreign'\n"]){
    await writeFile(f.file,text);assert.equal((await f.cli(['preview',...f.scope,...f.settings,'--replace'])).json.error,'codex_entry_conflict');assert.equal(await readFile(f.file,'utf8'),text);
  }
  await writeFile(f.file,'secret = "private-synthetic-config\n');const bad=await f.cli(['preview',...f.scope,...f.settings]);assert.equal(bad.json.error,'codex_config_invalid');assert.ok(!bad.stdout.includes('private-synthetic-config'));
  await writeFile(f.file,'');await f.install();const installed=await readFile(f.file,'utf8');
  for(const text of [installed.replace('existing-profile','changed-profile'),installed+installed,installed+'extra="synthetic-secret"\n']){
    await writeFile(f.file,text);const result=await f.cli(['preview','--action','uninstall',...f.scope]);assert.ok(['codex_entry_modified','codex_config_invalid'].includes(result.json.error));assert.ok(!result.stdout.includes('synthetic-secret'));assert.equal(await readFile(f.file,'utf8'),text);
  }
  await writeFile(f.file,'x = """'+installed+'"""\n');assert.equal((await f.cli(['preview','--action','uninstall',...f.scope])).json.error,'codex_entry_modified');
});
test('symlink/hardlink configs, unsafe directories, oversized files and locks are refused',async t=>{
  const f=await fixture(t);await mkdir(join(f.project,'.codex'));
  const foreign=join(f.root,'foreign.toml');await writeFile(foreign,'model="untouched"\n');
  if(process.platform!=='win32'){
    await symlink(foreign,f.file);assert.equal((await f.cli(['preview',...f.scope,...f.settings])).json.error,'codex_config_unsafe');
    const {rm}=await import('node:fs/promises');await rm(f.file);
  }
  await link(foreign,f.file);assert.equal((await f.cli(['preview',...f.scope,...f.settings])).json.error,'codex_config_unsafe');
  const {rm}=await import('node:fs/promises');await rm(f.file);await writeFile(f.file,'#'+'x'.repeat(2*1024*1024));
  assert.equal((await f.cli(['preview',...f.scope,...f.settings])).json.error,'codex_config_unsafe');await rm(f.file);
  const p=await f.cli(['preview',...f.scope,...f.settings]);await writeFile(join(f.project,'.codex','.linebridge-codex.lock'),'synthetic busy');
  assert.equal((await f.cli(['install',...f.scope,...f.settings,'--consent',p.json.consent])).json.error,'codex_config_busy');
  assert.equal(await readFile(foreign,'utf8'),'model="untouched"\n');assert.equal(await readFile(join(f.project,'.codex','.linebridge-codex.lock'),'utf8'),'synthetic busy');
});
test('portable paths with quotes and Unicode remain separate TOML argv values; permissions are preserved',async t=>{
  const f=await fixture(t);f.context.launcher={node:join(f.root,'node path "quoted"'),script:join(f.root,'套件 & $x','linebridge.mjs')};
  await mkdir(join(f.project,'.codex'));await writeFile(f.file,'# keep mode\n');await chmod(f.file,0o640);
  const before=await lstat(f.file);
  await f.install();const entry=parseToml(await readFile(f.file,'utf8')).mcp_servers.linebridge;
  assert.equal(entry.command,f.context.launcher.node);assert.equal(entry.args[0],f.context.launcher.script);assert.ok(!entry.args.some(a=>a.includes('Bearer')));
  if(process.platform!=='win32'){
    const after=await lstat(f.file);assert.equal(after.mode & 0o777,0o640);assert.equal(after.uid,before.uid);assert.equal(after.gid,before.gid);
  }
  assert.equal((await f.cli(['verify',...f.scope])).json.error,'codex_launcher_unavailable');
});
test('POSIX replacements retain a distinct group and refuse special permission bits', {skip:process.platform==='win32'},async t=>{
  const f=await fixture(t);await mkdir(join(f.project,'.codex'));await writeFile(f.file,'# retain ownership\n');
  const before=await lstat(f.file),groups=process.getgroups?.() ?? [],different=groups.find(group=>group!==before.gid) ?? (process.getuid?.()===0 ? before.gid+1 : undefined);
  if(different!==undefined)await chown(f.file,before.uid,different);
  await chmod(f.file,0o640);await f.install();const installed=await lstat(f.file);assert.equal(installed.gid,different ?? before.gid);assert.equal(installed.uid,before.uid);assert.equal(installed.mode & 0o777,0o640);
  await chmod(f.file,0o4600);const contents=await readFile(f.file,'utf8');
  assert.equal((await f.cli(['preview','--action','uninstall',...f.scope])).json.error,'codex_config_unsafe');assert.equal(await readFile(f.file,'utf8'),contents);
});
test('verify --connect probes only the selected installed profile and version; config inspection stays offline',async t=>{
  const f=await fixture(t);await f.install();
  const calls=[];
  const result=await f.cli(['verify',...f.scope,'--connect'],{
    store:{get:async profile=>{assert.equal(profile,'existing-profile');return {url:'http://127.0.0.1:3211',token:'synthetic-only-token'};}},
    fetchImpl:async(url,init)=>{
      const rpc=JSON.parse(init.body);calls.push(rpc.method==='tools/call' ? rpc.params.name : rpc.method);
      const result=rpc.method==='initialize' ? {protocolVersion:rpc.params.protocolVersion,serverInfo:{name:'LineBridge',version:'0.7.13'},capabilities:{tools:{}}} : rpc.method==='tools/list' ? {tools:[{name:'line_get_version',inputSchema:{type:'object'}}]} : {content:[{type:'text',text:'{"service":"LineBridge","version":"0.7.13"}'}]};
      return rpc.id===undefined ? new Response(null,{status:202}) : Response.json({jsonrpc:'2.0',id:rpc.id,result});
    }
  });
  assert.equal(result.code,0,result.stdout);assert.equal(result.json.connected,true);assert.equal(result.json.effectiveCodexConfigurationVerified,false);
  assert.deepEqual(calls,['initialize','notifications/initialized','tools/list','line_get_version']);assert.equal(result.json.missingTools.length,6);assert.ok(!result.stdout.includes('synthetic-only-token'));
});
test('strict CLI input rejects implicit scope, duplicate flags, credentials, invalid URLs and unexpected modes before I/O',async t=>{
  const f=await fixture(t);
  for(const args of [[],['preview',...f.settings],['preview',...f.scope],['install',...f.scope,...f.settings],
    ['preview',...f.scope,...f.settings,'--token','never-echo'],['preview',...f.scope,...f.settings,'--profile','repeated'],
    ['preview',...f.scope,'--profile','p','--url','https://name:never-echo@example.com'],
    ['preview',...f.scope,'--profile','p','--url','http://remote.example'],
    ['preview',...f.scope,...f.settings,'--tools','all'],['preview',...f.scope,...f.settings,'--connect'],
    ['preview','--action','uninstall',...f.scope,...f.settings],['verify',...f.scope,'--profile','p'],
    ['preview',...f.scope,...f.settings,'--name','../bad']]){
    const result=await f.cli(args);assert.equal(result.code,2,JSON.stringify(args));assert.ok(!result.stdout.includes('never-echo'));assert.ok(!result.stderr.includes('never-echo'));
  }
  assert.deepEqual(await readdir(f.project),[]);
  const help=await f.cli(['--help']);assert.equal(help.code,0);assert.match(help.stderr,/preview/);
});
