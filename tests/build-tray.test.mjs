import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {buildTray} from '../scripts/build-tray.mjs';
import {removeClientFixture} from './client-test-utils.mjs';

async function fixture(t){
  const directory=await mkdtemp(join(tmpdir(),'linebridge-tray-build-'));
  t.after(()=>removeClientFixture(directory));
  return directory;
}
function mach(arch){
  const bytes=Buffer.alloc(8);
  bytes.writeUInt32LE(0xfeedfacf);
  bytes.writeUInt32LE(arch==='arm64'?0x0100000c:0x01000007,4);
  return bytes;
}
function pe(machine=0x8664){
  const bytes=Buffer.alloc(128);
  bytes.write('MZ');bytes.writeUInt32LE(64,0x3c);
  bytes.write('PE\0\0',64);bytes.writeUInt16LE(machine,68);
  return bytes;
}

for(const arch of ['x64','arm64'])test(`macOS ${arch} tray uses the requested target and verifies its signature`,async t=>{
  const bundle=await fixture(t),calls=[];
  const run=(file,args)=>{
    calls.push({file,args});
    if(file==='/usr/bin/xcrun'){
      assert.equal(args[0],'swiftc');
      assert.equal(args[args.indexOf('-target')+1],`${arch==='x64'?'x86_64':'arm64'}-apple-macosx13.5`);
      writeFileSync(args[args.indexOf('-o')+1],mach(arch));
    }else assert.equal(file,'/usr/bin/codesign');
  };
  assert.equal(await buildTray(bundle,'darwin',arch,{run,hostPlatform:'darwin'}),'LineBridge.app');
  assert.deepEqual(calls.map(call=>call.file),['/usr/bin/xcrun','/usr/bin/codesign','/usr/bin/codesign']);
  const app=join(bundle,'LineBridge.app');
  assert.deepEqual(calls[1].args,['--force','--sign','-',app]);
  assert.deepEqual(calls[2].args,['--verify','--strict',app]);
});

for(const arch of ['x64','arm64'])test(`macOS ${arch} tray rejects the other architecture before signing`,async t=>{
  const bundle=await fixture(t),calls=[];
  const run=(file,args)=>{
    calls.push(file);
    assert.equal(file,'/usr/bin/xcrun','A rejected compiler output must never be signed.');
    writeFileSync(args[args.indexOf('-o')+1],mach(arch==='x64'?'arm64':'x64'));
  };
  await assert.rejects(buildTray(bundle,'darwin',arch,{run,hostPlatform:'darwin'}),/Mach-O/);
  assert.deepEqual(calls,['/usr/bin/xcrun']);
});

test('macOS signature verification failure prevents a successful build',async t=>{
  const bundle=await fixture(t),failure=new Error('Synthetic signature verification failure'),calls=[];
  const run=(file,args)=>{
    calls.push({file,args});
    if(file==='/usr/bin/xcrun')writeFileSync(args[args.indexOf('-o')+1],mach('x64'));
    else{
      assert.equal(file,'/usr/bin/codesign');
      if(args.includes('--verify'))throw failure;
    }
  };
  await assert.rejects(buildTray(bundle,'darwin','x64',{run,hostPlatform:'darwin'}),error=>error===failure);
  assert.equal(calls.length,3);
  assert.equal(calls[2].args[0],'--verify');
});

for(const [name,machine,valid] of [['x64',0x8664,true],['arm64',0xaa64,false]])test(`Windows tray checks compiler output architecture (${name})`,async t=>{
  const bundle=await fixture(t),calls=[];
  // The compiler is mocked, including when this test runs on macOS.
  const systemRoot=process.env.SystemRoot;
  if(!systemRoot){
    process.env.SystemRoot='C:\\Windows';
    t.after(()=>{if(systemRoot===undefined)delete process.env.SystemRoot;else process.env.SystemRoot=systemRoot;});
  }
  const run=(file,args,options)=>{
    calls.push(file);
    assert.match(file,/[\\/]csc\.exe$/);
    assert.ok(args.includes('/platform:x64'));
    assert.equal(options.windowsHide,true);
    const output=args.find(arg=>arg.startsWith('/out:'));
    assert.ok(output);writeFileSync(output.slice('/out:'.length),pe(machine));
  };
  const result=buildTray(bundle,'win32','x64',{run,hostPlatform:'win32'});
  if(valid)assert.equal(await result,'LineBridge.exe');
  else await assert.rejects(result,/x64/);
  assert.equal(calls.length,1);
});

test('unsupported architectures and cross-OS builds fail before writes or compiler calls',async t=>{
  const directory=await fixture(t),bundle=join(directory,'must-not-be-created');
  let calls=0;
  const run=()=>{calls++;throw new Error('The compiler must not run.');};
  for(const [platform,arch,hostPlatform] of [
    ['darwin','x64','win32'],['win32','x64','darwin'],
    ['win32','arm64','win32'],['darwin','ia32','darwin'],
    ['darwin','universal','darwin'],['linux','x64','linux'],
  ]){
    await assert.rejects(buildTray(bundle,platform,arch,{run,hostPlatform}));
    assert.equal(calls,0,`${platform}-${arch} on ${hostPlatform} invoked a compiler.`);
    assert.deepEqual(await readdir(directory),[],`${platform}-${arch} on ${hostPlatform} wrote build files.`);
  }
});
