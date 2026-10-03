import {chmod,copyFile,mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join,dirname,resolve,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {root,sha256,verifyChecksum,verifyExecutable} from './packaging.mjs';
import {bundleApp} from './bundle-app.mjs';
import {VERSION} from '../server/version.mjs';

export const portableNode=JSON.parse(await readFile(new URL('../packaging/portable-node.json',import.meta.url),'utf8'));
export function portablePlan(platform=process.platform,arch=process.arch){
  const runtime=portableNode.platforms[`${platform}-${arch}`];
  if(!runtime)throw new Error(`Unsupported portable host: ${platform}-${arch}. Use Windows x64, macOS x64/arm64 or glibc Linux x64/arm64.`);
  const name=platform==='win32'?'windows':platform==='darwin'?'macos':'linux';
  return {...runtime,platform,arch,slug:`${name}-${arch}`,nodeName:platform==='win32'?'node.exe':'node',launcher:platform==='win32'?'linebridge.cmd':'linebridge',extension:platform==='win32'?'zip':'tar.gz'};
}

export function launcher(platform){
  if(platform==='win32')return '@echo off\r\nsetlocal DisableDelayedExpansion\r\n"%~dp0runtime\\node.exe" "%~dp0app\\bin\\linebridge.mjs" %*\r\nexit /b %errorlevel%\r\n';
  // No dirname/env lookup: the launcher also works with an empty PATH. Keep the
  // caller's working directory so relative --text-file/--data-dir values work.
  return '#!/bin/sh\ncase $0 in\n  */*) base=${0%/*} ;;\n  *) base=. ;;\nesac\nbase=$(CDPATH= cd -- "$base" && pwd -P) || exit 1\nexec "$base/runtime/node" "$base/app/bin/linebridge.mjs" "$@"\n';
}

async function verifiedDownload(path,url,expected){
  try{const bytes=await readFile(path);verifyChecksum(bytes,expected,url);return;}
  catch(error){if(error.code!=='ENOENT')throw error;}
  const response=await fetch(url,{signal:AbortSignal.timeout(120000)});
  if(!response.ok)throw new Error(`Runtime download failed (${response.status}): ${url}`);
  const bytes=Buffer.from(await response.arrayBuffer());verifyChecksum(bytes,expected,url);
  await mkdir(dirname(path),{recursive:true});await writeFile(path,bytes);
}

export async function buildPortable(){
  const plan=portablePlan(),buildRoot=resolve(root,'runtime');
  await mkdir(buildRoot,{recursive:true});
  const stage=await mkdtemp(join(buildRoot,'portable-build-'));
  try{
    const directory=`LineBridge-${VERSION}-${plan.slug}`,bundle=join(stage,directory),runtime=join(bundle,'runtime');
    await mkdir(runtime,{recursive:true});
    const source=`https://nodejs.org/dist/v${portableNode.nodeVersion}/${plan.asset}`;
    const download=join(buildRoot,'portable-downloads',plan.asset);
    await verifiedDownload(download,source,plan.sha256);
    const extracted=join(stage,'node-source'),prefix=plan.asset.replace(/\.(zip|tar\.gz)$/,''),nodeEntry=plan.platform==='win32'?'node.exe':'bin/node';
    await mkdir(extracted);
    execFileSync('tar',['-xf',relative(extracted,download),`${prefix}/${nodeEntry}`,`${prefix}/LICENSE`],{cwd:extracted,stdio:'pipe',windowsHide:true});
    const nodeBytes=await readFile(join(extracted,prefix,nodeEntry));verifyExecutable(nodeBytes,plan);
    const nodePath=join(runtime,plan.nodeName);await writeFile(nodePath,nodeBytes,{mode:0o755});
    if(plan.platform!=='win32')await chmod(nodePath,0o755);
    await copyFile(join(extracted,prefix,'LICENSE'),join(runtime,'node-LICENSE.txt'));
    const actual=JSON.parse(execFileSync(nodePath,['-p','JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch})'],{encoding:'utf8',windowsHide:true}));
    if(actual.version!==portableNode.nodeVersion || actual.platform!==plan.platform || actual.arch!==plan.arch)throw new Error('Bundled Node failed the native version/platform check.');
    await writeFile(join(runtime,'node-source.json'),JSON.stringify({version:actual.version,platform:plan.platform,architecture:plan.arch,source,downloadSha256:plan.sha256,sha256:sha256(nodeBytes),checksumVerified:true,license:'node-LICENSE.txt'},null,2)+'\n');
    await bundleApp(join(bundle,'app'),['bin/linebridge.mjs','protocol/worker.mjs']);
    await writeFile(join(bundle,plan.launcher),launcher(plan.platform),{mode:0o755});
    for(const file of ['CLI.md','PACKAGING.md','CONNECTIONS.md','SEARCH.md','ALIASES.md','openapi.json'])await copyFile(join(root,file),join(bundle,file));
    const command=plan.platform==='win32'?'.\\linebridge.cmd':'./linebridge';
    await writeFile(join(bundle,'README.txt'),`LineBridge ${VERSION} — portable CLI and local service\n\nNo separate Node.js, npm or compiler installation is needed.\nKeep this entire extracted folder together; the launcher uses runtime/${plan.nodeName}.\n${plan.requirements}\n\nFrom this folder:\n  ${command} --version\n  ${command} accounts --help\n  ${command} serve\n\nServe stays in the foreground. Open http://127.0.0.1:3210 to bind your LINE account\nusing your phone. Designate chats and create a scoped API key in the dashboard\nbefore using data commands. Supply credentials as described in CLI.md.\nFrom another terminal:\n  ${command} status\n  ${command} stop\n\nA cloud AI that already controls this PC's terminal can use the local gateway.\nAn AI running only on a remote cloud host needs a reachable gateway URL.\nTunnel helpers are optional and are not included in this portable archive;\nsee CONNECTIONS.md or use the desktop distribution with bundled connectors.\n\nUse the launcher path instead of "linebridge" in documentation examples.\nYou can add this entire folder to PATH; do not move the launcher by itself.\nNo PATH, autostart or system-service settings are changed by extraction.\nAccounts and encrypted data live in the normal per-user LineBridge data folder,\nnot here. Preserve that data folder and its key when updating this app folder.\nUse --data-dir to select a separate data folder.\n\nRuntime provenance/license: runtime/node-source.json and runtime/node-LICENSE.txt.\nDependency licenses: app/third-party-notices.txt.\n`);
    const info={product:'LineBridge',version:VERSION,distribution:'portable-cli',platform:plan.platform,architecture:plan.arch,directory,launcher:plan.launcher,nodeVersion:actual.version,requirements:plan.requirements};
    await writeFile(join(bundle,'bundle-info.json'),JSON.stringify(info,null,2)+'\n');
    const out=join(root,'release','portable',plan.slug);await mkdir(out,{recursive:true});
    const filename=`${directory}.${plan.extension}`,file=join(out,filename);
    execFileSync('tar',[...(plan.platform==='win32'?['-a','-cf']:['-czf']),relative(stage,file),directory],{cwd:stage,stdio:'pipe',windowsHide:true});
    const bytes=await readFile(file),digest=sha256(bytes);
    await writeFile(join(out,'SHA256SUMS.txt'),`${digest}  ${filename}\n`);
    await writeFile(join(out,'build-info.json'),JSON.stringify({...info,filename,sha256:digest,bytes:bytes.length},null,2)+'\n');
    console.log(file);return {...info,filename,file,sha256:digest};
  }finally{
    // Only remove the fresh staging directory inside this repository's runtime.
    const child=relative(buildRoot,stage);
    if(!child.startsWith('portable-build-') || child.includes(sep) || dirname(stage)!==buildRoot)throw new Error('Refusing unsafe portable staging cleanup.');
    await rm(stage,{recursive:true,force:true});
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{if(process.argv.length!==2)throw new Error('Build on the target OS/architecture; no cross-compilation flags are supported.');await buildPortable();}
  catch(error){console.error(error.message);process.exitCode=1;}
}
