import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync, spawnSync} from 'node:child_process';
import {npm} from '../scripts/npm.mjs';
import {removeClientFixture} from './client-test-utils.mjs';

const root=process.cwd(),directory=await mkdtemp(join(tmpdir(),'linebridge-package-cli-'));
try {
  const info=JSON.parse(await readFile(join(root,'release/npm/package-info.json'),'utf8'));
  await writeFile(join(directory,'package.json'),'{"name":"synthetic-cli-install","private":true}');
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
  const env={...process.env,LINE_BRIDGE_CLIENT_CONFIG:join(directory,'synthetic-config')};
  delete env.LINE_BRIDGE_TOKEN;delete env.CF_ACCESS_CLIENT_ID;delete env.CF_ACCESS_CLIENT_SECRET;delete env.LINE_BRIDGE_URL;
  const help=execFileSync(process.execPath,[bin,'accounts','--help'],{cwd:directory,env,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']});
  assert.ok(JSON.parse(help).commands.includes('send'));
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
  console.log('Fresh npm archive installation: data help, JSON usage errors and platform bin shim passed. No service or LINE connection was started.');
} finally { await removeClientFixture(directory); }
