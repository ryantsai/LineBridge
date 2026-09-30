import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {once} from 'node:events';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const root=process.cwd(),data=mkdtempSync(join(tmpdir(),'linebridge-test-'));
const admin='http://127.0.0.1:4510',gateway='http://127.0.0.1:4511';
const service=spawn(join(root,'target/release/line-bridge-service.exe'),[],{cwd:root,env:{...process.env,LINE_BRIDGE_ROOT:root,LINE_BRIDGE_DATA:data,LINE_BRIDGE_ADMIN_PORT:'4510',LINE_BRIDGE_GATEWAY_PORT:'4511'},stdio:'ignore',windowsHide:true});
let client;
try{
  for(let i=0;i<100;i++){try{if((await fetch(`${gateway}/health`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  const page=await fetch(admin),cookie=page.headers.get('set-cookie').split(';')[0];assert.equal(page.status,200);assert.match(await page.text(),/LineBridge/);
  const call=async(path,method='GET',value)=>{const response=await fetch(`${admin}/admin${path}`,{method,headers:{Cookie:cookie,Origin:admin,'X-Line-Bridge':'dashboard','Content-Type':'application/json'},...(value?{body:JSON.stringify(value)}:{})});const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return data;};
  const account=await call('/accounts','POST',{label:'migration test',kind:'demo'}),id=account.id;
  await call(`/accounts/${id}/chats/demo-group`,'PATCH',{enabled:true});await call(`/accounts/${id}/monitor`,'POST',{enabled:true});
  const token=await call('/tokens','POST',{name:'test agent',days:1,grants:[{accountId:id,read:true,send:true}]});
  client=new Client({name:'LineBridge integration check',version:'1.0'});
  await client.connect(new StreamableHTTPClientTransport(new URL(`${gateway}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${token.token}`}}}));
  const tools=await client.listTools();assert.equal(tools.tools.length,5);
  const result=await client.callTool({name:'line_list_chats',arguments:{accountId:id}});assert.equal(result.isError,false);const chats=JSON.parse(result.content[0].text);assert.equal(chats.length,1);assert.equal(chats[0].id,'demo-group');
  const sent=await client.callTool({name:'line_send_message',arguments:{accountId:id,chatId:'demo-group',text:'synthetic-integration-message',idempotencyKey:'integration-0001'}});assert.equal(sent.isError,false);
  const events=await client.callTool({name:'line_poll_events',arguments:{accountId:id,after:0}});assert.equal(events.isError,false);const inbox=JSON.parse(events.content[0].text);assert.equal(inbox.events.length,1);assert.equal(inbox.events[0].message.text,'synthetic-integration-message');
  const denied=await client.callTool({name:'line_read_messages',arguments:{accountId:id,chatId:'demo-openchat'}});assert.equal(denied.isError,true);assert.equal(JSON.parse(denied.content[0].text).error,'chat_not_designated');
  const duplicate=await client.callTool({name:'line_send_message',arguments:{accountId:id,chatId:'demo-group',text:'synthetic-integration-message',idempotencyKey:'integration-0001'}});assert.equal(JSON.parse(duplicate.content[0].text).replayed,true);
  await call(`/tokens/${token.id}`,'DELETE');let revoked=false;try{await client.callTool({name:'line_list_accounts',arguments:{}});}catch{revoked=true;}assert.equal(revoked,true);
  assert.equal(readFileSync(join(data,'bridge.sqlite-wal')).includes(Buffer.from('synthetic-integration-message')),false);
  console.log('Rust HTTP + official MCP client: scopes, encrypted inbox, send replay and revocation passed. All sends were synthetic.');
}finally{
  await client?.close().catch(()=>{});service.kill();if(service.exitCode===null)await once(service,'exit');
  const target=resolve(data),parent=resolve(tmpdir())+sep;if(!target.startsWith(parent)||!target.slice(parent.length).startsWith('linebridge-test-'))throw new Error('Refusing unsafe test cleanup');rmSync(target,{recursive:true,force:true});
}
