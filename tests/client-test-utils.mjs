import {rm} from 'node:fs/promises';
import {resolve, sep, basename} from 'node:path';
import {tmpdir} from 'node:os';

export function clientFixturePath(directory) {
  const path=resolve(directory),parent=resolve(tmpdir())+sep;
  if(!path.startsWith(parent) || !basename(path).startsWith('linebridge-'))throw new Error('Refusing unsafe client fixture cleanup.');
  return path;
}
export async function removeClientFixture(directory) {
  await rm(clientFixturePath(directory),{recursive:true,force:true});
}
