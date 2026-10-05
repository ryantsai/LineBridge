import test from 'node:test';
import assert from 'node:assert/strict';
import {portablePlan,portableNode} from '../scripts/portable.mjs';
import {verifyExecutable} from '../scripts/packaging.mjs';

test('portable builds reject unsupported hosts and pin the Node version',()=>{
  assert.throws(()=>portablePlan('win32','arm64'),/Unsupported portable host/);
  assert.throws(()=>portablePlan('freebsd','x64'),/Unsupported portable host/);
  assert.throws(()=>portablePlan('linux','x64'),/Unsupported portable host/);
  assert.throws(()=>portablePlan('linux','arm64'),/Unsupported portable host/);
  assert.deepEqual(Object.keys(portableNode.platforms).sort(),['darwin-arm64','darwin-x64','win32-x64']);
  assert.match(portableNode.nodeVersion,/^\d+\.\d+\.\d+$/);
});
test('native binaries reject truncated and wrong-architecture executables',()=>{
  const pe=Buffer.alloc(128);pe.write('MZ');pe.writeUInt32LE(64,0x3c);pe.write('PE\0\0',64);pe.writeUInt16LE(0x8664,68);
  verifyExecutable(pe,portablePlan('win32','x64'));
  assert.throws(()=>verifyExecutable(pe.subarray(0,65),portablePlan('win32','x64')),/executable/);
  pe.writeUInt16LE(0xaa64,68);assert.throws(()=>verifyExecutable(pe,portablePlan('win32','x64')),/x64/);
  const mach=Buffer.alloc(8);mach.writeUInt32LE(0xfeedfacf);mach.writeUInt32LE(0x0100000c,4);
  verifyExecutable(mach,portablePlan('darwin','arm64'));
  assert.throws(()=>verifyExecutable(mach,portablePlan('darwin','x64')),/Mach-O/);
  assert.throws(()=>verifyExecutable(mach.subarray(0,7),portablePlan('darwin','arm64')),/Mach-O/);
  assert.throws(()=>verifyExecutable(mach,{platform:'linux',arch:'x64'}),/Unsupported/);
});
