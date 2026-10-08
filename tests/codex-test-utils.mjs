import {rename} from 'node:fs/promises';

// This deliberately models only metadata boundaries on disposable synthetic
// files. It is not a platform implementation and is never shipped in the CLI.
export const syntheticCodexFiles={
  inspect:async()=>({kind:'synthetic',signature:'synthetic-fixture-metadata'}),
  prepare:async()=>{},
  replace:rename
};

// The bundle smoke exercises real Linux files/processes. Only the macOS policy
// and metadata command boundary are modeled; no native ACL claim is made.
export const modeledCodexPreload=`
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
Object.defineProperty(process,'platform',{value:'darwin'});
const spawn=childProcess.spawn;
childProcess.spawn=(file,args,options)=>{
  if(file==='/bin/ls'&&args[0]==='-lde@')return spawn('/bin/ls',['-ld',args[1]],options);
  if(file==='/usr/bin/stat'&&args[0]==='-f'&&args[1]==='%f')return spawn(process.execPath,['-e','console.log(0)'],options);
  if(file==='/bin/chmod'&&args[0]==='-N')return spawn(process.execPath,['-e','process.exit(0)'],options);
  return spawn(file,args,options);
};
syncBuiltinESMExports();
`;
