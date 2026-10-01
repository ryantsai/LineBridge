import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {findExecutable} from '../server/tunnels.mjs';
export function npm(args,options={}){
  const base=dirname(process.execPath),cli=[process.env.npm_execpath,join(base,'node_modules/npm/bin/npm-cli.js'),join(base,'../lib/node_modules/npm/bin/npm-cli.js'),'/usr/share/nodejs/npm/bin/npm-cli.js'].find(p=>p&&existsSync(p)&&p.endsWith('.js'));
  const executable=cli?process.execPath:findExecutable('npm')??'npm';
  return execFileSync(executable,cli?[cli,...args]:args,{encoding:'utf8',windowsHide:true,...options});
}
