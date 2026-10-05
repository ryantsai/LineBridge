import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateArchive} from '../scripts/package.mjs';
import {npm} from '../scripts/npm.mjs';
import {VERSION} from '../server/version.mjs';
test('npm archive contains only the portable application and no desktop, private data or executables',()=>{
  const [pack]=JSON.parse(npm(['pack','--dry-run','--json','--ignore-scripts'],{cwd:process.cwd()}));validateArchive(pack.files);
  assert.equal(pack.name,'line-bridge');assert.equal(pack.version,VERSION);
  assert.equal(JSON.parse(readFileSync('package.json','utf8')).license,'MIT');
  assert.ok(pack.files.some(file=>file.path==='LICENSE'));
  assert.throws(()=>validateArchive(pack.files.filter(file=>file.path!=='LICENSE')),/Missing package file: LICENSE/);
  const pkg=JSON.parse(readFileSync('package.json','utf8'));assert.equal(pkg.bin.linebridge,'bin/linebridge.mjs');assert.equal(pkg.engines.node,'>=24.0.0');assert.equal(pkg.scripts.postinstall,undefined);assert.equal(pkg.devDependencies?.['@tauri-apps/cli'],undefined);assert.deepEqual(pkg.os,['win32','darwin']);
  for(const path of ['data/bridge.sqlite','public/vault-key.bin','src-tauri/tauri.conf.json','runtime/node.exe','crates/bridge-core/src/main.rs','public/../data/secret','protocol/line-worker.cjs'])assert.throws(()=>validateArchive([...pack.files,{path}]),/unexpected file/);
});
