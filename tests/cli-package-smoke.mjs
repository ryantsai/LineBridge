import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync, spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {npm} from '../scripts/npm.mjs';
import {removeClientFixture} from './client-test-utils.mjs';

const root=process.cwd(),directory=await mkdtemp(join(tmpdir(),'linebridge-package-cli-'));
try {
  const info=JSON.parse(await readFile(join(root,'release/npm/package-info.json'),'utf8'));
  // npm honors overrides only in the consumer's root manifest. Exercise the
  // same explicit security override documented for headless archive installs.
  const {overrides}=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
  await writeFile(join(directory,'package.json'),JSON.stringify({name:'synthetic-cli-install',private:true,overrides}));
  // Official LineJS is on JSR; npm consumers need this documented scoped registry.
  await writeFile(join(directory,'.npmrc'),'@jsr:registry=https://npm.jsr.io\n');
  // Installing into an empty directory verifies all client files/imports were
  // shipped, independently of source-tree resolution. No lifecycle scripts.
  const installEnv={...process.env};
  // npm run promotes .npmrc allow-scripts into env; npm 11 rejects that source
  // for a nested project install. All lifecycle scripts remain disabled here.
  for(const key of Object.keys(installEnv))if(/^npm_config_allow_scripts$/i.test(key))delete installEnv[key];
  npm(['install','--ignore-scripts','--no-audit','--no-fund',join(root,'release/npm',info.filename)],{cwd:directory,env:installEnv,stdio:'pipe'});
  const bin=join(directory,'node_modules/line-bridge/bin/linebridge.mjs');
  const installedRequire=createRequire(bin),sdkRequire=createRequire(installedRequire.resolve('@evex/linejs/thrift'));
  assert.equal(sdkRequire('thrift/package.json').version,'0.23.0','Archive installation must honor the documented consumer override');
  // Exercise server imports as well as lazy CLI help, which does not load LineJS.
  execFileSync(process.execPath,['--input-type=module','-e','await import("./node_modules/line-bridge/server/drivers.mjs"); await import("./node_modules/line-bridge/server/vault.mjs");'],{cwd:directory,env:installEnv,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']});
  const env={...process.env,LINE_BRIDGE_CLIENT_CONFIG:join(directory,'synthetic-config')};
  delete env.LINE_BRIDGE_TOKEN;delete env.CF_ACCESS_CLIENT_ID;delete env.CF_ACCESS_CLIENT_SECRET;delete env.LINE_BRIDGE_URL;
  const help=execFileSync(process.execPath,[bin,'accounts','--help'],{cwd:directory,env,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']});
  assert.ok(JSON.parse(help).commands.includes('send'));
  const codexHelp=execFileSync(process.execPath,[bin,'codex','--help'],{cwd:directory,env,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']});
  assert.deepEqual(JSON.parse(codexHelp).commands,['preview','install','uninstall','verify']);
  const codexPreview=JSON.parse(execFileSync(process.execPath,[bin,'codex','preview','--scope','project','--project',directory,'--profile','synthetic-only','--url','http://127.0.0.1:1'],{cwd:directory,env,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}));
  assert.equal(codexPreview.applied,false);assert.equal(codexPreview.configuration.args[0],bin);assert.equal(codexPreview.tools,'read');
  assert.ok((await readFile(join(directory,'node_modules/line-bridge/CODEX.md'))).length>0);
  const mcpHelp=spawnSync(process.execPath,[bin,'mcp','--help'],{cwd:directory,env,encoding:'utf8',windowsHide:true});
  assert.equal(mcpHelp.status,0);assert.equal(mcpHelp.stdout,'');assert.match(mcpHelp.stderr,/protected-profile MCP adapter/);
  const maintenanceHelp=execFileSync(process.execPath,[bin,'shutdown','--help'],{cwd:directory,env,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']});
  assert.match(maintenanceHelp,/shutdown/);assert.match(maintenanceHelp,/--resume/);assert.match(maintenanceHelp,/維護關閉/);
  for(const file of ['maintenance.mjs','rpc-metadata.mjs'])assert.ok((await readFile(join(directory,'node_modules/line-bridge/server',file))).length>0);
  for(const command of ['media','send-flex']){
    const result=execFileSync(process.execPath,[bin,command,'--help'],{cwd:directory,env,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']});
    assert.ok(JSON.parse(result).commands.includes(command));
  }
  const invalid=spawnSync(process.execPath,[bin,'send','--text','synthetic'],{cwd:directory,env,encoding:'utf8',windowsHide:true});
  assert.equal(invalid.status,2);assert.equal(JSON.parse(invalid.stdout).error,'invalid_input');
  // The public npm bin shim must be present on each platform.
  const shim=join(directory,'node_modules/.bin',process.platform==='win32'?'linebridge.cmd':'linebridge');
  assert.ok((await readFile(shim)).length>0);
  const shimHelp=process.platform==='win32'
    ? execFileSync('cmd.exe',['/d','/c','node_modules\\.bin\\linebridge.cmd','accounts','--help'],{cwd:directory,env,encoding:'utf8',windowsHide:true,windowsVerbatimArguments:true,stdio:['ignore','pipe','pipe']})
    : execFileSync(shim,['accounts','--help'],{cwd:directory,env,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  assert.ok(JSON.parse(shimHelp).commands.includes('auth'));
  console.log('Fresh npm archive installation: patched Thrift, server imports, data help, JSON usage errors and platform bin shim passed. No service or LINE connection was started.');
} finally { await removeClientFixture(directory); }
