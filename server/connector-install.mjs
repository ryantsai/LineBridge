import {mkdir,writeFile,readFile,rename,unlink,rmdir,chmod} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fail} from './errors.mjs';
const exec=promisify(execFile);
export const NGROK_VERSION='3.39.11';
const ngrok={
  'win32-x64':['windows-amd64.zip','699bbf1932ec43a573b764bd03e6568efa2c4e45955eb3cc2089c19bb4be4464'],
  'darwin-x64':['darwin-amd64.tgz','098a72a436276227f71ea6a57f3560d47e15135b4c5c6ba605cd63edba386987'],
  'darwin-arm64':['darwin-arm64.tgz','cdf75135a6a7962dd368c0d4ec1bad2312420d933a41296a146fffcc6be13ee8'],
};
export function connectorPlan(provider,platform=process.platform,arch=process.arch){
  if(provider!=='ngrok'||!ngrok[`${platform}-${arch}`])fail(409,'connector_install_unsupported','Install a supported native connector on this platform.');
  const [asset,sha256]=ngrok[`${platform}-${arch}`];return {url:`https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-${asset}`,sha256,version:NGROK_VERSION,binary:platform==='win32'?'ngrok.exe':'ngrok'};
}
export function verifiedDownload(bytes,expected){if(createHash('sha256').update(bytes).digest('hex')!==expected)fail(502,'connector_checksum_failed','The official connector download changed. Update LineBridge before installing it.');}
export async function installNgrok(data){
  const plan=connectorPlan('ngrok'),tools=join(resolve(data),'tools'),stage=join(tools,`install-${randomUUID()}`);await mkdir(stage,{recursive:true,mode:0o700});
  const archive=join(stage,'download'),entry=join(stage,plan.binary),target=join(tools,plan.binary);
  try{
    const response=await fetch(plan.url,{signal:AbortSignal.timeout(120000)});if(!response.ok)fail(502,'connector_download_failed','The official connector download failed.');
    const bytes=Buffer.from(await response.arrayBuffer());verifiedDownload(bytes,plan.sha256);await writeFile(archive,bytes,{mode:0o600});
    const {stdout}=await exec('tar',['-tf',archive],{windowsHide:true,timeout:10000});const selected=stdout.split(/\r?\n/).find(name=>name===plan.binary||name===`./${plan.binary}`);if(!selected)fail(502,'connector_download_failed','The archive has no expected connector executable.');
    await exec('tar',['-xf',archive,'-C',stage,selected],{windowsHide:true,timeout:15000});await chmod(entry,0o755);
    const {stdout:version}=await exec(entry,['version'],{windowsHide:true,timeout:5000});if(version.trim()!==`ngrok version ${plan.version}`)fail(502,'connector_checksum_failed','Unexpected connector version.');
    const binaryHash=createHash('sha256').update(await readFile(entry)).digest('hex');await rename(entry,target);
    await writeFile(join(tools,'ngrok-source.json'),JSON.stringify({...plan,binarySha256:binaryHash,checksumVerified:true},null,2)+'\n',{mode:0o600});return target;
  }finally{await unlink(archive).catch(()=>{});await unlink(entry).catch(()=>{});await rmdir(stage).catch(()=>{});}
}
