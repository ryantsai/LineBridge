// Bundle on the actual host, then model only the executable's OS-policy gate.
// This does not validate a native portable archive, Keychain or DPAPI.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {bundleApp} from '../scripts/bundle-app.mjs';
import {removeClientFixture} from './client-test-utils.mjs';
import {modeledCodexPreload} from './codex-test-utils.mjs';

const directory=await mkdtemp(join(tmpdir(),'linebridge-codex-bundle-'));
try {
  const app=join(directory,'app'),preload=join(directory,'modeled-platform.mjs');
  await bundleApp(app,['bin/linebridge.mjs','protocol/worker.mjs','server/tray.mjs']);
  await writeFile(preload,modeledCodexPreload);
  const bin=join(app,'bin','linebridge.mjs');
  const run=args=>{const result=spawnSync(process.execPath,['--import',preload,bin,...args],{cwd:directory,encoding:'utf8',timeout:15000,env:{PATH:process.env.PATH,LINE_BRIDGE_CLIENT_CONFIG:join(directory,'unused-profiles')}});assert.equal(result.status,0,result.stderr);return result;};
  const args=['--scope','project','--project',directory,'--profile','synthetic-only','--url','http://127.0.0.1:1'];
  const preview=JSON.parse(run(['codex','preview',...args]).stdout);assert.equal(preview.configuration.args[0],bin);
  assert.equal(JSON.parse(run(['codex','install',...args,'--consent',preview.consent]).stdout).applied,true);
  assert.equal(JSON.parse(run(['codex','verify','--scope','project','--project',directory]).stdout).launcherAvailable,true);
  const removal=JSON.parse(run(['codex','preview','--action','uninstall','--scope','project','--project',directory]).stdout);
  run(['codex','uninstall','--scope','project','--project',directory,'--consent',removal.consent]);assert.equal(await readFile(join(directory,'.codex','config.toml'),'utf8'),'');
  const help=run(['mcp','--help']);assert.equal(help.stdout,'');assert.match(help.stderr,/protected-profile MCP adapter/);
  assert.match(await readFile(join(app,'third-party-notices.txt'),'utf8'),/smol-toml/);
  console.log('Bundled CLI preview/install/static verify/uninstall and MCP help passed in a disposable fixture. Linux build plus modeled darwin policy only; no credentials, gateway, native portable archive or LINE operations.');
} finally {await removeClientFixture(directory);}
