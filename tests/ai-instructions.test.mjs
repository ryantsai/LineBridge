import test from 'node:test';
import assert from 'node:assert/strict';
import {localCliInstructions} from '../public/ai-instructions.js';
const account={id:'synthetic-account',localSetup:{profile:'linebridge-synthetic',url:'http://127.0.0.1:54321',chatIds:['synthetic-chat']}};
test('local instructions include the app CLI path with safe platform quoting and no enrollment or schedule',()=>{
  const posix=localCliInstructions(account,{node:"/tmp/app's folder/node",script:'/tmp/app with spaces/bin/linebridge.mjs',platform:'darwin'});
  assert.ok(posix.includes("'/tmp/app'\\''s folder/node' '/tmp/app with spaces/bin/linebridge.mjs' accounts --profile linebridge-synthetic"));
  const windows=localCliInstructions(account,{node:"C:\\app's folder\\node.exe",script:'C:\\app with spaces\\bin\\linebridge.mjs',platform:'win32'});
  assert.ok(windows.includes("& 'C:\\app''s folder\\node.exe' 'C:\\app with spaces\\bin\\linebridge.mjs' accounts --profile linebridge-synthetic"));
  for(const text of [posix,windows]){assert.ok(text.includes('No AI monitoring schedule has been created'));assert.ok(text.includes('Never retry delivery_unknown'));assert.ok(!text.includes('auth enroll'));}
});
