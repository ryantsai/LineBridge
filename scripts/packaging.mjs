import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
export const root=fileURLToPath(new URL('../',import.meta.url));
export function sha256(bytes){return createHash('sha256').update(bytes).digest('hex');}
export function verifyChecksum(bytes,expected,name){
  if(!/^[a-f0-9]{64}$/.test(expected) || sha256(bytes)!==expected)throw new Error(`SHA-256 verification failed for ${name}; refusing to package it.`);
}
export function verifyExecutable(bytes,plan){
  if(plan.platform==='win32'){
    if(bytes.length<64 || bytes.toString('ascii',0,2)!=='MZ')throw new Error('Expected a Windows PE executable.');
    const offset=bytes.readUInt32LE(0x3c);
    if(offset+6>bytes.length || bytes.toString('ascii',offset,offset+4)!=='PE\0\0' || bytes.readUInt16LE(offset+4)!==0x8664)throw new Error('Expected a Windows x64 executable.');
  }else if(plan.platform==='darwin'){
    const cpu=plan.arch==='arm64'?0x0100000c:0x01000007;
    if(bytes.length<8 || bytes.readUInt32LE(0)!==0xfeedfacf || bytes.readUInt32LE(4)!==cpu)throw new Error(`Expected a macOS ${plan.arch} Mach-O executable.`);
  }else throw new Error('Unsupported executable platform. Use Windows or macOS.');
}
