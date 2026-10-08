import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {createServer} from 'node:http';
import {McpGateway,mcpOptions,verifyMcp,runMcp,READ_TOOLS,SEND_TOOLS} from '../client/mcp.mjs';
import {mcpHandler} from '../server/mcp.mjs';

const secret='synthetic-protected-token',cfSecret='synthetic-access-secret';
const options=mcpOptions({profile:'selected',url:'http://127.0.0.1:3211','client-config':'/tmp/linebridge-synthetic-profiles'},{});
function mock({mode='read',fetchImpl}={}) {
  const calls=[],reads=[];
  const store={get:async name=>{reads.push(name);return {url:options.url,token:secret,cfAccessClientId:'synthetic-access-id',cfAccessClientSecret:cfSecret};}};
  const send=async(url,init)=>{
    const rpc=JSON.parse(init.body);calls.push({url,init,rpc});
    assert.equal(url,options.url+'/mcp');assert.equal(init.redirect,'error');assert.equal(init.headers.Authorization,'Bearer '+secret);assert.equal(init.headers['CF-Access-Client-Secret'],cfSecret);
    if(fetchImpl)return fetchImpl(url,init,rpc);
    const result=rpc.method==='initialize' ? {protocolVersion:rpc.params.protocolVersion,serverInfo:{name:'LineBridge',version:'0.7.13'},capabilities:{tools:{}}} : rpc.method==='tools/list' ? {tools:[...READ_TOOLS,...SEND_TOOLS,'future_unreviewed_tool'].map(name=>({name,inputSchema:{type:'object'}}))} : {content:[{type:'text',text:JSON.stringify({service:'LineBridge',version:'0.7.13'})}]};
    return rpc.id===undefined ? new Response(null,{status:202}) : Response.json({jsonrpc:'2.0',id:rpc.id,result});
  };
  return {calls,reads,store,fetchImpl:send,gateway:new McpGateway({...options,mode},{store,fetchImpl:send})};
}
test('verification reuses the exact protected profile and only initializes, discovers tools and checks version',async()=>{
  const f=mock();const result=await verifyMcp(options,{store:f.store,fetchImpl:f.fetchImpl,env:{LINE_BRIDGE_TOKEN:'ignored'}});
  assert.deepEqual(f.reads,['selected']);assert.deepEqual(f.calls.map(c=>c.rpc.method),['initialize','notifications/initialized','tools/list','tools/call']);
  assert.equal(f.calls[3].rpc.params.name,'line_get_version');assert.deepEqual(result.tools,READ_TOOLS);assert.equal(result.lineDataRead,false);
  assert.ok(!JSON.stringify(result).includes(secret));assert.ok(!JSON.stringify(result).includes(cfSecret));assert.ok(f.calls[1].init.headers['MCP-Protocol-Version']);
});
test('profile origin mismatch and missing/locked credentials never dispatch or fall back to environment',async()=>{
  let requests=0;
  for(const get of [async()=>({url:'https://other.example',token:secret}),async()=>{throw new Error(secret);}]){
    await assert.rejects(verifyMcp(options,{store:{get},fetchImpl:()=>{requests++;},env:{LINE_BRIDGE_TOKEN:'fallback-not-allowed'}}),e=>!e.message.includes(secret));
  }
  assert.equal(requests,0);
});
test('read mode blocks direct send calls; read-send still hides unreviewed tools',async()=>{
  const f=mock();await f.gateway.connect();const catalog=await f.gateway.listTools();assert.deepEqual(catalog.tools.map(t=>t.name),READ_TOOLS);
  const before=f.calls.length;await assert.rejects(f.gateway.callTool({name:'line_send_message',arguments:{}}),{code:'tool_not_enabled'});assert.equal(f.calls.length,before);f.gateway.close();
  const sending=mock({mode:'read-send'});await sending.gateway.connect();assert.deepEqual((await sending.gateway.listTools()).tools.map(t=>t.name),[...READ_TOOLS,...SEND_TOOLS]);sending.gateway.close();
});
test('sends dispatch once on transport, auth, invalid JSON and malformed acknowledgment failures; no response leaks',async()=>{
  for(const response of [()=>{throw new Error(secret);},()=>new Response(secret,{status:401}),()=>new Response(secret,{status:403}),()=>new Response(secret,{status:503}),()=>new Response('bad-json',{headers:{'Content-Type':'application/json'}}),rpc=>Response.json({jsonrpc:'2.0',id:rpc.id,result:{content:[{type:'text',text:'{}'}]}})]){
    let count=0;const gateway=new McpGateway({...options,mode:'read-send'},{fetchImpl:async(url,init)=>{count++;return response(JSON.parse(init.body));}});gateway.headers={Authorization:'Bearer '+secret};
    await assert.rejects(gateway.callTool({name:'line_send_message',arguments:{accountId:'synthetic-a',chatId:'synthetic-c',text:'synthetic',idempotencyKey:'fixture-key'}}),e=>e.code==='delivery_unknown' && !e.message.includes(secret));
    assert.equal(count,1);gateway.close();
  }
});
test('upstream errors/unknown outcomes remain errors; valid send acknowledgment is passed unchanged',async()=>{
  for(const result of [{isError:true,content:[{type:'text',text:'{"error":"delivery_unknown"}'}]},{isError:true,content:[{type:'text',text:'{"error":"scope_denied"}'}]},{content:[{type:'text',text:'{"messageId":"synthetic-id","delivery":"sandbox_only"}'}]}]){
    let count=0;const gateway=new McpGateway({...options,mode:'read-send'},{fetchImpl:async(url,init)=>{count++;return Response.json({jsonrpc:'2.0',id:JSON.parse(init.body).id,result});}});
    assert.deepEqual(await gateway.callTool({name:'line_send_message',arguments:{}}),result);assert.equal(count,1);gateway.close();
  }
});
test('real HTTP refuses even same-origin redirects and bounds stalled/oversized responses',async t=>{
  let redirected=0;
  const server=createServer((req,res)=>{
    if(req.url==='/target'){redirected++;res.end('{}');}
    else if(server.mode==='redirect'){res.writeHead(307,{Location:'/target'});res.end();}
    else if(server.mode==='oversized'){res.writeHead(200,{'Content-Type':'application/json'});res.end('x'.repeat(4*1024*1024+1));}
    else {res.writeHead(200,{'Content-Type':'application/json'});res.write('{');}
  });await new Promise(ok=>server.listen(0,'127.0.0.1',ok));t.after(()=>{server.closeAllConnections();server.close();});
  for(const mode of ['redirect','oversized','stalled']){
    server.mode=mode;const gateway=new McpGateway({...options,url:`http://127.0.0.1:${server.address().port}`,timeoutMs:100});
    await assert.rejects(gateway.rpc('tools/list',{}),{code:'mcp_unavailable'});gateway.close();
  }
  assert.equal(redirected,0);
});
test('stdio adapter speaks MCP only, filters calls and shuts down on EOF against the real gateway protocol',async t=>{
  const calls=[];
  const hub=new Proxy({}, {get:(_,method)=>async(...args)=>{calls.push(method);if(method==='read')return {messages:[{text:'synthetic text'}],untrustedContent:true};throw new Error('Unexpected synthetic hub operation');}});
  const server=createServer(async(req,res)=>{
    assert.equal(req.headers.authorization,'Bearer '+secret);
    const parts=[];for await(const part of req)parts.push(part);req.body=JSON.parse(Buffer.concat(parts));req.actor={synthetic:true};res.set=(key,value)=>res.setHeader(key,value);
    await mcpHandler(hub,req,res);
  });await new Promise(ok=>server.listen(0,'127.0.0.1',ok));t.after(()=>{server.closeAllConnections();server.close();});
  const url=`http://127.0.0.1:${server.address().port}`,stdin=new PassThrough(),stdout=new PassThrough();let stderr='',raw='';stdout.on('data',b=>{raw+=b;});
  const pending=new Map();let buffer='';stdout.on('data',b=>{buffer+=b;for(;;){const at=buffer.indexOf('\n');if(at<0)break;const message=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);pending.get(message.id)?.(message);pending.delete(message.id);}});
  const request=message=>new Promise(ok=>{pending.set(message.id,ok);stdin.write(JSON.stringify({jsonrpc:'2.0',...message})+'\n');});
  const code=await runMcp(['--profile','selected','--url',url],{stdin,stdout,stderr:{write:s=>{stderr+=s;}},store:{get:async()=>({url,token:secret})}});assert.equal(code,0,stderr);
  const init=await request({id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'synthetic-host',version:'1'}}});assert.match(init.result.instructions,/explicit user approval/);
  stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  const tools=await request({id:2,method:'tools/list',params:{}});assert.deepEqual(tools.result.tools.map(t=>t.name),READ_TOOLS);
  const denied=await request({id:3,method:'tools/call',params:{name:'line_send_message',arguments:{}}});assert.equal(denied.result.isError,true);assert.deepEqual(calls,[]);
  const read=await request({id:4,method:'tools/call',params:{name:'line_read_messages',arguments:{accountId:'a',chatId:'c'}}});assert.equal(read.result.isError,undefined);assert.deepEqual(calls,['read']);
  stdin.end();await new Promise(ok=>setImmediate(ok));assert.ok(!raw.includes(secret));assert.equal(stderr,'');
});
test('adapter usage failures never write non-protocol stdout or echo secret inputs',async()=>{
  for(const args of [['--token','secret-do-not-print'],['--profile','p'],['--profile','p','--profile','q','--url',options.url]]){
    let stdout='',stderr='';const code=await runMcp(args,{stdout:{write:s=>{stdout+=s;}},stderr:{write:s=>{stderr+=s;}},store:{get:()=>assert.fail()}});
    assert.equal(code,2);assert.equal(stdout,'');assert.ok(!stderr.includes('secret-do-not-print'));
  }
});
