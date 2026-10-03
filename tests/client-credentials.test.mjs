import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readdir, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CredentialStore, credentialInput, profileName, runProtectedHelper} from '../client/credentials.mjs';
import {removeClientFixture} from './client-test-utils.mjs';

const creds={token:'synthetic-token-only',cfAccessClientId:'synthetic-access-id',cfAccessClientSecret:'synthetic-access-secret'};
test('all OS adapters store through private pipes, restart and delete only their selected profile (mock helpers)',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'linebridge-credential-mock-'));t.after(()=>removeClientFixture(dir));
  for(const platform of ['win32','darwin','linux']) {
    let saved;const calls=[];
    const run=async(file,args,options)=>{
      calls.push({file,args,options});
      if(args[0]==='default-keychain')return {code:0,stdout:'"/tmp/synthetic keychain"\n'};
      if(platform==='win32') {
        if(args.at(-1).includes('::Protect(')){saved=options.input;return {code:0,stdout:Buffer.from(`protected:${saved}`).toString('base64')};}
        assert.equal(Buffer.from(options.input,'base64').toString(),`protected:${saved}`);return {code:0,stdout:saved};
      }
      if(args.includes('-i')){saved=options.input.match(/ -w (\S+)/)[1];return {code:0,stdout:''};}
      if(args[0]==='store'){saved=options.input;return {code:0,stdout:''};}
      if(['find-generic-password','lookup'].includes(args[0]))return {code:0,stdout:saved+(platform==='darwin'?'\n':'')};
      saved=undefined;return {code:0,stdout:''};
    };
    const options={platform,directory:dir,run,env:{}};
    const first=new CredentialStore(options);await first.set('test','https://gateway.example',creds);
    assert.deepEqual(await new CredentialStore(options).get('test'),{url:'https://gateway.example',...creds});
    for(const call of calls){assert.ok(!JSON.stringify(call.args).includes(creds.token));assert.ok(!JSON.stringify(call.args).includes(creds.cfAccessClientSecret));assert.equal(call.options.timeoutMs,10000);}
    if(platform==='win32'){const bytes=await readFile(join(dir,'test.dpapi'));assert.ok(!bytes.includes(Buffer.from(creds.token)));}
    await first.forget('test');
  }
});
test('failed protection, missing helpers and corrupt stored output fail closed without a plaintext file',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'linebridge-credential-fail-'));t.after(()=>removeClientFixture(dir));
  for(const platform of ['win32','darwin','linux','unsupported']) {
    const store=new CredentialStore({platform,directory:dir,run:async()=>({code:1,stdout:'synthetic-secret-do-not-log'}),env:{}});
    await assert.rejects(store.set('test','https://gateway.example',creds),{code:'credential_store_unavailable'});
  }
  assert.deepEqual(await readdir(dir),[]);
  const bad=new CredentialStore({platform:'darwin',keychain:'/tmp/synthetic.keychain',run:async()=>({code:0,stdout:'corrupt-secret'}),env:{}});
  await assert.rejects(bad.get('test'),{code:'credential_store_unavailable'});
  const unavailable=await runProtectedHelper(process.execPath,['-e','process.stderr.write("synthetic-secret");process.exit(2)']);assert.equal(unavailable.code,2);assert.equal(unavailable.stdout,'');
  await assert.rejects(runProtectedHelper(join(dir,'does-not-exist'),[],{input:creds.token}),{code:'credential_store_unavailable'});
  await assert.rejects(runProtectedHelper(process.execPath,['-e','setInterval(()=>{},1000)'],{timeoutMs:50}),{code:'credential_store_unavailable'});
});
test('profile integrity and credential schema prevent namespace/command injection and malformed headers',async()=>{
  assert.equal(profileName('Work'),'work');
  assert.throws(()=>credentialInput({token:'a\r\nAuthorization: b'}),{code:'invalid_input'});
  assert.throws(()=>credentialInput({token:'t',cfAccessClientId:'id'}),{code:'invalid_input'});
  const run=()=>assert.fail('Invalid profile must not start a helper'),store=new CredentialStore({platform:'darwin',run});
  for(const name of ['../default','a\nadd-generic-password','a b','a;command','CON','LPT1'])await assert.rejects(store.set(name,'https://gateway.example',creds),{code:'invalid_input'});
  const encoded=Buffer.from(JSON.stringify({version:1,profile:'other',url:'https://gateway.example',...creds})).toString('base64');
  await assert.rejects(new CredentialStore({platform:'linux',run:async()=>({code:0,stdout:encoded})}).get('test'),{code:'credential_store_unavailable'});
});

test('app enrollment refuses an existing profile and does not place secrets in helper argv',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'linebridge-create-profile-'));t.after(()=>removeClientFixture(dir));
  for(const platform of ['win32','darwin','linux']){
    let saved;const calls=[];
    const run=async(file,args,options)=>{
      calls.push({args,input:options.input});
      if(platform==='win32')return {code:0,stdout:Buffer.from('synthetic-protected-ciphertext').toString('base64')};
      if(args.includes('-i')){if(saved&&!options.input.includes(' -U '))return {code:45,stdout:''};saved=options.input.match(/ -w (\S+)/)[1];return {code:0,stdout:''};}
      if(args[0]==='lookup')return saved?{code:0,stdout:saved}:{code:1,stdout:''};
      if(args[0]==='store'){saved=options.input;return {code:0,stdout:''};}
      assert.fail('Unexpected helper');
    };
    const store=new CredentialStore({platform,directory:dir,keychain:'/tmp/synthetic.keychain-db',run,env:{}});
    await store.create('new-managed','http://127.0.0.1:3211',creds);
    await assert.rejects(store.create('new-managed','http://127.0.0.1:3211',{token:'synthetic-conflict-token'}));
    assert.ok(calls.every(call=>!JSON.stringify(call.args).includes(creds.token)));
    if(platform==='darwin')assert.ok(calls.filter(call=>call.args.includes('-i')).every(call=>!call.input.includes(' -U ')));
  }
});
