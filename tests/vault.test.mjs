import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault } from '../server/vault.mjs';
test('the OS-protected vault survives restart and authenticates its ciphertext',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'line-bridge-vault-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const first=await Vault.open(dir),cipher=first.seal({token:'test-secret'},'session');
  const second=await Vault.open(dir);assert.deepEqual(second.unseal(cipher,'session'),{token:'test-secret'});
  assert.throws(()=>second.unseal(cipher,'wrong-session'));
  if(process.platform==='win32'){const file=await readFile(join(dir,'vault-key.dpapi'));assert.ok(!file.equals(first.key));assert.ok(first.protection.includes('DPAPI'));}
});
