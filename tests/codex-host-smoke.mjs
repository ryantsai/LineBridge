// Explicit opt-in smoke: installed Codex parses a synthetic config, never launches
// a server or accesses credentials. This is not a native Mac/Windows runtime test.
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {runCodex} from '../client/codex.mjs';
import {READ_TOOLS} from '../client/mcp.mjs';
import {removeClientFixture} from './client-test-utils.mjs';
import {syntheticCodexFiles} from './codex-test-utils.mjs';

const directory=await mkdtemp(join(tmpdir(),'linebridge-codex-host-'));
try {
  const launcher={node:process.execPath,script:resolve('bin/linebridge.mjs')};
  const env={PATH:process.env.PATH,CODEX_HOME:directory,...(process.env.SystemRoot ? {SystemRoot:process.env.SystemRoot} : {})};
  const cli=async args=>{let stdout='';const code=await runCodex(args,{env,launcher,fileOps:syntheticCodexFiles,stdout:{write:s=>{stdout+=s;}},stderr:{write:()=>{}},store:{get:()=>assert.fail('No credential access')},fetchImpl:()=>assert.fail('No gateway request')});assert.equal(code,0,stdout);return JSON.parse(stdout);};
  const original='# synthetic fixture only\nmodel = "synthetic-model"\n[mcp_servers.other]\ncommand = "synthetic-command"\n';
  await writeFile(join(directory,'config.toml'),original);
  const args=['--scope','user','--profile','synthetic-only','--url','http://127.0.0.1:1','--client-config',join(directory,'unused-profiles')];
  const preview=await cli(['preview',...args]);await cli(['install',...args,'--consent',preview.consent]);
  const codex=command=>{const result=spawnSync('codex',command,{cwd:directory,env,encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(result.status,0,`Codex unavailable or could not parse the synthetic fixture (exit ${result.status}).`);return result.stdout;};
  const version=codex(['--version']).trim(),entry=JSON.parse(codex(['mcp','get','linebridge','--json']));
  assert.equal(entry.name,'linebridge');assert.equal(entry.transport.type,'stdio');assert.equal(entry.transport.command,launcher.node);assert.deepEqual(entry.enabled_tools,READ_TOOLS);
  assert.equal(entry.transport.args[3],'synthetic-only');assert.equal(entry.transport.args[5],'http://127.0.0.1:1');
  const removal=await cli(['preview','--action','uninstall','--scope','user']);await cli(['uninstall','--scope','user','--consent',removal.consent]);
  assert.equal(await readFile(join(directory,'config.toml'),'utf8'),original);
  console.log(`${version}: generated stdio config and read allowlist parsed; exact original config restored. Disposable fixture only; no MCP server, credentials, LINE data, login or model request.`);
} finally {await removeClientFixture(directory);}
