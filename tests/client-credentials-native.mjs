import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {CredentialStore, runProtectedHelper} from '../client/credentials.mjs';
import {clientFixturePath, removeClientFixture} from './client-test-utils.mjs';

// Separate from npm test: these are actual OS protection checks, exclusively with
// disposable synthetic credentials on Windows/macOS.
const directory=await mkdtemp(join(tmpdir(),'linebridge-cli-native-'));
const profile=`synthetic-${randomUUID()}`,keychain=process.platform==='darwin'?join(directory,'test.keychain-db'):undefined;
let store;
try {
  if(!['win32','darwin'].includes(process.platform))throw new Error('Native checks support Windows/macOS only.');
  if(keychain) {
    const result=await runProtectedHelper('/usr/bin/security',['-q','-i'],{input:`create-keychain -p synthetic-test-password "${keychain}"\n`});
    assert.equal(result.code,0,'Could not create disposable test Keychain');
  }
  store=new CredentialStore({directory,keychain});
  const creds={token:'synthetic-native-token-only',cfAccessClientId:'synthetic-native-id',cfAccessClientSecret:'synthetic-native-secret'};
  const enrolled=await store.create(profile,'https://synthetic.example',creds);assert.equal(enrolled.profile,profile);
  assert.deepEqual(await new CredentialStore({directory,keychain}).get(profile),{url:'https://synthetic.example',...creds});
  await assert.rejects(store.create(profile,'https://synthetic.example',{token:'synthetic-conflict-token'}));
  assert.equal((await store.get(profile)).token,creds.token);
  await store.set(profile,'https://synthetic.example',{token:'synthetic-replacement-token'});
  assert.equal((await store.get(profile)).token,'synthetic-replacement-token');
  if(process.platform==='win32') {
    const bytes=await readFile(store.path(profile));assert.ok(!bytes.includes(Buffer.from(creds.token)));
    await assert.rejects(store.dpapi('Unprotect',bytes,'different-profile'),{code:'credential_store_unavailable'});
  }
  await store.forget(profile);await assert.rejects(store.get(profile));
  if(process.platform==='win32')assert.deepEqual(await readdir(directory),[]);
  console.log(`${store.protection}: native synthetic enrollment, restart, replacement and deletion passed. No real credentials or LINE messages were used.`);
} finally {
  await store?.forget(profile).catch(()=>{});
  if(keychain){clientFixturePath(directory);await runProtectedHelper('/usr/bin/security',['delete-keychain',keychain]).catch(()=>{});}
  await removeClientFixture(directory);
}
