import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir, readFile, writeFile, rename, rm, lstat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {isAbsolute, join, resolve} from 'node:path';
import {credentialError, missingCredentials, usage} from './errors.mjs';

const SERVICE = 'org.linebridge.cli.v1';
const MAX_SECRET = 3000;
export function profileName(value = 'default') {
  if(typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)) usage('Use a portable profile name: 1-64 ASCII letters, digits, underscores or hyphens, starting with a letter or digit; OS device names are reserved.');
  return value.toLowerCase();
}
export function endpoint(value) {
  let url;
  try { url = new URL(value); } catch { usage('Use an HTTPS gateway URL, or an HTTP loopback URL.'); }
  if(typeof value !== 'string' || value.length > 1024 || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) usage('Use a gateway origin without credentials, paths, query parameters or fragments.');
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if(url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) usage('Remote gateways require HTTPS. HTTP is allowed only on loopback.');
  return url.origin;
}
export function credentialInput(input) {
  if(!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k=>!['token','cfAccessClientId','cfAccessClientSecret'].includes(k))) usage('Credential JSON accepts token and the optional cfAccessClientId/cfAccessClientSecret pair.');
  const check = (value, max) => typeof value === 'string' && value.length >= 1 && value.length <= max && /^[\x21-\x7e]+$/.test(value);
  if(!check(input.token, 256)) usage('Supply a nonempty scoped Bearer token (at most 256 printable ASCII characters, without spaces).');
  const hasId = input.cfAccessClientId !== undefined, hasSecret = input.cfAccessClientSecret !== undefined;
  if(hasId !== hasSecret || (hasId && (!check(input.cfAccessClientId,256) || !check(input.cfAccessClientSecret,512)))) usage('Cloudflare Access requires both client ID and secret, without whitespace (at most 256/512 characters).');
  return {token:input.token, ...(hasId ? {cfAccessClientId:input.cfAccessClientId,cfAccessClientSecret:input.cfAccessClientSecret} : {})};
}
export function configDirectory(env = process.env, platform = process.platform) {
  if(env.LINE_BRIDGE_CLIENT_CONFIG) return resolve(env.LINE_BRIDGE_CLIENT_CONFIG);
  if(platform === 'win32') return join(env.LOCALAPPDATA || join(homedir(),'AppData','Local'), 'LineBridgeClient');
  if(platform === 'darwin') return join(homedir(),'Library','Application Support','LineBridgeClient');
  return join(env.XDG_CONFIG_HOME || join(homedir(),'.config'), 'linebridge-client');
}

// Helper output stays in private pipes. Never pass secrets in argv, invoke a shell,
// inherit secret environment variables, or surface helper errors (they can echo input).
export function runProtectedHelper(file, args, {input = '', timeoutMs = 10000, env = process.env} = {}) {
  const helperEnv = {...env};
  for(const key of Object.keys(helperEnv))if(/^(LINE_BRIDGE_TOKEN|CF_ACCESS_CLIENT_ID|CF_ACCESS_CLIENT_SECRET)$/i.test(key))delete helperEnv[key];
  return new Promise((resolvePromise, reject) => {
    let child, timer, settled = false, size = 0;
    const chunks = [];
    const fail = () => { if(!settled) { settled=true;clearTimeout(timer);child?.kill();reject(credentialError()); } };
    try { child = spawn(file,args,{env:helperEnv,windowsHide:true,stdio:['pipe','pipe','pipe'],shell:false}); } catch { fail();return; }
    timer = setTimeout(fail,timeoutMs);
    child.on('error',fail);
    child.stdin.on('error',fail);
    child.stdout.on('data',chunk=>{size+=chunk.length;if(size>16384)fail();else chunks.push(chunk);});
    child.stderr.resume();
    child.on('close',code=>{if(!settled){settled=true;clearTimeout(timer);resolvePromise({code,stdout:Buffer.concat(chunks).toString('utf8')});}});
    child.stdin.end(input);
  });
}

export class CredentialStore {
  constructor({platform=process.platform, directory=configDirectory(), run=runProtectedHelper, env=process.env, keychain} = {}) {
    Object.assign(this,{platform,directory,run,env,keychain});
  }
  get protection() {
    return this.platform === 'win32' ? 'Windows DPAPI CurrentUser' : this.platform === 'darwin' ? 'macOS Keychain' : this.platform === 'linux' ? 'Linux Secret Service' : 'unsupported';
  }
  path(profile) { return join(this.directory,`${profileName(profile)}.dpapi`); }
  async helper(file,args,input='',timeoutMs=10000) {
    try { return await this.run(file,args,{input,timeoutMs,env:this.env}); } catch { throw credentialError(); }
  }
  async dpapi(mode,bytes,profile) {
    const context = Buffer.from(`${SERVICE}:${profile}`).toString('base64');
    const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $e=[Convert]::FromBase64String('${context}'); $r=[Security.Cryptography.ProtectedData]::${mode}($b,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
    const file = join(this.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    const result = await this.helper(file,['-NoProfile','-NonInteractive','-Command',script],bytes.toString('base64'));
    if(result.code!==0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(result.stdout.trim())) throw credentialError();
    return Buffer.from(result.stdout.trim(),'base64');
  }
  async selectedKeychain() {
    let path=this.keychain;
    if(!path) {
      const result=await this.helper('/usr/bin/security',['default-keychain','-d','user']);
      if(result.code!==0)throw credentialError();
      path=result.stdout.trim().replace(/^"(.*)"$/,'$1');
    }
    if(!path || !isAbsolute(path) || /["\\\r\n\0]/.test(path))throw credentialError();
    return path;
  }
  async set(profile,url,input) {
    profile = profileName(profile);
    const record = {version:1,profile,url:endpoint(url),...credentialInput(input)};
    const encoded = Buffer.from(JSON.stringify(record)).toString('base64');
    if(encoded.length > MAX_SECRET) usage('The credential profile is too large for protected storage.');
    if(this.platform === 'win32') {
      const protectedBytes = await this.dpapi('Protect',Buffer.from(encoded),profile);
      const path = this.path(profile), temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await mkdir(this.directory,{recursive:true,mode:0o700});
        await writeFile(temporary,protectedBytes,{flag:'wx',mode:0o600});
        await rename(temporary,path);
      } catch { throw credentialError(); }
      finally { await rm(temporary,{force:true}).catch(()=>{}); }
    } else if(this.platform === 'darwin') {
      // security's interactive command line limit is 4096 bytes. Its stdin parser
      // is not a shell; secrets are base64 and names are restricted ASCII.
      const path = await this.selectedKeychain();
      const line = `add-generic-password -U -a ${profile} -s ${SERVICE} -w ${encoded} "${path}"\n`;
      if(Buffer.byteLength(line)>=4096) throw credentialError();
      const result = await this.helper('/usr/bin/security',['-q','-i'],line);
      if(result.code!==0) throw credentialError();
    } else if(this.platform === 'linux') {
      const result = await this.helper('/usr/bin/secret-tool',['store','--label=LineBridge CLI','application',SERVICE,'profile',profile],encoded);
      if(result.code!==0) throw credentialError();
    } else throw credentialError();
    return {profile,url:record.url,protection:this.protection};
  }
  async get(profile) {
    profile = profileName(profile);
    let encoded;
    if(this.platform === 'win32') {
      let bytes;
      try { const stat=await lstat(this.path(profile));if(!stat.isFile() || stat.size>16384)throw credentialError();bytes=await readFile(this.path(profile)); }
      catch(error) { if(error.code==='ENOENT')throw missingCredentials();throw credentialError(); }
      encoded = (await this.dpapi('Unprotect',bytes,profile)).toString('utf8');
    } else if(this.platform === 'darwin') {
      const result = await this.helper('/usr/bin/security',['find-generic-password','-w','-a',profile,'-s',SERVICE,await this.selectedKeychain()]);
      if(result.code===44) throw missingCredentials();
      if(result.code!==0) throw credentialError();
      encoded = result.stdout.trim();
    } else if(this.platform === 'linux') {
      const result = await this.helper('/usr/bin/secret-tool',['lookup','application',SERVICE,'profile',profile]);
      // secret-tool returns the same status for a missing item and an unavailable
      // service. Keep both failures explicit rather than silently using a file.
      if(result.code!==0) throw credentialError();
      encoded = result.stdout;
    } else throw credentialError();
    try {
      if(encoded.length>MAX_SECRET || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))throw credentialError();
      const record = JSON.parse(Buffer.from(encoded,'base64').toString('utf8'));
      if(record.version!==1 || record.profile!==profile)throw credentialError();
      return {url:endpoint(record.url),...credentialInput({token:record.token,...(record.cfAccessClientId!==undefined ? {cfAccessClientId:record.cfAccessClientId,cfAccessClientSecret:record.cfAccessClientSecret} : {})})};
    } catch { throw credentialError(); }
  }
  async forget(profile) {
    profile = profileName(profile);
    if(this.platform === 'win32') {
      try { await rm(this.path(profile),{force:true}); } catch { throw credentialError(); }
    } else if(this.platform === 'darwin') {
      const result = await this.helper('/usr/bin/security',['delete-generic-password','-a',profile,'-s',SERVICE,await this.selectedKeychain()]);
      if(![0,44].includes(result.code))throw credentialError();
    } else if(this.platform === 'linux') {
      const result = await this.helper('/usr/bin/secret-tool',['clear','application',SERVICE,'profile',profile]);
      if(result.code!==0)throw credentialError();
    } else throw credentialError();
    return {profile,forgotten:true,protection:this.protection};
  }
}
