import { readFile } from 'node:fs/promises';

const base=(process.env.LINE_BRIDGE_URL ?? 'http://127.0.0.1:3211').replace(/\/$/,'');
if(!process.env.LINE_BRIDGE_TOKEN)throw new Error('Set LINE_BRIDGE_TOKEN in the process environment.');
const headers={Authorization:`Bearer ${process.env.LINE_BRIDGE_TOKEN}`};
if(process.env.CF_ACCESS_CLIENT_ID)headers['CF-Access-Client-Id']=process.env.CF_ACCESS_CLIENT_ID;
if(process.env.CF_ACCESS_CLIENT_SECRET)headers['CF-Access-Client-Secret']=process.env.CF_ACCESS_CLIENT_SECRET;
const [command='accounts',accountId,chatId,key,textPath]=process.argv.slice(2);
const account=encodeURIComponent(accountId ?? ''),chat=encodeURIComponent(chatId ?? '');
let path,options={headers};
if(command==='accounts')path='/api/v1/accounts';
else if(command==='chats'&&accountId)path=`/api/v1/accounts/${account}/chats`;
else if(command==='read'&&accountId&&chatId)path=`/api/v1/accounts/${account}/chats/${chat}/messages?limit=30`;
else if(command==='send'&&accountId&&chatId&&key&&textPath){
  path=`/api/v1/accounts/${account}/chats/${chat}/messages`;
  const text=await readFile(textPath,'utf8');
  options={method:'POST',headers:{...headers,'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify({text})};
}else throw new Error('Usage: accounts | chats ACCOUNT_ID | read ACCOUNT_ID CHAT_ID | send ACCOUNT_ID CHAT_ID KEY TEXT_FILE');
// One request only. A send timeout must be inspected before any new send.
const response=await fetch(`${base}${path}`,{...options,signal:AbortSignal.timeout(45000)});
const result=await response.json();
if(!response.ok){console.error(result.error,result.message);process.exitCode=1;}
else console.log(JSON.stringify(result,null,2));
