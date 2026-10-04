import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,readdirSync,realpathSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,join} from 'node:path';
import {buildPlan,root,runtimes,sha256} from './packaging.mjs';

const plan=buildPlan(process.platform,process.arch,'macos');
const release=join(root,'release',plan.slug),info=JSON.parse(readFileSync(join(release,'build-info.json'),'utf8'));
assert.equal(basename(info.file),info.file);
const dmg=join(release,info.file);assert.equal(sha256(readFileSync(dmg)),info.sha256);
// macOS /var is a symlink; Tauri rejects executable paths through symlinks.
const mount=realpathSync(mkdtempSync(join(tmpdir(),'linebridge-dmg-')));let attached=false;
try{
// Tauri removes the intermediate .app after a DMG-only build. Inspect and run
// the delivered image instead, without depending on the build folder.
execFileSync('hdiutil',['attach',dmg,'-readonly','-nobrowse','-mountpoint',mount],{stdio:'inherit'});attached=true;
const app=join(mount,'LineBridge.app'),bin=join(app,'Contents/MacOS'),resources=join(app,'Contents/Resources');
assert.deepEqual(readdirSync(bin).sort(),['LineBridge','cloudflared','node']);
execFileSync('codesign',['--verify','--deep','--strict',app],{stdio:'inherit'});
for(const name of ['LineBridge','node','cloudflared'])assert.equal(execFileSync('lipo',['-archs',join(bin,name)],{encoding:'utf8'}).trim(),plan.arch==='x64'?'x86_64':'arm64');
assert.equal(execFileSync(join(bin,'node'),['--version'],{encoding:'utf8'}).trim(),`v${runtimes.nodeVersion}`);
assert.match(execFileSync(join(bin,'cloudflared'),['--version'],{encoding:'utf8'}),new RegExp(`cloudflared version ${runtimes.cloudflaredVersion.replaceAll('.','\\.')}`));
// Probe worker startup/IPC with a disconnected account; health checks normalize
// their errors separately and are covered by the account-health tests.
const input=JSON.stringify({id:'packaging-check',method:'disconnect',params:{accountId:'synthetic-missing'}})+'\n';
const worker=JSON.parse(execFileSync(join(bin,'node'),[join(resources,'app/protocol/worker.mjs')],{input,encoding:'utf8',timeout:20000}).trim());
assert.equal(worker.type,'result');assert.equal(worker.id,'packaging-check');assert.equal(worker.error.status,409);assert.equal(worker.error.code,'account_disconnected');
execFileSync(process.execPath,['tests/desktop-smoke.mjs'],{cwd:root,stdio:'inherit',env:{...process.env,LINE_BRIDGE_DESKTOP_BINARY:join(bin,'LineBridge')}});
console.log(`macOS ${plan.arch}: delivered DMG checksum, signatures, native runtime architecture, private worker and bundled native service verified.`);
}finally{if(attached)execFileSync('hdiutil',['detach',mount],{stdio:'inherit'});rmdirSync(mount);}
