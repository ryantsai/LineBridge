import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';

export function defaultDataDirectory({env=process.env,platform=process.platform}={}){
  if(!['win32','darwin'].includes(platform))throw new Error('LineBridge supports Windows and macOS only.');
  if(env.LINE_BRIDGE_DATA)return resolve(env.LINE_BRIDGE_DATA);
  const base=platform==='win32'?env.LOCALAPPDATA??join(homedir(),'AppData','Local'):join(homedir(),'Library','Application Support');
  const current=join(base,platform==='win32'?'LineBridgeData':'LineBridge');
  // Reuse legacy vaults in place; discovery and startup must resolve identically.
  if(existsSync(join(current,'bridge.sqlite')))return current;
  for(const legacy of [join(base,'LineBridge'),join(base,'com.ryantsai.linebridge')])if(existsSync(join(legacy,'bridge.sqlite')))return legacy;
  return current;
}
export const validPort=p=>Number.isInteger(p)&&p>1024&&p<65536;
export async function metadata(data){try{return JSON.parse(await readFile(join(data,'service.json'),'utf8'));}catch{return null;}}
