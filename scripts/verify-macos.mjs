import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {buildPlan,root,runtimes} from './packaging.mjs';

const plan=buildPlan(process.platform,process.arch,'macos');
const app=join(root,'target/release/bundle/macos/LineBridge.app'),bin=join(app,'Contents/MacOS'),resources=join(app,'Contents/Resources');
execFileSync('codesign',['--verify','--deep','--strict',app],{stdio:'inherit'});
for(const name of ['LineBridge','node','cloudflared'])assert.equal(execFileSync('lipo',['-archs',join(bin,name)],{encoding:'utf8'}).trim(),plan.arch==='x64'?'x86_64':'arm64');
assert.equal(execFileSync(join(bin,'node'),['--version'],{encoding:'utf8'}).trim(),`v${runtimes.nodeVersion}`);
assert.match(execFileSync(join(bin,'cloudflared'),['--version'],{encoding:'utf8'}),new RegExp(`cloudflared version ${runtimes.cloudflaredVersion.replaceAll('.','\\.')}`));
const input=JSON.stringify({id:'packaging-check',method:'check',params:{accountId:'synthetic-missing'}})+'\n';
const worker=JSON.parse(execFileSync(join(bin,'node'),[join(resources,'app/protocol/worker.mjs')],{input,encoding:'utf8',timeout:20000}).trim());
assert.equal(worker.id,'packaging-check');assert.equal(worker.error.code,'account_disconnected');
execFileSync(process.execPath,['tests/desktop-smoke.mjs'],{cwd:root,stdio:'inherit'});
console.log(`macOS ${plan.arch}: signatures, native runtime architecture, private worker and bundled native service verified.`);
