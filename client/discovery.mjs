import {lstat} from 'node:fs/promises';
import {join,resolve,win32,posix} from 'node:path';
import {defaultDataDirectory,metadata,validPort} from '../server/service-location.mjs';
import {profileName,endpoint} from './credentials.mjs';
import {ClientError,EXIT,usage} from './errors.mjs';

const unavailable=()=>new ClientError('discovery_unavailable','The existing local service could not be verified. Check status with the same data directory. No service was started or changed.',EXIT.transport);
const invalidMetadata=()=>new ClientError('discovery_metadata_invalid','The local service metadata is invalid or unreadable. Check the existing data directory with status.',EXIT.transport);
async function responseJson(response){
  const reader=response.body?.getReader();if(!reader)throw unavailable();
  const chunks=[];let size=0;
  try{
    for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>4*1024*1024)throw unavailable();chunks.push(Buffer.from(value));}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }catch(error){await reader.cancel().catch(()=>{});throw error;}
}

export async function discoverLocal({dataDir,env=process.env,timeoutMs=7000,fetchImpl=fetch}={}){
  if(dataDir!==undefined&&(!dataDir.trim()||/[\x00-\x1f\x7f]/.test(dataDir)))usage('Supply the existing data directory.');
  const data=resolve(dataDir??defaultDataDirectory({env}));
  try{
    const stat=await lstat(join(data,'service.json'));
    if(!stat.isFile()||stat.size>16384)throw invalidMetadata();
  }catch(error){
    if(error.code==='ENOENT')return {status:'stopped',dataDir:data,profiles:[]};
    throw invalidMetadata();
  }
  const m=await metadata(data);
  if(m?.runtime!=='node'||m.dataDir!==data||!validPort(m.adminPort)||!validPort(m.gatewayPort)||typeof m.instance!=='string'||!m.instance)throw invalidMetadata();
  const base=`http://127.0.0.1:${m.adminPort}`,signal=AbortSignal.timeout(timeoutMs);
  const request=(path,headers={})=>fetchImpl(`${base}${path}`,{method:'GET',headers:{Accept:'application/json',Connection:'close',...headers},redirect:'error',signal});
  try{
    const page=await request('/');
    const cookie=page.headers.getSetCookie().map(value=>value.split(';')[0]).find(value=>/^lb_admin=[A-Za-z0-9_-]{16,128}$/.test(value));
    await page.body?.cancel();
    if(!page.ok||!cookie)throw unavailable();
    const response=await request('/admin/discovery',{Cookie:cookie});
    if(!response.ok){
      await response.body?.cancel();
      if(response.status===404)throw new ClientError('discovery_not_supported','The running service does not support discovery. Use its optional connection instructions or upgrade the existing installation.',EXIT.remote);
      throw unavailable();
    }
    const result=await responseJson(response);
    if(result?.instance!==m.instance)throw new ClientError('discovery_instance_mismatch','The service identity differs from the existing data directory. No profile was selected.',EXIT.transport);
    const cli=result.cli,path=cli?.platform==='win32'?win32:posix;
    if(!['win32','darwin'].includes(cli?.platform)||typeof cli.node!=='string'||!path.isAbsolute(cli.node)||typeof cli.script!=='string'||!path.isAbsolute(cli.script)||!Array.isArray(result.profiles)||typeof result.gatewayEnabled!=='boolean'||typeof result.version!=='string')throw unavailable();
    const profiles=result.profiles.map(entry=>{
      if(!entry||profileName(entry.profile)!==entry.profile||endpoint(entry.url)!==`http://127.0.0.1:${m.gatewayPort}`||typeof entry.accountId!=='string'||!entry.accountId||typeof entry.accountLabel!=='string'||!Number.isFinite(Date.parse(entry.expiresAt)))throw unavailable();
      // Whitelist fields instead of forwarding a service response or credentials.
      return {profile:entry.profile,url:entry.url,accountId:entry.accountId,accountLabel:entry.accountLabel,expiresAt:entry.expiresAt};
    });
    return {status:'running',dataDir:data,version:result.version,cli:{node:cli.node,script:cli.script,platform:cli.platform},gatewayEnabled:result.gatewayEnabled,profiles};
  }catch(error){
    if(error instanceof ClientError&&error.exitCode!==EXIT.usage)throw error;
    throw unavailable();
  }
}
