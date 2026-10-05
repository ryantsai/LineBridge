import test from 'node:test';
import assert from 'node:assert/strict';
import {portablePlan,portableNode,parsePortableOptions,verifyPortableRuntime} from '../scripts/portable.mjs';
import {verifyExecutable} from '../scripts/packaging.mjs';

test('portable builds reject unsupported hosts and pin the Node version',()=>{
  assert.throws(()=>portablePlan('win32','arm64'),/Unsupported portable host/);
  assert.throws(()=>portablePlan('freebsd','x64'),/Unsupported portable host/);
  assert.throws(()=>portablePlan('linux','x64'),/Unsupported portable host/);
  assert.throws(()=>portablePlan('linux','arm64'),/Unsupported portable host/);
  assert.deepEqual(Object.keys(portableNode.platforms).sort(),['darwin-arm64','darwin-x64','win32-x64']);
  assert.match(portableNode.nodeVersion,/^\d+\.\d+\.\d+$/);
});
test('portable architecture options select the matching runtime and artifact',()=>{
  assert.deepEqual(parsePortableOptions([]),{});
  assert.deepEqual(parsePortableOptions(['--arch','x64']),{arch:'x64'});
  assert.deepEqual(parsePortableOptions(['--arch=arm64']),{arch:'arm64'});
  for(const args of [['--arch'],['--arch='],['--arch','all'],['--arch','x86_64'],['--arch','--help'],['--arch=x64','--arch=arm64'],['--platform','darwin'],['--arch=x64=arm64'],['x64']])assert.throws(()=>parsePortableOptions(args));
  const intel=portablePlan('darwin',parsePortableOptions(['--arch','x64']).arch);
  assert.equal(intel.slug,'macos-x64');assert.equal(intel.asset,`node-v${portableNode.nodeVersion}-darwin-x64.tar.gz`);
  assert.equal(intel.sha256,portableNode.platforms['darwin-x64'].sha256);
  assert.notEqual(intel.sha256,portablePlan('darwin','arm64').sha256);
  assert.equal(portablePlan().arch,process.arch);
});
test('bundled runtime must execute and report the selected architecture and pinned version',()=>{
  const plan=portablePlan('darwin','x64'),expected={version:portableNode.nodeVersion,platform:'darwin',arch:'x64'};
  const actual=verifyPortableRuntime('/synthetic/node',plan,{run:(file,args,options)=>{
    assert.equal(file,'/synthetic/node');assert.equal(args[0],'-p');assert.equal(options.timeout,15000);
    return JSON.stringify(expected);
  }});
  assert.deepEqual(actual,expected);
  for(const changed of [{arch:'arm64'},{platform:'win32'},{version:'0.0.0'}])assert.throws(()=>verifyPortableRuntime('/synthetic/node',plan,{run:()=>JSON.stringify({...expected,...changed})}),/did not match/);
  assert.throws(()=>verifyPortableRuntime('/synthetic/node',plan,{run:()=>{throw new Error('cannot execute');}}),/could not execute.*existing Rosetta/);
  assert.throws(()=>verifyPortableRuntime('/synthetic/node',plan,{run:()=>''}),/could not execute/);
});
test('native binaries reject truncated and wrong-architecture executables',()=>{
  const pe=Buffer.alloc(128);pe.write('MZ');pe.writeUInt32LE(64,0x3c);pe.write('PE\0\0',64);pe.writeUInt16LE(0x8664,68);
  verifyExecutable(pe,portablePlan('win32','x64'));
  assert.throws(()=>verifyExecutable(pe.subarray(0,65),portablePlan('win32','x64')),/executable/);
  pe.writeUInt16LE(0xaa64,68);assert.throws(()=>verifyExecutable(pe,portablePlan('win32','x64')),/x64/);
  const mach=Buffer.alloc(8);mach.writeUInt32LE(0xfeedfacf);mach.writeUInt32LE(0x0100000c,4);
  verifyExecutable(mach,portablePlan('darwin','arm64'));
  assert.throws(()=>verifyExecutable(mach,portablePlan('darwin','x64')),/Mach-O/);
  mach.writeUInt32LE(0x01000007,4);verifyExecutable(mach,portablePlan('darwin','x64'));
  assert.throws(()=>verifyExecutable(mach,portablePlan('darwin','arm64')),/Mach-O/);
  assert.throws(()=>verifyExecutable(mach.subarray(0,7),portablePlan('darwin','arm64')),/Mach-O/);
  assert.throws(()=>verifyExecutable(mach,{platform:'linux',arch:'x64'}),/Unsupported/);
});
