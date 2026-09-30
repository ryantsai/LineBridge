import {execFileSync} from 'node:child_process';
import {copyFile,mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {buildPlan,root,runtimes,sha256} from './packaging.mjs';
import {prepareRuntime} from './prepare-runtime.mjs';

try{
  const args=process.argv.slice(2),requested=args.find(v=>v.startsWith('--platform='))?.split('=')[1];
  if(args.some(v=>v!=='--dev'&&!['--platform=windows','--platform=macos'].includes(v)))throw new Error('Usage: node scripts/desktop.mjs [--dev] [--platform=windows|macos]');
  const plan=buildPlan(process.platform,process.arch,requested);
  const host=execFileSync('rustc',['-vV'],{cwd:root,encoding:'utf8'}).match(/^host: (.+)$/m)?.[1]?.trim();
  if(host!==plan.target)throw new Error(`Rust host ${host} does not match Node's ${plan.target}; use native tools for the selected architecture.`);
  execFileSync(process.execPath,['scripts/build-protocol.mjs'],{cwd:root,stdio:'inherit'});
  await prepareRuntime(plan);
  const cli=join(root,'node_modules/@tauri-apps/cli/tauri.js');
  execFileSync(process.execPath,[cli,args.includes('--dev')?'dev':'build',...(!args.includes('--dev')?['--bundles',plan.bundle]:[])],{cwd:root,stdio:'inherit',windowsHide:true});
  if(!args.includes('--dev')){
    const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
    const source=join(root,'target/release/bundle',plan.bundle),dest=join(root,'release',plan.slug);
    const files=(await readdir(source)).filter(name=>name.startsWith(`LineBridge_${pkg.version}_`) && name.endsWith(plan.platform==='win32'?'-setup.exe':'.dmg'));
    if(files.length!==1)throw new Error(`Expected one current installer in ${source}; found ${files.length}.`);
    await mkdir(dest,{recursive:true});
    const name=files[0],hash=sha256(await readFile(join(source,name)));
    await copyFile(join(source,name),join(dest,name));
    await writeFile(join(dest,'SHA256SUMS.txt'),`${hash}  ${name}\n`);
    await writeFile(join(dest,'build-info.json'),JSON.stringify({product:'LineBridge',version:pkg.version,platform:plan.name,architecture:plan.arch,target:plan.target,file:name,sha256:hash,node:runtimes.nodeVersion,cloudflared:runtimes.cloudflaredVersion,signing:plan.platform==='win32'?'unsigned':'ad-hoc; not notarized'},null,2)+'\n');
    console.log(`Installer and SHA-256 checksum: ${join(dest,name)}`);
  }
}catch(error){console.error(error.message);process.exitCode=1;}
