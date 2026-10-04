import {build} from 'esbuild';
import {cp,mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {root} from './packaging.mjs';

// Both distributions retain the source directory layout for worker/public paths.
export async function bundleApp(destination,entries){
  await mkdir(destination,{recursive:true});
  const packages=new Set();
  for(const entry of entries){
    const result=await build({absWorkingDir:root,entryPoints:[entry],outfile:join(destination,entry),bundle:true,platform:'node',target:'node24',format:'esm',metafile:true,legalComments:'external',banner:{js:"import {createRequire as __createRequire} from 'node:module'; const require=__createRequire(import.meta.url);"}});
    for(const input of Object.keys(result.metafile.inputs)){
      const match=input.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)/);if(match)packages.add(match[1]);
    }
  }
  await cp(join(root,'public'),join(destination,'public'),{recursive:true});
  await cp(join(root,'LICENSE'),join(destination,'LICENSE'));
  let notices='LineBridge bundled service — third-party notices\n\n';
  for(const name of [...packages].sort()){
    const dir=join(root,'node_modules',name),pkg=JSON.parse(await readFile(join(dir,'package.json'),'utf8'));
    notices+=`\n=== ${name} ${pkg.version} (${pkg.license??'see upstream'}) ===\n`;
    for(const file of (await readdir(dir)).filter(f=>/^(LICENSE|COPYING|NOTICE)(\.|$)/i.test(f)))notices+=await readFile(join(dir,file),'utf8')+'\n';
  }
  await writeFile(join(destination,'third-party-notices.txt'),notices);
  await cp(join(root,'protocol/third-party-notices.txt'),join(destination,'protocol/third-party-notices.txt'));
}
