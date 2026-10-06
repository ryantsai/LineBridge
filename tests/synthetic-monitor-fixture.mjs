import {resolve,join,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../server/store.mjs';

// Legacy token-free/remote smoke fixtures do not enroll an OS profile. Seed only
// their synthetic demo selection; production requires confirmed managed setup.
export function seedSyntheticMonitor(data,id){
  const target=resolve(data),prefix=resolve(tmpdir())+sep;
  if(!target.startsWith(prefix)||!target.slice(prefix.length).startsWith('linebridge-'))throw Error('Not a disposable LineBridge fixture');
  const store=new Store(join(target,'bridge.sqlite'));
  try{if(store.account(id)?.kind!=='demo')throw Error('Not a synthetic account');store.transaction(()=>store.designate(id,'demo-group',true));}finally{store.close();}
}
