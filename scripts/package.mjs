import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {npm} from './npm.mjs';
export function validateArchive(files){
  const paths=files.map(f=>typeof f==='string'?f:f.path);
  const allowed=p=>/^(bin\/linebridge\.mjs|client\/[a-z-]+\.mjs|server\/[a-z-]+\.mjs|protocol\/[a-z-]+\.mjs|protocol\/third-party-notices\.txt|public\/.+|examples\/[a-z-]+\.mjs|package\.json|openapi\.json|README(?:\.(?:zh-TW|en|ja))?\.md|PACKAGING\.md|CONNECTIONS\.md|ALIASES\.md|SEARCH\.md|CLI\.md)$/.test(p);
  for(const p of paths)if(!allowed(p)||p.includes('..')||/\.(sqlite(?:-wal|-shm)?|dpapi|bin|exe|dmg|rs|tgz)$/.test(p))throw new Error(`Refusing to package unexpected file: ${p}`);
  for(const required of ['bin/linebridge.mjs','client/cli.mjs','client/credentials.mjs','client/request.mjs','client/errors.mjs','CLI.md','server/main.mjs','server/store.mjs','protocol/worker.mjs','public/index.html','package.json'])if(!paths.includes(required))throw new Error(`Missing package file: ${required}`);
  return paths;
}
export async function buildPackage(){
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),out=join(root,'release','npm');await mkdir(out,{recursive:true});
  const preview=JSON.parse(npm(['pack','--dry-run','--json','--ignore-scripts'],{cwd:root}))[0];validateArchive(preview.files);
  const packed=JSON.parse(npm(['pack','--json','--ignore-scripts','--pack-destination',out],{cwd:root}))[0];validateArchive(packed.files);
  const sha256=createHash('sha256').update(await readFile(join(out,packed.filename))).digest('hex');
  await writeFile(join(out,'SHA256SUMS.txt'),`${sha256}  ${packed.filename}\n`);
  await writeFile(join(out,'package-info.json'),JSON.stringify({name:packed.name,version:packed.version,filename:packed.filename,sha256,integrity:packed.integrity,files:packed.files.length,packedBytes:packed.size,node:'>=24.0.0',distribution:'headless npm',registryPublished:false},null,2)+'\n');
  console.log(join(out,packed.filename));return packed;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await buildPackage();
