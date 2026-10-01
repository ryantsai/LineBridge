import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile,stat,chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { BaseStorage } from 'lineclientbot';

// Key exchange uses child-process pipes, never command-line arguments or logs.
async function dpapi(mode, bytes) {
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $r=[Security.Cryptography.ProtectedData]::${mode}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let result = '';
    child.stdout.on('data', b => { result += b; });
    child.stderr.resume();
    child.on('error', () => reject(new Error('Windows credential protection is unavailable.')));
    child.on('close', code => code === 0 ? resolve(Buffer.from(result.trim(), 'base64')) : reject(new Error('Cannot unlock the credential vault for this Windows user.')));
    child.stdin.end(bytes.toString('base64'));
  });
}

export class Vault {
  constructor(key, protection) { this.key = key; this.protection = protection; }
  static async open(directory) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, process.platform === 'win32' ? 'vault-key.dpapi' : 'vault-key.bin');
    let stored;
    try { stored = await readFile(path); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const other=join(directory,process.platform==='win32'?'vault-key.bin':'vault-key.dpapi');
      try{await stat(other);throw new Error('This vault belongs to another operating system. Use a new data directory and sign in again.');}catch(e){if(e.code!=='ENOENT')throw e;}
      const key = randomBytes(32);
      stored = process.platform === 'win32' ? await dpapi('Protect', key) : key;
      await writeFile(path, stored, { flag: 'wx', mode: 0o600 });
    }
    const key = process.platform === 'win32' ? await dpapi('Unprotect', stored) : stored;
    if(process.platform!=='win32')await chmod(path,0o600);
    if (key.length !== 32) throw new Error('Invalid credential vault key.');
    return new Vault(key, process.platform === 'win32' ? 'Windows DPAPI + AES-256-GCM' : 'File permissions + AES-256-GCM');
  }
  seal(value, context) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(context));
    const encoded = JSON.stringify(value, (_, v) => typeof v === 'bigint' ? { $bigint: String(v) } : v);
    const ciphertext = Buffer.concat([cipher.update(encoded, 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64');
  }
  unseal(value, context) {
    const data = Buffer.from(value, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString(), (_, v) => v && typeof v === 'object' && '$bigint' in v ? BigInt(v.$bigint) : v);
  }
}

export class VaultStorage extends BaseStorage {
  constructor(store, vault, accountId) { super(); Object.assign(this, { store, vault, accountId }); }
  async set(key, value) { this.store.putSecret(this.accountId, key, this.vault.seal(value, `${this.accountId}:${key}`)); }
  async get(key) {
    const value = this.store.secret(this.accountId, key);
    return value === undefined ? undefined : this.vault.unseal(value, `${this.accountId}:${key}`);
  }
  async delete(key) { this.store.deleteSecret(this.accountId, key); }
  async clear() { this.store.deleteSecrets(this.accountId); }
  getAll() { return Object.fromEntries(this.store.secrets(this.accountId).map(r => [r.key, this.vault.unseal(r.value, `${this.accountId}:${r.key}`)])); }
  async migrate(storage) { for (const [key, value] of Object.entries(this.getAll())) await storage.set(key, value); }
}
