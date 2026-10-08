import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {root as repository} from '../scripts/packaging.mjs';

assert.equal(process.platform,'darwin');
const node=process.argv[2] ?? process.execPath;
const script=process.argv[3] ?? join(repository,'bin/linebridge.mjs');
const fixture=await mkdtemp(join(tmpdir(),'linebridge-codex-native-'));
const checks=[];
const env={...process.env,LINE_BRIDGE_CLIENT_CONFIG:join(fixture,'unused-profiles')};
for(const key of ['LINE_BRIDGE_TOKEN','LINE_BRIDGE_URL','CF_ACCESS_CLIENT_ID','CF_ACCESS_CLIENT_SECRET'])delete env[key];
const cli=(args,expected=0)=>{
  const result=spawnSync(node,[script,'codex',...args],{cwd:fixture,env,encoding:'utf8',timeout:15000});
  assert.equal(result.status,expected,result.stderr);
  return JSON.parse(result.stdout);
};
const run=(file,args)=>{
  const result=spawnSync(file,args,{cwd:fixture,env,encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,result.stderr);
  return result.stdout;
};
try {
  const project=join(fixture,'project 空間');await mkdir(project);
  const projectFile=join(project,'.codex','config.toml');
  const projectScope=['--scope','project','--project',project];
  const install=['--profile','synthetic-release-only','--url','http://127.0.0.1:1'];
  const preview=cli(['preview',...projectScope,...install]);
  assert.equal(preview.applied,false);assert.equal(preview.tools,'read');
  await assert.rejects(stat(projectFile),{code:'ENOENT'});
  assert.equal(cli(['install',...projectScope,...install,'--consent',preview.consent]).applied,true);
  assert.equal((await stat(projectFile)).mode&0o777,0o600);
  assert.equal(cli(['verify',...projectScope]).launcherAvailable,true);
  assert.equal(cli(['verify',...projectScope]).connected,false);
  const identical=cli(['preview',...projectScope,...install]);assert.equal(identical.change,'none');
  const removal=cli(['preview','--action','uninstall',...projectScope]);
  cli(['uninstall',...projectScope,'--consent',removal.consent]);
  assert.equal(await readFile(projectFile,'utf8'),'');
  checks.push('native first-file preview/install/static verify/idempotence/uninstall; private file and real absolute launcher');

  const chosenCodexDir=join(fixture,'disposable user config');await mkdir(chosenCodexDir);
  const userFile=join(chosenCodexDir,'config.toml');
  const original='# Synthetic fixture only\nmodel = "synthetic-model"\n[profiles.fixture]\nmodel = "synthetic-profile"\n[mcp_servers.other]\ncommand = "synthetic-command"\n';
  await writeFile(userFile,original,{mode:0o640});
  const originalStat=await stat(userFile);
  const originalAttributes=run('/usr/bin/xattr',['-l',userFile]);
  const scope=['--scope','user','--codex-home',chosenCodexDir];
  const add=cli(['preview',...scope,...install]);
  cli(['install',...scope,...install,'--consent',add.consent]);
  const installedStat=await stat(userFile);
  assert.equal(installedStat.mode&0o777,originalStat.mode&0o777);
  assert.equal(installedStat.uid,originalStat.uid);assert.equal(installedStat.gid,originalStat.gid);
  assert.equal(run('/usr/bin/xattr',['-l',userFile]),originalAttributes);
  assert.ok((await readFile(userFile,'utf8')).startsWith(original));
  const changed=['--profile','synthetic-second-profile','--url','http://127.0.0.1:1'];
  assert.equal(cli(['preview',...scope,...changed],6).error,'codex_replace_required');
  const replacement=cli(['preview',...scope,...changed,'--replace']);
  cli(['install',...scope,...changed,'--replace','--consent',replacement.consent]);
  const removed=cli(['preview','--action','uninstall',...scope]);
  cli(['uninstall',...scope,'--consent',removed.consent]);
  assert.equal(await readFile(userFile,'utf8'),original);
  assert.equal(run('/usr/bin/xattr',['-l',userFile]),originalAttributes);
  checks.push('native existing-file replacement preserves unrelated bytes, provenance, owner/group/mode, consent and exact restoration');

  run('/usr/bin/xattr',['-w','com.linebridge.synthetic-release-check','synthetic',userFile]);
  assert.equal(cli(['preview',...scope,...install],6).error,'codex_metadata_unsupported');
  assert.equal(await readFile(userFile,'utf8'),original);
  checks.push('native xattr protection fails closed without modifying fixture');
  run('/usr/bin/xattr',['-d','com.linebridge.synthetic-release-check',userFile]);
  run('/bin/chmod',['+a','everyone allow read',userFile]);
  assert.equal(cli(['preview',...scope,...install],6).error,'codex_metadata_unsupported');
  assert.equal(await readFile(userFile,'utf8'),original);
  run('/bin/chmod',['-N',userFile]);
  checks.push('native ACL protection fails closed without modifying fixture');
  console.log(JSON.stringify({platform:process.platform,hostArchitecture:process.arch,
    targetRuntime:JSON.parse(run(node,['-p','JSON.stringify({version:process.version,arch:process.arch})'])),
    cliScript:script,checks,credentialsCreated:false,realCodexConfigTouched:false}));
} finally {
  assert.ok(resolve(fixture).startsWith(resolve(tmpdir())+'/linebridge-codex-native-'));
  await rm(fixture,{recursive:true,force:true});
}
