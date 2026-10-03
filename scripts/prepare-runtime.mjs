import {chmod,copyFile,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {buildPlan,root,runtimes,sha256,verifyChecksum,verifyExecutable} from './packaging.mjs';
import {TAILCAT_VERSION,tailcatWindows} from '../server/connector-install.mjs';

async function download(url){
  const response=await fetch(url,{signal:AbortSignal.timeout(120000)});
  if(!response.ok)throw new Error(`Download failed (${response.status}): ${url}`);
  return Buffer.from(await response.arrayBuffer());
}
async function verifiedFile(path,url,hash){
  let bytes;try{bytes=await readFile(path);verifyChecksum(bytes,hash,basename(path));return bytes;}catch{}
  bytes=await download(url);verifyChecksum(bytes,hash,basename(path));await writeFile(path,bytes);return bytes;
}
export async function prepareRuntime(plan=buildPlan()){
  const runtime=join(root,'runtime'),tools=join(root,'tools'),cache=join(runtime,'downloads');
  await mkdir(cache,{recursive:true});await mkdir(tools,{recursive:true});
  const nodeUrl=`https://nodejs.org/dist/v${runtimes.nodeVersion}/${plan.nodeAsset}`;
  const cloudUrl=`https://github.com/cloudflare/cloudflared/releases/download/${runtimes.cloudflaredVersion}/${plan.cloudflaredAsset}`;
  const nodePath=join(runtime,plan.nodeName),cloudPath=join(tools,plan.connectorName);
  if(plan.platform==='win32'){
    // process.execPath resolves nvm's launcher to the actual runtime.
    let nodeReady=false;
    try{nodeReady=sha256(await readFile(nodePath))===plan.nodeSha256;}catch{}
    if(!nodeReady && process.version===`v${runtimes.nodeVersion}`){
      const local=await readFile(process.execPath);
      if(sha256(local)===plan.nodeSha256)await copyFile(process.execPath,nodePath);
    }
    verifyExecutable(await verifiedFile(nodePath,nodeUrl,plan.nodeSha256),plan);
    verifyExecutable(await verifiedFile(cloudPath,cloudUrl,plan.cloudflaredSha256),plan);
  }else{
    const nodeArchive=join(cache,plan.nodeAsset),cloudArchive=join(cache,plan.cloudflaredAsset);
    await verifiedFile(nodeArchive,nodeUrl,plan.nodeSha256);await verifiedFile(cloudArchive,cloudUrl,plan.cloudflaredSha256);
    const nodeFolder=plan.nodeAsset.replace(/\.tar\.gz$/,'');
    execFileSync('tar',['-xzf',nodeArchive,'-C',cache,`${nodeFolder}/bin/node`]);
    const cloudEntry=execFileSync('tar',['-tzf',cloudArchive],{encoding:'utf8'}).split('\n').find(v=>v==='cloudflared'||v==='./cloudflared');
    if(!cloudEntry)throw new Error('The cloudflared archive does not contain its expected executable.');
    execFileSync('tar',['-xzf',cloudArchive,'-C',cache,cloudEntry]);
    await copyFile(join(cache,nodeFolder,'bin/node'),nodePath);await copyFile(join(cache,'cloudflared'),cloudPath);
    for(const path of [nodePath,cloudPath]){verifyExecutable(await readFile(path),plan);await chmod(path,0o755);}
    // Tauri sidecars use target-suffixed sources and are signed into Contents/MacOS.
    await copyFile(nodePath,join(runtime,`node-${plan.target}`));await copyFile(cloudPath,join(tools,`cloudflared-${plan.target}`));
    await chmod(join(runtime,`node-${plan.target}`),0o755);await chmod(join(tools,`cloudflared-${plan.target}`),0o755);
  }
  const nodeVersion=execFileSync(nodePath,['--version'],{encoding:'utf8'}).trim();
  if(nodeVersion!==`v${runtimes.nodeVersion}`)throw new Error('Prepared Node runtime reports an unexpected version.');
  const cloudVersion=execFileSync(cloudPath,['--version'],{encoding:'utf8'});
  if(!cloudVersion.includes(`cloudflared version ${runtimes.cloudflaredVersion} `))throw new Error('Prepared cloudflared reports an unexpected version.');
  await writeFile(join(runtime,'node-LICENSE.txt'),await download(`https://raw.githubusercontent.com/nodejs/node/v${runtimes.nodeVersion}/LICENSE`));
  const manifest=(version,source,downloadSha256,binary,license)=>({version,platform:plan.platform,architecture:plan.arch,source,downloadSha256,sha256:sha256(binary),checksumVerified:true,license});
  await writeFile(join(runtime,'node-source.json'),JSON.stringify(manifest(nodeVersion,nodeUrl,plan.nodeSha256,await readFile(nodePath),'node-LICENSE.txt'),null,2)+'\n');
  await writeFile(join(runtime,'cloudflared-source.json'),JSON.stringify(manifest(runtimes.cloudflaredVersion,cloudUrl,plan.cloudflaredSha256,await readFile(cloudPath),'cloudflared-LICENSE.txt'),null,2)+'\n');
  const tailcatPath=join(tools,plan.platform==='win32'?'tailcat.exe':'tailcat');let tailcatSource;
  if(plan.platform==='win32'){
    const url=`https://github.com/tailscale/tailcat/releases/download/v${TAILCAT_VERSION}/${tailcatWindows.asset}`,archive=join(cache,tailcatWindows.asset),dest=join(cache,'tailcat-windows');await mkdir(dest,{recursive:true});
    await verifiedFile(archive,url,tailcatWindows.sha256);execFileSync('tar',['-xf',archive,'-C',dest,'tailcat.exe','LICENSE']);await copyFile(join(dest,'tailcat.exe'),tailcatPath);await copyFile(join(dest,'LICENSE'),join(runtime,'tailcat-LICENSE.txt'));
    tailcatSource={version:TAILCAT_VERSION,source:url,downloadSha256:tailcatWindows.sha256,checksumVerified:true};
  }else{
    const dest=join(cache,'tailcat-build');await mkdir(dest,{recursive:true});
    const tags=(await readFile(join(root,'packaging/tailcat-build-tags.txt'),'utf8')).trim(),goEnv={...process.env,GOBIN:dest,CGO_ENABLED:'0',GOTOOLCHAIN:'local'};
    const module=JSON.parse(execFileSync('go',['mod','download','-json',`github.com/tailscale/tailcat@v${TAILCAT_VERSION}`],{env:goEnv,encoding:'utf8'}));
    if(module.Sum!==runtimes.tailcatModuleSum)throw new Error('Tailcat module checksum does not match the pinned source.');
    if((await readFile(join(module.Dir,'build-tags.txt'),'utf8')).trim()!==tags)throw new Error('Tailcat build flags differ from the pinned release.');
    execFileSync('go',['install','-trimpath',`-tags=${tags}`,`-ldflags=-s -w -X main.version=v${TAILCAT_VERSION}`,`github.com/tailscale/tailcat/cmd/tailcat@v${TAILCAT_VERSION}`],{env:goEnv,stdio:'inherit'});
    await copyFile(join(dest,'tailcat'),tailcatPath);await chmod(tailcatPath,0o755);
    // Go's module cache is read-only. Resource copies must stay writable so
    // Tauri can copy them again during test, Clippy and the release build.
    const licensePath=join(runtime,'tailcat-LICENSE.txt');await chmod(licensePath,0o644).catch(error=>{if(error.code!=='ENOENT')throw error;});
    await writeFile(licensePath,await readFile(join(module.Dir,'LICENSE')),{mode:0o644});
    await copyFile(tailcatPath,join(tools,`tailcat-${plan.target}`));await chmod(join(tools,`tailcat-${plan.target}`),0o755);
    tailcatSource={version:TAILCAT_VERSION,source:'github.com/tailscale/tailcat',moduleSum:module.Sum,go:execFileSync('go',['version'],{encoding:'utf8'}).trim(),checksumVerified:true};
  }
  verifyExecutable(await readFile(tailcatPath),plan);if(execFileSync(tailcatPath,['version'],{encoding:'utf8'}).trim()!==`v${TAILCAT_VERSION}`)throw new Error('Unexpected Tailcat version.');
  await writeFile(join(runtime,'tailcat-source.json'),JSON.stringify({...tailcatSource,platform:plan.platform,architecture:plan.arch,sha256:sha256(await readFile(tailcatPath)),license:'tailcat-LICENSE.txt'},null,2)+'\n');
  console.log(`Prepared verified ${plan.slug} runtimes: Node ${nodeVersion}, cloudflared ${runtimes.cloudflaredVersion}, Tailcat ${TAILCAT_VERSION}.`);
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  try{await prepareRuntime();}catch(error){console.error(error.message);process.exitCode=1;}
}
