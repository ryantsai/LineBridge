import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';

// Substitute only the spawn boundary. Production start() installs readline,
// error/exit/close listeners and pending-request handling on the returned child.
export function startWithChild(t,worker,createChild){
  const mock=t.mock.method(childProcess,'spawn',createChild);syncBuiltinESMExports();
  try{worker.start();return worker.child;}
  finally{mock.mock.restore();syncBuiltinESMExports();}
}
export function startSource(t,worker,source){
  const spawn=childProcess.spawn;
  return startWithChild(t,worker,(file,_args,options)=>spawn(file,['--input-type=module','-e',source],options));
}
