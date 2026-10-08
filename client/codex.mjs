import {parseArgs, isDeepStrictEqual} from 'node:util';
import {createHash, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {open, lstat, stat, access, realpath, mkdir, link, rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, join, resolve, isAbsolute} from 'node:path';
import {parse as parseToml, stringify as stringifyToml} from 'smol-toml';
import {ClientError, EXIT, usage} from './errors.mjs';
import {mcpOptions, toolNames, verifyMcp} from './mcp.mjs';
import {VERSION} from '../server/version.mjs';
import {codexFileOps} from './codex-files.mjs';

const PREFIX='# >>> LineBridge Codex MCP v1 ',SUFFIX='# <<< LineBridge Codex MCP v1 ',MAX_CONFIG=2*1024*1024;
const hash=value=>createHash('sha256').update(value).digest('hex');
const failure=(code,message)=>new ClientError(code,message,EXIT.remote);
const object=value=>value!==null && typeof value==='object' && !Array.isArray(value);
const plain=value=>Array.isArray(value) ? value.map(plain) : object(value) && Object.getPrototypeOf(value)===null ? Object.fromEntries(Object.entries(value).map(([key,item])=>[key,plain(item)])) : value;
function parseConfig(text) {
  try { return plain(parseToml(text,{integersAsBigInt:'asNeeded'})); }
  catch { throw failure('codex_config_invalid','Codex configuration is not supported valid TOML. No config was changed; repair it in Codex settings first.'); }
}
function serverName(value='linebridge') {
  if(typeof value!=='string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(value))usage('Use --name with 1-64 lowercase ASCII letters, digits, underscores or hyphens, starting with a letter.');
  return value;
}
function safePath(value) {
  if(typeof value!=='string' || !value || /[\x00-\x1f\x7f]/.test(value))usage('Use a nonempty path without control characters.');
  return resolve(value);
}
async function directoryState(directory) {
  try {const stat=await lstat(directory);if(!stat.isDirectory() || stat.isSymbolicLink())throw failure('codex_config_unsafe','The Codex directory must be a regular directory, not a symlink.');return stat;}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
}
async function target(values,env) {
  if(!['project','user'].includes(values.scope))usage('Explicitly choose --scope project --project DIR, or --scope user.');
  let directory;
  if(values.scope==='project'){
    if(!values.project || values['codex-home']!==undefined)usage('Project scope requires --project DIR and does not accept --codex-home.');
    let project;
    try {project=await realpath(safePath(values.project));if(!(await lstat(project)).isDirectory())throw new Error();}
    catch {usage('The selected project directory must already exist.');}
    directory=join(project,'.codex');
  }else{
    if(values.project!==undefined)usage('User scope does not accept --project.');
    directory=safePath(values['codex-home'] || env.CODEX_HOME || join(homedir(),'.codex'));
  }
  await directoryState(directory);
  return join(directory,'config.toml');
}
async function snapshot(file,fileOps) {
  await directoryState(dirname(file));
  let handle;
  try {
    const before=await lstat(file);
    if(!before.isFile() || before.isSymbolicLink() || before.nlink!==1 || before.size>MAX_CONFIG || (before.mode & 0o7000) || (process.getuid && before.uid!==process.getuid()))throw failure('codex_config_unsafe','Refusing a linked, oversized, non-regular, specially permissioned or differently owned Codex configuration file.');
    handle=await open(file,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat=await handle.stat();
    if(stat.dev!==before.dev || stat.ino!==before.ino || stat.nlink!==1)throw failure('codex_config_changed','Codex configuration changed while being inspected. Preview again.');
    const bytes=await handle.readFile();
    if(bytes.length>MAX_CONFIG)throw failure('codex_config_unsafe','Codex configuration exceeds the size limit.');
    let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw failure('codex_config_invalid','Codex configuration must be valid UTF-8.');}
    // A BOM would otherwise be lost in a byte-preserving rewrite.
    if(bytes.length && !Buffer.from(text).equals(bytes))throw failure('codex_config_invalid','Remove the UTF-8 BOM from Codex configuration before using this installer.');
    const metadata=await fileOps.inspect(file);
    return {text,exists:true,revision:hash(bytes),identity:`${stat.dev}:${stat.ino}:${stat.mode}:${stat.uid}:${stat.gid}:${metadata.signature}`,mode:stat.mode & 0o777,uid:stat.uid,gid:stat.gid,metadata};
  }catch(error){if(error.code==='ENOENT')return {text:'',exists:false,revision:hash(''),identity:'absent',mode:0o600};throw error;}
  finally{await handle?.close();}
}
function configEntry(options,launcher) {
  return {command:launcher.node,args:[launcher.script,'mcp','--profile',options.profile,'--url',options.url,'--tools',options.mode,'--client-config',options.directory],enabled_tools:toolNames(options.mode),startup_timeout_sec:20,tool_timeout_sec:50};
}
function describeEntry(entry) {
  const args=entry?.args;
  if(!object(entry) || !isAbsolute(entry.command ?? '') || !Array.isArray(args) || args.length!==10 || !isAbsolute(args[0] ?? '') || args[1]!=='mcp' || args[2]!=='--profile' || args[4]!=='--url' || args[6]!=='--tools' || args[8]!=='--client-config' || !isAbsolute(args[9] ?? ''))throw failure('codex_entry_modified','The managed entry no longer matches a supported LineBridge adapter. Review it manually in Codex settings.');
  let options;
  try {options=mcpOptions({profile:args[3],url:args[5],tools:args[7],'client-config':args[9]},{});}
  catch {throw failure('codex_entry_modified','The managed entry has unsupported adapter options. Review it manually in Codex settings.');}
  if(!isDeepStrictEqual(entry,configEntry(options,{node:entry.command,script:args[0]})))throw failure('codex_entry_modified','The managed entry has been customized. Review it manually in Codex settings.');
  return options;
}
function withoutServer(config,name) {
  if(object(config.mcp_servers)){
    config={...config,mcp_servers:{...config.mcp_servers}};
    delete config.mcp_servers[name];
    if(Object.keys(config.mcp_servers).length===0)delete config.mcp_servers;
  }
  return config;
}
function managed(text,name) {
  const config=parseConfig(text),entry=object(config.mcp_servers) && Object.hasOwn(config.mcp_servers,name) ? config.mcp_servers[name] : undefined;
  const startText=`\n${PREFIX}${name} `,endText=`${SUFFIX}${name}\n`;
  const start=text.indexOf(startText);
  if(start<0){if(entry!==undefined)throw failure('codex_entry_conflict','This server name is already configured outside a LineBridge-managed block. Choose another --name or review it manually; it will not be overwritten.');return {rest:text};}
  const lineEnd=text.indexOf('\n',start+1),end=text.indexOf(endText,lineEnd+1);
  if(lineEnd<0 || end<0 || text.indexOf(startText,start+1)>=0)throw failure('codex_entry_modified','The LineBridge-managed block is incomplete or duplicated. Review it manually.');
  const fingerprint=text.slice(start+startText.length,lineEnd),body=text.slice(lineEnd+1,end);
  if(!/^[a-f0-9]{64}$/.test(fingerprint) || hash(body)!==fingerprint)throw failure('codex_entry_modified','The LineBridge-managed block was edited. Refusing to replace or remove it; review it manually.');
  const blockConfig=parseConfig(body),blockEntry=blockConfig.mcp_servers?.[name];
  if(!isDeepStrictEqual(blockConfig,{mcp_servers:{[name]:blockEntry}}) || !isDeepStrictEqual(entry,blockEntry))throw failure('codex_entry_modified','The LineBridge-managed entry extends outside its block. Review it manually.');
  const rest=text.slice(0,start)+text.slice(end+endText.length);
  // This also rejects forged marker comments inside multiline TOML strings and
  // accidental table-scope changes to unrelated keys when removing a block.
  if(!isDeepStrictEqual(withoutServer(config,name),withoutServer(parseConfig(rest),name)) || Object.hasOwn(parseConfig(rest).mcp_servers ?? {},name))throw failure('codex_entry_modified','The managed block cannot be removed without changing other configuration. Review it manually.');
  return {rest,entry,options:describeEntry(entry),start,end:end+endText.length};
}
function block(name,entry) {
  const body=stringifyToml({mcp_servers:{[name]:entry}})+'\n';
  return `\n${PREFIX}${name} ${hash(body)}\n${body}${SUFFIX}${name}\n`;
}
const NOTES = [
  'Persistent MCP access applies to future Codex sessions in the selected scope. It reuses the selected protected profile; gateway account/chat grants remain authoritative and may change later.',
  'Read access is the default. read-send only exposes send tools; each message still needs explicit user approval, an idempotency key and any required transport-security acknowledgment.',
  'Restart the Codex MCP connection after a change. Project configuration loads only in trusted projects; this command does not change trust. Other layers or organization policy may override or disable it.',
  'Custom file protection or unavailable native metadata checks block automatic changes. On an unconfirmed Windows replacement, inspect the protected temporary locally; never retry automatically.',
  'This config is for a Codex host on this Windows/Mac computer. It does not register a cloud Dot/ChatGPT connector, start LineBridge, enroll credentials or grant remote access.'
];

export async function planCodex(values,{env=process.env,launcher={node:process.execPath,script:resolve(process.argv[1])},fileOps=codexFileOps({env})} = {}) {
  const name=serverName(values.name),operation=values.action ?? 'install';
  if(!['install','uninstall'].includes(operation))usage('Preview --action must be install or uninstall.');
  const options=operation==='install' ? mcpOptions(values,env) : undefined;
  const file=await target(values,env),before=await snapshot(file,fileOps),owned=managed(before.text,name);
  let entry,after;
  if(operation==='install'){
    entry=configEntry(options,{node:safePath(launcher.node),script:safePath(launcher.script)});
    if(owned.entry && !isDeepStrictEqual(entry,owned.entry) && values.replace!==true)throw failure('codex_replace_required','A different LineBridge entry already exists. Preview again with --replace to explicitly review replacement, or choose another --name.');
    after=owned.entry && isDeepStrictEqual(entry,owned.entry) ? before.text : owned.entry ? before.text.slice(0,owned.start)+block(name,entry)+before.text.slice(owned.end) : before.text+block(name,entry);
  }else after=owned.rest;
  // Validate both the result and semantic preservation of all other settings.
  if(!isDeepStrictEqual(withoutServer(parseConfig(before.text),name),withoutServer(parseConfig(after),name)))throw failure('codex_config_conflict','The requested table cannot be added without changing other configuration. Review Codex settings manually.');
  const consent=hash(JSON.stringify({operation,file,name,scope:values.scope,replace:values.replace===true,before:before.revision,identity:before.identity,after:hash(after)}));
  return {file,before,after,consent,entry,owned,public:{action:operation,scope:values.scope,file,name,change:after===before.text ? 'none' : operation==='uninstall' ? 'remove' : owned.entry ? 'replace' : 'add',consent,
    ...(options ? {profile:options.profile,url:options.url,tools:options.mode,clientConfig:options.directory,configuration:entry} : {}),
    ...(owned.options ? {existing:{profile:owned.options.profile,url:owned.options.url,tools:owned.options.mode}} : {}),notes:NOTES}};
}

async function applyPlan(plan,{beforeCommit,fileOps} = {}) {
  if(plan.after===plan.before.text)return;
  const directory=dirname(plan.file),lockPath=join(directory,'.linebridge-codex.lock'),temporary=join(directory,`.linebridge-codex-${randomUUID()}.tmp`);
  await mkdir(directory,{recursive:true,mode:0o700});await directoryState(directory);
  let lock,temp,createdTemp=false,preserveTemporary=false;
  try {
    try {lock=await open(lockPath,'wx',0o600);}
    catch {throw failure('codex_config_busy','Another installer may be editing this Codex directory. Close it and preview again. A stale .linebridge-codex.lock requires manual inspection before removal.');}
    temp=await open(temporary,'wx',0o600);createdTemp=true;
    if(plan.before.exists)await fileOps.prepare(plan.file,temporary,plan.before.metadata);
    if(plan.before.exists && plan.before.metadata.kind!=='win32'){
      // A same-mode replacement with a different group can disclose config to
      // new readers. Preserve ownership while the candidate is still empty.
      try {
        let ownership=await temp.stat();
        if(ownership.uid!==plan.before.uid || ownership.gid!==plan.before.gid)await temp.chown(plan.before.uid,plan.before.gid);
        ownership=await temp.stat();
        if(ownership.uid!==plan.before.uid || ownership.gid!==plan.before.gid)throw new Error();
      }catch{throw failure('codex_metadata_unsupported','The existing configuration owner/group could not be preserved. No automatic replacement is allowed; use manual Codex configuration.');}
    }
    await temp.writeFile(plan.after);if(plan.before.metadata?.kind!=='win32')await temp.chmod(plan.before.mode);await temp.sync();await temp.close();temp=undefined;
    await beforeCommit?.();
    const current=await snapshot(plan.file,fileOps);
    if(current.revision!==plan.before.revision || current.identity!==plan.before.identity)throw failure('codex_config_changed','Codex configuration changed after preview. Nothing was replaced; preview again.');
    // New files use no-clobber creation. Existing files use an atomic rename
    // after the final comparison; close other config editors during installation.
    if(plan.before.exists)await fileOps.replace(temporary,plan.file,plan.before.metadata);else await link(temporary,plan.file);
  }catch(error){preserveTemporary=error.preserveTemporary===true;throw error;}
  finally{await temp?.close();if(createdTemp&&!preserveTemporary)await rm(temporary,{force:true});if(lock){await lock.close();await rm(lockPath,{force:true});}}
}

async function checkLauncher(entry) {
  try {
    if(!(await stat(entry.command)).isFile() || !(await stat(entry.args[0])).isFile())throw new Error();
    await access(entry.command,process.platform==='win32' ? constants.F_OK : constants.X_OK);await access(entry.args[0],constants.R_OK);
  }catch{throw failure('codex_launcher_unavailable','The configured Node runtime or LineBridge script is unavailable. After moving or updating an installation, preview replacement from its current launcher.');}
}

export const CODEX_HELP = `LineBridge ${VERSION} Codex integration (Windows/macOS, Node 24+)
  linebridge codex preview --scope project --project DIR --profile NAME --url GATEWAY
  linebridge codex install <same options> --consent PREVIEW_DIGEST
  linebridge codex verify --scope project --project DIR [--connect]
  linebridge codex preview --action uninstall --scope project --project DIR
  linebridge codex uninstall --scope project --project DIR --consent PREVIEW_DIGEST

Choose --scope user instead for shared host config (optional --codex-home DIR;
otherwise CODEX_HOME or ~/.codex). Project scope requires an existing directory.
Options: --name linebridge, --tools read|read-send (default read),
         --client-config DIR (existing protected profiles), --replace.
Preview never reads credentials or contacts a gateway. Install/removal require
its exact consent digest and options; a stale preview cannot authorize a change.
--replace is only for intact LineBridge-managed entries; foreign or edited entries
are refused. Close other config editors during a change. No config backups copy
secrets. Uninstall preserves protected profiles, grants and all other settings.
Unsupported custom ACL/metadata protection requires manual Codex configuration.
Verify checks this config layer only; --connect explicitly opens the existing
protected profile and calls initialize, tools/list and line_get_version only.
See CODEX.md for trust, credential, packaging and local/cloud limitations.
`;
function parse(argv) {
  let result;
  try {result=parseArgs({args:argv,allowPositionals:true,strict:true,tokens:true,options:Object.fromEntries([
    ...['scope','project','codex-home','profile','url','name','tools','client-config','action','consent'].map(k=>[k,{type:'string'}]),...['help','replace','connect'].map(k=>[k,{type:'boolean'}])])});}
  catch{usage('Invalid Codex integration arguments. See linebridge codex --help.');}
  const {values,positionals,tokens}=result,keys=tokens.filter(t=>t.kind==='option').map(t=>t.name);
  if(new Set(keys).size!==keys.length)usage('Do not repeat Codex integration options.');
  if(values.help)return {command:'help',values};
  if(positionals.length!==1 || !['preview','install','uninstall','verify'].includes(positionals[0]))usage('Use linebridge codex preview, install, uninstall or verify.');
  const command=positionals[0];
  if(values.action!==undefined && command!=='preview' || values.connect!==undefined && command!=='verify' || values.consent!==undefined && !['install','uninstall'].includes(command))usage('action is for preview, connect is for verify, and consent is for install/uninstall.');
  const removing=command==='uninstall' || command==='preview' && values.action==='uninstall';
  if((removing || command==='verify') && ['profile','url','tools','client-config','replace'].some(k=>values[k]!==undefined))usage('Removal and verification use the installed entry; omit profile, url, tools, client-config and replace.');
  if(['install','uninstall'].includes(command) && !/^[a-f0-9]{64}$/.test(values.consent ?? ''))usage('Run codex preview first and pass its exact --consent digest to apply the reviewed change.');
  return {command,values};
}
export async function runCodex(argv,context={}) {
  const {env=process.env,stdout=process.stdout,stderr=process.stderr}=context;
  const fileOps=context.fileOps ?? codexFileOps({env});
  try {
    const {command,values}=parse(argv);
    let result;
    if(command==='help'){stderr.write(CODEX_HELP);result={version:VERSION,commands:['preview','install','uninstall','verify']};}
    else if(command==='verify'){
      const file=await target(values,env),name=serverName(values.name),before=await snapshot(file,fileOps),owned=managed(before.text,name);
      if(!owned.entry)throw failure('codex_not_installed','No LineBridge-managed entry was found in this config layer. Run preview first.');
      await checkLauncher(owned.entry);
      result={configured:true,launcherAvailable:true,scope:values.scope,file,name,profile:owned.options.profile,url:owned.options.url,tools:owned.options.mode,connected:false,effectiveCodexConfigurationVerified:false,notes:NOTES};
      if(values.connect)Object.assign(result,await verifyMcp(owned.options,{env,store:context.store,fetchImpl:context.fetchImpl}));
    }else{
      const plan=await planCodex({...values,action:command==='preview' ? values.action : command},{...context,env,fileOps});
      if(command==='preview')result={...plan.public,applied:false};
      else{
        if(values.consent!==plan.consent)throw failure('codex_consent_stale','The preview digest does not match this operation, options or current config. Nothing was changed; preview again.');
        await applyPlan(plan,{...context,fileOps});result={...plan.public,applied:true};
      }
    }
    stdout.write(`${JSON.stringify(result)}\n`);return EXIT.ok;
  }catch(error){
    const safe=error instanceof ClientError ? error : failure('codex_config_unavailable','The Codex integration could not complete. Check file permissions and installation paths; no retry was attempted.');
    stdout.write(`${JSON.stringify({error:safe.code,message:safe.message})}\n`);stderr.write(`${safe.code}: ${safe.message}\n`);return safe.exitCode;
  }
}
