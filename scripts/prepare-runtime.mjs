import {chmod,copyFile,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {buildPlan,root,runtimes,sha256,verifyChecksum,verifyExecutable} from './packaging.mjs';

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
  console.log(`Prepared verified ${plan.slug} runtimes: Node ${nodeVersion}, cloudflared ${runtimes.cloudflaredVersion}.`);
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  try{await prepareRuntime();}catch(error){console.error(error.message);process.exitCode=1;}
}
