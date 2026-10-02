// Private stdio entry point, owned by the native desktop process.
import {parseArgs} from 'node:util';
import {createInterface} from 'node:readline';
import {startService} from './main.mjs';

let service,stopping=false;
async function stop(){if(stopping)return;stopping=true;await service?.shutdown();process.stdin.destroy();}
try{
  const {values}=parseArgs({options:{'data-dir':{type:'string'}}});
  // Always authenticate the gateway in the desktop product.
  service=await startService({...(values['data-dir']?{dataDir:values['data-dir']}:{ }),requireToken:true});
  const input=createInterface({input:process.stdin});
  input.on('line',line=>{if(line==='shutdown')void stop();});
  input.on('close',()=>{void stop();});
  // No credentials are sent over this readiness channel.
  console.log(JSON.stringify({ready:true,url:`http://127.0.0.1:${service.adminPort}/`,instance:service.instance}));
}catch(error){
  console.log(JSON.stringify({ready:false,error:error.code??'startup_failed',message:error.status?error.message:'LineBridge could not start. Check the local ports and data directory.'}));
  await stop();process.exitCode=1;
}
