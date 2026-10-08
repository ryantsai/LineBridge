import {createHash} from 'node:crypto';
import {rename} from 'node:fs/promises';
import {join} from 'node:path';
import {ClientError,EXIT} from './errors.mjs';
import {runProtectedHelper} from './credentials.mjs';

const refused=()=>new ClientError('codex_metadata_unsupported','Existing Codex file protection could not be safely verified. Custom ACLs, extended attributes or special flags require manual configuration in Codex settings. No automatic replacement is allowed.',EXIT.remote);
const signature=value=>createHash('sha256').update(value).digest('hex');

// Input paths and descriptors use a private pipe, never shell interpolation.
// Refuse custom ACLs/attributes even though ReplaceFile supports many of them;
// this first integration does not claim native validation of those cases.
const WINDOWS = `$ErrorActionPreference='Stop'; try {
  $i=ConvertFrom-Json -InputObject ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())));
  $acl=Get-Acl -LiteralPath $i.file -Audit;
  $owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;
  $me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
  $attrs=[int][System.IO.File]::GetAttributes($i.file);
  if($owner -ne $me -or $acl.AreAccessRulesProtected -or -not $acl.AreAccessRulesCanonical -or @($acl.Access | Where-Object { -not $_.IsInherited }).Count -gt 0 -or ($attrs -band (-bnot 160)) -ne 0) { exit 2 }
  $descriptor=$acl.Sddl;
  if($acl.AreAuditRulesProtected -or $descriptor -match 'S:') { exit 2 }
  if($i.op -eq 'inspect') { [Console]::Out.Write((@{descriptor=$descriptor;attributes=$attrs} | ConvertTo-Json -Compress)); exit 0 }
  if($descriptor -cne $i.descriptor -or $attrs -ne $i.attributes) { exit 2 }
  if($i.op -eq 'prepare') {
    Set-Acl -LiteralPath $i.temporary -AclObject $acl;
    if((Get-Acl -LiteralPath $i.temporary -Audit).Sddl -cne $descriptor) { exit 2 }
    exit 0
  }
  if($i.op -eq 'replace') { [System.IO.File]::Replace($i.temporary,$i.file,$null,$false); exit 0 }
  exit 2
} catch { exit 1 }`;

export function codexFileOps({platform=process.platform,env=process.env,run=runProtectedHelper}={}) {
  const helper=async(file,args,input='')=>{
    try {const result=await run(file,args,{input,env:{...env,LC_ALL:'C',CLICOLOR:'',CLICOLOR_FORCE:''},timeoutMs:10000});if(result.code!==0)throw refused();return result.stdout;}
    catch {throw refused();}
  };
  const windows=async input=>helper(join(env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-Command',WINDOWS],Buffer.from(JSON.stringify(input)).toString('base64'));
  return {
    async inspect(file) {
      if(platform==='darwin'){
        const listing=await helper('/bin/ls',['-lde@',file]);
        const mode=listing.split('\n')[0].match(/^-[rwxStTs-]{9}([@+ ]|$)/);
        const flags=(await helper('/usr/bin/stat',['-f','%f',file])).trim();
        if(!mode || ['@','+'].includes(mode[1]) || flags!=='0')throw refused();
        return {kind:'darwin',signature:signature(mode[0]+':'+flags)};
      }
      if(platform==='win32'){
        let result;try {result=JSON.parse(await windows({op:'inspect',file}));}catch{throw refused();}
        if(typeof result.descriptor!=='string' || !result.descriptor || !Number.isInteger(result.attributes))throw refused();
        const metadata={descriptor:result.descriptor,attributes:result.attributes};
        return {kind:'win32',...metadata,signature:signature(JSON.stringify(metadata))};
      }
      throw refused();
    },
    async prepare(file,temporary,metadata) {
      if(platform==='darwin'){
        // Clear any ACL inherited by the empty temporary before copying bytes
        // from an existing file which the inspection proved has no ACL.
        await helper('/bin/chmod',['-N',temporary]);
      }else if(platform==='win32')await windows({op:'prepare',file,temporary,descriptor:metadata.descriptor,attributes:metadata.attributes});
      else throw refused();
    },
    async replace(temporary,file,metadata) {
      if(platform==='darwin')return rename(temporary,file);
      if(platform!=='win32')throw refused();
      try {await windows({op:'replace',file,temporary,descriptor:metadata.descriptor,attributes:metadata.attributes});}
      catch {
        // ReplaceFile can fail after moving a file. Retain the protected
        // candidate for local recovery and never retry or silently rename it.
        const error=new ClientError('codex_replace_unconfirmed','Windows could not confirm configuration replacement. Do not retry automatically. Inspect config.toml and the protected .linebridge-codex-*.tmp recovery file locally before another preview.',EXIT.remote);
        error.preserveTemporary=true;throw error;
      }
    }
  };
}
