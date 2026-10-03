import test from 'node:test';
import assert from 'node:assert/strict';
import {portablePlan,portableNode} from '../scripts/portable.mjs';
import {verifyExecutable,runtimes} from '../scripts/packaging.mjs';

test('portable builds reject unsupported hosts and keep the desktop Node version',()=>{
  assert.throws(()=>portablePlan('win32','arm64'),/Unsupported portable host/);
  assert.throws(()=>portablePlan('freebsd','x64'),/Unsupported portable host/);
  assert.equal(portableNode.nodeVersion,runtimes.nodeVersion);
});
test('Linux sidecars reject truncated, wrong-architecture, 32-bit and big-endian ELF files',()=>{
  const bytes=Buffer.alloc(64);bytes.write('7f454c46',0,'hex');bytes[4]=2;bytes[5]=1;bytes.writeUInt16LE(62,18);
  verifyExecutable(bytes,portablePlan('linux','x64'));
  assert.throws(()=>verifyExecutable(bytes,portablePlan('linux','arm64')),/ELF/);
  assert.throws(()=>verifyExecutable(bytes.subarray(0,20),portablePlan('linux','x64')),/ELF/);
  bytes[4]=1;assert.throws(()=>verifyExecutable(bytes,portablePlan('linux','x64')),/ELF/);
  bytes[4]=2;bytes[5]=2;assert.throws(()=>verifyExecutable(bytes,portablePlan('linux','x64')),/ELF/);
  bytes[5]=1;bytes.writeUInt16LE(183,18);verifyExecutable(bytes,portablePlan('linux','arm64'));
});
