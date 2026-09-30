import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPlan,sha256,verifyChecksum,verifyExecutable} from '../scripts/packaging.mjs';

test('installer builds reject a foreign OS and unsupported architecture',()=>{
  assert.throws(()=>buildPlan('win32','x64','macos'),/A Mac is required/);
  assert.throws(()=>buildPlan('darwin','arm64','windows'),/Windows is required/);
  assert.throws(()=>buildPlan('win32','arm64'),/Unsupported installer host/);
});
test('runtime verification refuses corrupted bytes and missing checksums',()=>{
  const bytes=Buffer.from('trusted binary'),hash=sha256(bytes);
  verifyChecksum(bytes,hash,'fixture');
  assert.throws(()=>verifyChecksum(Buffer.from('altered binary'),hash,'fixture'),/refusing to package/);
  assert.throws(()=>verifyChecksum(bytes,'','fixture'),/refusing to package/);
});
test('runtime verification rejects incompatible executable formats and architectures',()=>{
  const pe=Buffer.alloc(128);pe.write('MZ');pe.writeUInt32LE(64,0x3c);pe.write('PE\0\0',64);pe.writeUInt16LE(0x8664,68);
  verifyExecutable(pe,buildPlan('win32','x64'));
  pe.writeUInt16LE(0x14c,68);assert.throws(()=>verifyExecutable(pe,buildPlan('win32','x64')),/Windows x64/);
  assert.throws(()=>verifyExecutable(Buffer.from('not a runtime'),buildPlan('win32','x64')),/PE executable/);
  const macho=Buffer.alloc(8);macho.writeUInt32LE(0xfeedfacf,0);macho.writeUInt32LE(0x0100000c,4);
  verifyExecutable(macho,buildPlan('darwin','arm64'));
  assert.throws(()=>verifyExecutable(macho,buildPlan('darwin','x64')),/macOS x64/);
});
