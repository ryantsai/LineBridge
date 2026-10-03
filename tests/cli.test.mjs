import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {runCli, boundedText} from '../client/cli.mjs';
import {gatewayRequest} from '../client/request.mjs';
import {removeClientFixture} from './client-test-utils.mjs';

const token='synthetic-token-only';
async function cli(args,{input='',env={},fetchImpl=async()=>new Response('{}'),store}={}) {
  let stdout='',stderr='';
  const code=await runCli(args,{env:{LINE_BRIDGE_TOKEN:token,...env},stdin:Readable.from([Buffer.from(input)]),stdout:{write:s=>{stdout+=s;}},stderr:{write:s=>{stderr+=s;}},fetchImpl,store});
  return {code,stdout,stderr,json:JSON.parse(stdout)};
}
test('data help stays parseable and malformed options never echo input or touch credentials/network',async()=>{
  const help=await cli(['read','--help']);assert.equal(help.code,0);assert.ok(help.json.commands.includes('send'));assert.match(help.stderr,/--cursor/);
  for(const args of [
    ['read'], ['chats','--account',''], ['events','--account','a','--after','9007199254740992'],
    ['read','--account','a','--chat','c','--limit','101'],['read','--account','a','--chat','c','--limit','1.5'],
    ['accounts','--timeout-ms','0'],['search','--query','q','--chat','c'],['search','--query','q','--mode','regex'],
    ['send','--account','a','--chat','c','--text','t'],['send','--account','a','--chat','c','--key','synthetic-key','--text','t','--stdin'],
    ['accounts','--url','https://user:secret@example.test'],['accounts','--url','http://example.test'],
    ['accounts','--url','https://example.test/api'],['accounts','--url','https://example.test/?token=secret'],
    ['accounts','--profile','../secret'],['accounts','--profile','one','--profile','two'],
    ['accounts','--token','do-not-echo-secret'],['send','unexpected-do-not-echo-secret'],
    ['accounts','--profile','work','--credential-stdin'],
    ['send','--account','a','--chat','c','--key','synthetic-key','--stdin','--credential-stdin']
  ]){
    const result=await cli(args,{fetchImpl:()=>assert.fail('Invalid input must not make a request'),store:{get:()=>assert.fail('Invalid input must not access the keystore')}});
    assert.equal(result.code,2,JSON.stringify(args));assert.equal(result.json.error,'invalid_input');assert.ok(!result.stdout.includes('do-not-echo-secret'));assert.ok(!result.stderr.includes('do-not-echo-secret'));
  }
});
test('routes preserve bounded pages, opaque cursors, Unicode queries, and Access headers',async()=>{
  const calls=[];
  const fetchImpl=async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify({cursor:'cursor-with+&?',untrustedContent:true}));};
  const env={LINE_BRIDGE_URL:'https://gateway.example/',CF_ACCESS_CLIENT_ID:'synthetic-id',CF_ACCESS_CLIENT_SECRET:'synthetic-access-secret'};
  for(const args of [
    ['accounts'],['chats','--account','a /?'],['read','--account','a','--chat','c /?','--limit','7','--cursor','雪 +&?'],
    ['events','--account','a','--after','123','--limit','9'],
    ['search','--query','會議\n日本語 😀','--account','a','--chat','c','--mode','phrase','--before','99','--limit','3']
  ]){const result=await cli(args,{env,fetchImpl});assert.equal(result.code,0);assert.equal(result.json.cursor,'cursor-with+&?');assert.equal(result.stderr,'');}
  assert.equal(calls.length,5);
  assert.equal(new URL(calls[1].url).pathname,'/api/v1/accounts/a%20%2F%3F/chats');
  const read=new URL(calls[2].url);assert.equal(read.searchParams.get('cursor'),'雪 +&?');assert.equal(read.searchParams.get('limit'),'7');
  assert.equal(new URL(calls[3].url).searchParams.get('after'),'123');
  assert.deepEqual(JSON.parse(calls[4].options.body),{query:'會議\n日本語 😀',mode:'phrase',limit:3,accountId:'a',chatId:'c',before:99});
  for(const {options} of calls){assert.equal(options.headers.Authorization,`Bearer ${token}`);assert.equal(options.headers['CF-Access-Client-Secret'],'synthetic-access-secret');assert.equal(options.redirect,'error');assert.ok(options.signal);}
});
test('send file/stdin keep UTF-8 and multiline text exact; input failures happen before dispatch',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'linebridge-cli-text-'));t.after(()=>removeClientFixture(dir));
  const text='首行 😀\r\nArabic العربية\n末行\n',file=join(dir,'message with spaces.txt');await writeFile(file,text);
  const calls=[],fetchImpl=async(url,options)=>{calls.push(options);return new Response('{"replayed":false}');};
  const target=['send','--account','a','--chat','c','--key','unicode-key-001'];
  for(const args of [['--text-file',file],['--stdin'],['--text',text]]){const result=await cli([...target,...args],{input:text,fetchImpl});assert.equal(result.code,0);}
  for(const options of calls){assert.deepEqual(JSON.parse(options.body),{text});assert.equal(options.headers['Idempotency-Key'],'unicode-key-001');}
  for(const text of ['  \n','x'.repeat(5001)])assert.equal((await cli([...target,'--stdin'],{input:text,fetchImpl:()=>assert.fail()})).code,2);
  const missing=await cli([...target,'--text-file',join(dir,'missing-secret-name')],{fetchImpl:()=>assert.fail()});assert.equal(missing.code,2);assert.ok(!missing.stdout.includes('missing-secret-name'));
  await writeFile(file,Buffer.from([0xff]));assert.equal((await cli([...target,'--text-file',file],{fetchImpl:()=>assert.fail()})).json.error,'invalid_utf8');
  const query=await cli(['search','--query-stdin'],{input:'家族 😀',fetchImpl:async(url,options)=>{assert.equal(JSON.parse(options.body).query,'家族 😀');return new Response('{}');}});assert.equal(query.code,0);
});
test('bounded input rejects oversize, invalid UTF-8 and stalled streams',async()=>{
  await assert.rejects(boundedText(Readable.from([Buffer.from([0xff])])),{code:'invalid_utf8'});
  await assert.rejects(boundedText(Readable.from([Buffer.alloc(5)]),{maxBytes:4}),{code:'input_too_large'});
  const stalled=new Readable({read(){}});
  await assert.rejects(boundedText(stalled,{timeoutMs:25}),{code:'input_timeout'});stalled.destroy();
});
test('empty search pages retain continuation and oversized replies fail without retries',async()=>{
  let calls=0;
  const page={results:[],hasMore:true,nextBefore:234,scanned:500,untrustedContent:true};
  const result=await cli(['search','--query','synthetic'],{fetchImpl:async()=>{calls++;return new Response(JSON.stringify(page));}});
  assert.equal(result.code,0);assert.deepEqual(result.json,page);assert.equal(calls,1);
  const oversized=await cli(['accounts'],{fetchImpl:async()=>new Response('x'.repeat(4*1024*1024+1))});assert.equal(oversized.code,5);
});
test('enrollment/forget use private stdin and never create tokens or make gateway requests',async()=>{
  const calls=[],store={set:async(...args)=>{calls.push(args);return {profile:args[0],url:args[1],protection:'mock OS keystore'};},forget:async profile=>({profile,forgotten:true})};
  const enrolled=await cli(['auth','enroll','--profile','work','--url','https://gateway.example','--token-stdin'],{input:`${token}\r\n`,store,fetchImpl:()=>assert.fail()});
  assert.equal(enrolled.code,0);assert.deepEqual(calls[0],['work','https://gateway.example',{token}]);assert.ok(!enrolled.stdout.includes(token));
  const forgot=await cli(['auth','forget','--profile','work'],{store,fetchImpl:()=>assert.fail()});assert.equal(forgot.json.forgotten,true);
  const bad=await cli(['auth','enroll','--credential-stdin'],{input:'{"token":"secret-do-not-print","extra":true}',store});assert.equal(bad.code,2);assert.ok(!bad.stdout.includes('secret-do-not-print'));
  const transient=await cli(['accounts','--credential-stdin'],{input:JSON.stringify({token}),store:{get:()=>assert.fail()},fetchImpl:async(url,options)=>{assert.equal(options.headers.Authorization,`Bearer ${token}`);return new Response('[]');}});assert.equal(transient.code,0);
});
test('explicit profiles win over environment and bind stored secrets to their enrolled gateway',async()=>{
  let requests=0,reads=0;
  const store={get:async profile=>{reads++;assert.equal(profile,'work');return {url:'https://enrolled.example',token};}};
  const fetchImpl=async(url)=>{requests++;assert.ok(url.startsWith('https://enrolled.example/'));return new Response('[]');};
  assert.equal((await cli(['accounts','--profile','work'],{store,fetchImpl})).code,0);
  assert.equal((await cli(['accounts','--profile','work','--url','https://other.example'],{store,fetchImpl})).code,2);
  assert.equal(requests,1);assert.equal(reads,2);
});
test('remote errors have stable exits and never echo raw gateway errors, credentials or text',async()=>{
  for(const [status,error,expected] of [[401,'unauthorized',4],[403,'scope_denied',4],[409,'idempotency_conflict',6],[429,'rate_limited',7],[503,'gateway_paused',7],[502,'delivery_unknown',8],[418,token,6]]) {
    const result=await cli(['accounts'],{fetchImpl:async()=>new Response(JSON.stringify({error,message:`${token} private-message`}),{status})});
    assert.equal(result.code,expected);assert.equal(result.json.status,status);assert.ok(!result.stdout.includes(token));assert.ok(!result.stderr.includes('private-message'));
  }
  const crashed=await cli(['accounts'],{fetchImpl:()=>{throw new Error(`${token}:private-url`);}});assert.equal(crashed.code,5);assert.ok(!crashed.stdout.includes(token));
});
test('sends never retry network failures, malformed replies or delivery_unknown; reads classify transport separately',async()=>{
  for(const fail of [()=>{throw new Error('private-token');},()=>new Response('not-json'),()=>new Response('{"error":"delivery_unknown"}',{status:502}),()=>new Response('{"error":"gateway_error"}',{status:503})]){
    let calls=0;
    const result=await cli(['send','--account','a','--chat','c','--key','unknown-key','--text','secret message'],{fetchImpl:async(...args)=>{calls++;return fail(...args);}});
    assert.equal(result.code,8);assert.equal(result.json.error,'delivery_unknown');assert.equal(calls,1);assert.ok(!result.stdout.includes('secret message'));
  }
  const read=await cli(['accounts'],{fetchImpl:async()=>new Response('bad')});assert.equal(read.code,5);
});
test('real HTTP redirects and deadlines are bounded with no second send',async t=>{
  let sends=0,redirectTarget=0;
  const server=createServer((req,res)=>{
    if(req.url==='/redirect'){res.writeHead(302,{Location:'/target'});res.end();}
    else if(req.url==='/target'){redirectTarget++;res.end('{}');}
    else {if(req.method==='POST')sends++;res.writeHead(200,{'Content-Type':'application/json'});res.write('{');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
  const url=`http://127.0.0.1:${server.address().port}`,credentials={token};
  await assert.rejects(gatewayRequest({url,credentials,path:'/redirect',timeoutMs:1000}),{code:'transport_error'});assert.equal(redirectTarget,0);
  await assert.rejects(gatewayRequest({url,credentials,path:'/stalled',timeoutMs:50}),{code:'request_timeout'});
  let attempts=0;
  await assert.rejects(gatewayRequest({url,credentials,path:'/stalled',method:'POST',body:{text:'synthetic'},send:true,timeoutMs:50,fetchImpl:(...args)=>{attempts++;return fetch(...args);}}),{code:'delivery_unknown'});
  // Under CI load the deadline can expire before the loopback server receives
  // the request. Both pre-dispatch and post-dispatch timeouts remain unknown.
  assert.equal(attempts,1);assert.ok(sends<=1);
});
test('executable usage failures return JSON and stderr without a stack trace',async()=>{
  const result=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['bin/linebridge.mjs','send','--text','synthetic'],{windowsHide:true,env:{...process.env,LINE_BRIDGE_TOKEN:token},stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',b=>{stdout+=b;});child.stderr.on('data',b=>{stderr+=b;});child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));child.stdin.end();
  });
  assert.equal(result.code,2);assert.equal(JSON.parse(result.stdout).error,'invalid_input');assert.match(result.stderr,/--account/);assert.ok(!result.stderr.includes(' at '));
});
