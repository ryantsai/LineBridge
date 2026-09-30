import {build} from 'esbuild';
import {readFile,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
const result=await build({entryPoints:['protocol/worker.mjs'],outfile:'protocol/line-worker.cjs',platform:'node',format:'cjs',target:'node24',bundle:true,metafile:true,legalComments:'linked',logLevel:'info'});
const packages=new Set(),notices=[];
for(const file of Object.keys(result.metafile.inputs)){
  if(!file.includes('node_modules/'))continue;
  let dir=dirname(file);while(dir.includes('node_modules')){
    try{const pkg=JSON.parse(await readFile(join(dir,'package.json'),'utf8'));if(pkg.name&&!packages.has(pkg.name)){packages.add(pkg.name);let license='';for(const name of ['LICENSE','LICENSE.md','LICENSE.txt','LICENCE','LICENCE.md','license','license.md']){try{license=await readFile(join(dir,name),'utf8');break;}catch{}}notices.push(`${pkg.name} ${pkg.version} (${pkg.license ?? 'see source'})\n${pkg.repository?.url ?? pkg.repository ?? ''}\n${license || 'See package source for license terms.'}`);}break;}catch{dir=dirname(dir);}
  }
}
await writeFile('protocol/third-party-notices.txt',notices.join('\n\n====================\n\n').split(/\r?\n/).map(line=>line.trimEnd()).join('\n').trimEnd()+'\n');
