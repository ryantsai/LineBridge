import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
export const root=fileURLToPath(new URL('../',import.meta.url));
export const runtimes=JSON.parse(await readFile(new URL('../packaging/runtimes.json',import.meta.url),'utf8'));
export function buildPlan(platform=process.platform,arch=process.arch,requested){
  const name=platform==='darwin'?'macos':platform==='win32'?'windows':platform;
  if(requested && name!==requested)throw new Error(`${requested==='macos'?'A Mac':'Windows'} is required to build this installer; this host is ${name}.`);
  const runtime=runtimes.platforms[`${platform}-${arch}`];
  if(!runtime)throw new Error(`Unsupported installer host: ${platform}-${arch}. Use Windows x64 or a native Apple Silicon/Intel Mac.`);
  return {...runtime,platform,arch,name,slug:`${name}-${arch}`,bundle:platform==='win32'?'nsis':'dmg',nodeName:platform==='win32'?'node.exe':'node',connectorName:platform==='win32'?'cloudflared.exe':'cloudflared'};
}
export function sha256(bytes){return createHash('sha256').update(bytes).digest('hex');}
export function verifyChecksum(bytes,expected,name){
  if(!/^[a-f0-9]{64}$/.test(expected) || sha256(bytes)!==expected)throw new Error(`SHA-256 verification failed for ${name}; refusing to package it.`);
}
export function verifyExecutable(bytes,plan){
  if(plan.platform==='win32'){
    if(bytes.length<64 || bytes.toString('ascii',0,2)!=='MZ')throw new Error('Expected a Windows PE executable.');
    const offset=bytes.readUInt32LE(0x3c);
    if(offset+6>bytes.length || bytes.toString('ascii',offset,offset+4)!=='PE\0\0' || bytes.readUInt16LE(offset+4)!==0x8664)throw new Error('Expected a Windows x64 executable.');
  }else if(plan.platform==='linux'){
    const machine=plan.arch==='arm64'?183:62;
    if(bytes.length<64 || bytes.toString('hex',0,4)!=='7f454c46' || bytes[4]!==2 || bytes[5]!==1 || bytes.readUInt16LE(18)!==machine)throw new Error(`Expected a Linux ${plan.arch} ELF executable.`);
  }else{
    const cpu=plan.arch==='arm64'?0x0100000c:0x01000007;
    if(bytes.length<8 || bytes.readUInt32LE(0)!==0xfeedfacf || bytes.readUInt32LE(4)!==cpu)throw new Error(`Expected a macOS ${plan.arch} Mach-O executable.`);
  }
}
