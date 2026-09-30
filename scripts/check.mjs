import { readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
for(const dir of ['server','protocol','scripts','tests','public','examples']) {
  for(const name of await readdir(dir)) if(/\.(mjs|js)$/.test(name))execFileSync(process.execPath,['--check',`${dir}/${name}`],{stdio:'inherit'});
}
console.log('JavaScript syntax checks passed.');
