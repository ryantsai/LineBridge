import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {createServer} from 'node:net';
import {Store} from '../server/store.mjs';
import {Vault} from '../server/vault.mjs';
import {Hub,localActor} from '../server/hub.mjs';
import {LineDriver,normalizeMessage} from '../server/drivers.mjs';
import {imageResult,boundedResponse,decryptAuthenticatedMedia,MEDIA_MAX_BYTES} from '../server/media.mjs';
import {InternalError} from '@evex/linejs/base';
import {validateFlex} from '../server/flex.mjs';
import {runCli} from '../client/cli.mjs';
import {createApps} from '../server/app.mjs';
import {Tunnels} from '../server/tunnels.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=','base64');
const payload=()=>({altText:'Synthetic test',acknowledgeTransportSecurity:true,contents:{type:'bubble',body:{type:'box',layout:'vertical',contents:[{type:'text',text:'Synthetic test'}]},footer:{type:'box',layout:'vertical',contents:[{type:'button',action:{type:'message',label:'Choose',text:'Synthetic choice'}}]}}});
async function fixture(t){
  const store=new Store(':memory:'),vault=new Vault(randomBytes(32),'test'),hub=new Hub(store,vault);
  t.after(()=>{hub.close();store.close();});
  const account=await hub.addAccount({label:'Synthetic',kind:'demo'});hub.designate(account.id,'demo-group',true);hub.designate(account.id,'demo-openchat',true);
  store.setSetting(`monitor:${account.id}`,true);
  hub.capture(account.id,'demo-group',normalizeMessage({id:'image-1',from:'synthetic',contentType:'IMAGE'}));
  hub.capture(account.id,'demo-group',{id:'legacy-1',text:'',contentType:'IMAGE'});
  return {hub,store,account,driver:hub.driver(account.id)};
}
test('normalization retains allowlisted descriptors, never URLs, tokens, chunks or arbitrary metadata',()=>{
  const message=normalizeMessage({id:'1',contentType:'STICKER',contentMetadata:{STKID:'123',STKPKGID:'4',STKVER:'100',STKTXT:'Custom',url:'https://evil.test',token:'secret'},chunks:['secret']});
  assert.deepEqual(message.media,{kind:'sticker',stickerId:'123',packageId:'4',version:'100',customText:'Custom'});
  assert.ok(!JSON.stringify(message).includes('secret'));assert.ok(!JSON.stringify(message).includes('evil'));
  assert.equal(normalizeMessage({contentType:'STICKER',contentMetadata:{STKID:'../secret'}}).media.stickerId,undefined);
  assert.deepEqual(normalizeMessage({contentType:1,chunks:['key']}).media,{kind:'image',encrypted:true});
});
test('image boundary checks byte/dimension/type limits and streamed errors',async()=>{
  assert.equal(imageResult(png).mimeType,'image/png');assert.equal(imageResult(png).width,1);
  assert.throws(()=>imageResult(Buffer.from('<svg onload="evil"/>')),{code:'media_unsupported'});
  assert.throws(()=>imageResult(Buffer.alloc(MEDIA_MAX_BYTES+1)),{code:'media_too_large'});
  const huge=Buffer.from(png);huge.writeUInt32BE(8193,16);assert.throws(()=>imageResult(huge),{code:'media_unsupported'});
  await assert.rejects(boundedResponse(new Response('expired',{status:404})),{code:'media_unavailable'});
  await assert.rejects(boundedResponse(new Response(png,{headers:{'Content-Length':String(MEDIA_MAX_BYTES+1)}})),{code:'media_too_large'});
  const stream=new ReadableStream({start(c){c.enqueue(new Uint8Array(MEDIA_MAX_BYTES));c.enqueue(new Uint8Array(1));c.close();}});
  await assert.rejects(boundedResponse(new Response(stream)),{code:'media_too_large'});
  await assert.rejects(boundedResponse(new Response(png),AbortSignal.abort()),{name:'AbortError'});
});
test('media binds account/chat/archive, checks read scope before download and revocation after it',async t=>{
  const {hub,account,driver}=await fixture(t);let calls=0;
  driver.media=async()=>{calls++;return imageResult(png);};
  const result=await hub.media(localActor,account.id,'demo-group','image-1');assert.equal(result.data,png.toString('base64'));assert.equal(calls,1);
  await assert.rejects(hub.media(localActor,account.id,'demo-openchat','image-1'),{code:'media_not_archived'});
  await assert.rejects(hub.media(localActor,account.id,'demo-group','legacy-1'),{code:'media_metadata_missing'});
  await assert.rejects(hub.media(localActor,account.id,'demo-group','../image-1'),{code:'invalid_message_id'});
  hub.setLocalAccess(account.id,{read:false,send:true});await assert.rejects(hub.media(localActor,account.id,'demo-group','image-1'),{code:'scope_denied'});assert.equal(calls,1);
  hub.setLocalAccess(account.id,{read:true,send:true});driver.media=async()=>{hub.setLocalAccess(account.id,{read:false,send:true});return imageResult(png);};
  await assert.rejects(hub.media(localActor,account.id,'demo-group','image-1'),{code:'scope_denied'});
});
test('Flex rejects malformed JSON, unknown metadata, excessive size and unsafe actions',()=>{
  assert.deepEqual(validateFlex(payload()),payload());
  for(const value of [{...payload(),acknowledgeTransportSecurity:false},{...payload(),extra:'x'},{...payload(),altText:' '},{...payload(),contents:{type:'bubble',body:{type:'box',layout:'vertical',contents:[{type:'button',action:{type:'uri',label:'X',uri:'javascript:alert(1)'}}]}}}])assert.throws(()=>validateFlex(value),{code:'invalid_flex'});
});
test('Flex uses send scope and existing idempotency/unknown-delivery state, blocks OpenChat before network',async t=>{
  const {hub,account,driver}=await fixture(t);let calls=0;driver.sendFlex=async()=>{calls++;return {messageId:'synthetic-1',protection:'line_transport'};};
  await assert.rejects(hub.sendFlex(localActor,account.id,'demo-openchat',payload(),'flex-key-001'),{code:'flex_transport_unsupported'});assert.equal(calls,0);
  hub.setLocalAccess(account.id,{read:true,send:false});await assert.rejects(hub.sendFlex(localActor,account.id,'demo-group',payload(),'flex-key-001'),{code:'scope_denied'});
  hub.setLocalAccess(account.id,{read:true,send:true});await hub.sendFlex(localActor,account.id,'demo-group',payload(),'flex-key-001');
  assert.equal((await hub.sendFlex(localActor,account.id,'demo-group',payload(),'flex-key-001')).replayed,true);assert.equal(calls,1);
  await assert.rejects(hub.sendFlex(localActor,account.id,'demo-group',{...payload(),altText:'Other'},'flex-key-001'),{code:'idempotency_conflict'});
  await assert.rejects(hub.send(localActor,account.id,'demo-group','text','flex-key-001'),{code:'idempotency_conflict'});
  driver.sendFlex=async()=>{calls++;throw new Error('private failure');};await assert.rejects(hub.sendFlex(localActor,account.id,'demo-group',payload(),'flex-key-002'),{code:'delivery_unknown'});
  await assert.rejects(hub.sendFlex(localActor,account.id,'demo-group',payload(),'flex-key-002'),{code:'delivery_unknown'});assert.equal(calls,2);
});
test('Talk Flex serializes the pinned SDK format without E2EE changes or fallbacks',async()=>{
  const driver=Object.create(LineDriver.prototype);let options;
  driver.client={talk:{sendMessage:async o=>{options=o;return {id:'synthetic'};}},e2ee:{encryptE2EEMessage:()=>assert.fail('Flex must not change text encryption')}};
  const result=await driver.sendFlex({id:'u-synthetic',kind:'direct'},payload());
  assert.equal(result.protection,'line_transport');assert.equal(options.contentType,'FLEX');assert.deepEqual(JSON.parse(options.contentMetadata.FLEXCONTAINER),payload().contents);
  await assert.rejects(driver.sendFlex({id:'m-synthetic',kind:'openchat'},payload()),{code:'flex_transport_unsupported'});
});
test('actual pinned Talk SDK does not automatically retry Flex on an E2EE error',async t=>{
  const driver=new LineDriver({device:'IOSIPAD'},{},{qr(){},pin(){},fault(){}});t.after(()=>driver.stop());let calls=0;
  driver.client.getReqseq=async()=>1;
  driver.client.request.request=async()=>{calls++;throw new InternalError('RequestError','synthetic rejection',{code:'E2EE_RETRY_ENCRYPT'});};
  await assert.rejects(driver.sendFlex({id:'u-synthetic',kind:'direct'},payload()),{code:'line_send_rejected'});assert.equal(calls,1);
});
test('SDK-produced encrypted media authenticates before decryption and rejects corrupted ciphertext/MAC',async t=>{
  const driver=new LineDriver({device:'IOSIPAD'},{},{qr(){},pin(){},fault(){}});t.after(()=>driver.stop());
  const e2ee=driver.client.e2ee,{keyMaterial,encryptedData}=await e2ee.encryptByKeyMaterial(png,Buffer.alloc(32,7));
  const decrypt=e2ee.___decryptAESCTR.bind(e2ee);let calls=0;e2ee.___decryptAESCTR=async(...args)=>{calls++;return decrypt(...args);};
  assert.deepEqual(await decryptAuthenticatedMedia(e2ee,encryptedData,keyMaterial),png);assert.equal(calls,1);
  for(const offset of [0,encryptedData.length-1]){const bad=Buffer.from(encryptedData);bad[offset]^=1;await assert.rejects(decryptAuthenticatedMedia(e2ee,bad,keyMaterial),{code:'media_integrity_failed'});}
  await assert.rejects(decryptAuthenticatedMedia(e2ee,Buffer.alloc(32),keyMaterial),{code:'media_integrity_failed'});
  await assert.rejects(decryptAuthenticatedMedia(e2ee,encryptedData,'invalid-key'),{code:'media_integrity_failed'});assert.equal(calls,1);
});
test('SDK OBS media path uses authenticated bounded requests without redirects and rejects custom stickers',async t=>{
  const driver=new LineDriver({device:'IOSIPAD'},{},{qr(){},pin(){},fault(){}});driver.client.authToken='synthetic-only';
  const original=globalThis.fetch;const calls=[];t.after(()=>{globalThis.fetch=original;driver.stop();});
  globalThis.fetch=async request=>{const req=new Request(request);calls.push(req);assert.equal(req.headers.get('x-line-access'),'synthetic-only');assert.equal(req.redirect,'error');assert.ok(req.signal);return req.url.endsWith('object_info.obs')?new Response('{"name":"../../unsafe"}'):new Response(png);};
  const result=await driver.media({id:'m-synthetic',kind:'openchat'},{id:'123',media:{kind:'image'}});
  assert.equal(result.sha256,imageResult(png).sha256);assert.equal(calls.length,2);assert.ok(calls[0].url.includes('/g2/m/123'));
  await assert.rejects(driver.media({kind:'openchat'},{id:'123',media:{kind:'sticker',stickerId:'1',customText:'Custom'}}),{code:'sticker_unsupported'});
  assert.equal(calls.length,2);
});
test('personal image re-fetches its scoped envelope and uses SDK E2EE with validated locator; never plaintext fallback',async t=>{
  const driver=new LineDriver({device:'IOSIPAD'},{},{qr(){},pin(){},fault(){}});driver.client.authToken='synthetic';
  const raw={id:'123',to:'u-synthetic',from:'u-other',contentType:'IMAGE',chunks:['synthetic-envelope'],contentMetadata:{OID:'object-123',SID:'emi'}};
  let envelope;driver.client.thrift.rename_thrift=(_,item)=>item;
  driver.client.request.request=async(fields,method)=>{assert.equal(fields[0][2],'u-synthetic');assert.equal(fields[1][2],100);assert.equal(method,'getRecentMessagesV2');return [raw];};
  driver.client.request.getHeader=()=>({'x-line-access':'synthetic'});
  const {keyMaterial,encryptedData}=await driver.client.e2ee.encryptByKeyMaterial(png,Buffer.alloc(32,9));
  driver.client.e2ee.decryptE2EEDataMessage=async message=>{envelope=message;return {keyMaterial,fileName:'../../unsafe.png'};};
  driver.client.e2ee.decryptByKeyMaterial=()=>assert.fail('Unauthenticated SDK decrypt helper must not be used');
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;driver.stop();});let calls=0;
  globalThis.fetch=async request=>{calls++;const req=new Request(request);assert.equal(req.url,'https://obs.line-apps.com/r/talk/emi/object-123');assert.equal(req.redirect,'error');return new Response(encryptedData);};
  const result=await driver.media({id:'u-synthetic',kind:'direct'},{id:'123',media:{kind:'image',encrypted:true}});
  assert.equal(result.mimeType,'image/png');assert.equal(envelope,raw);assert.equal(result.data,png.toString('base64'));assert.equal(calls,1);
  driver.client.e2ee.decryptE2EEDataMessage=async()=>{throw new Error('synthetic-decrypt-failure');};
  await assert.rejects(driver.media({id:'u-synthetic',kind:'direct'},{id:'123',media:{kind:'image'}}));assert.equal(calls,1);
  driver.client.e2ee.tryRegisterE2EEGroupKey=()=>assert.fail('Must not register group keys');
  driver.client.e2ee.decryptE2EEDataMessage=async function(){return this.tryRegisterE2EEGroupKey('c-synthetic');};
  await assert.rejects(driver.media({id:'u-synthetic',kind:'direct'},{id:'123',media:{kind:'image'}}),{code:'media_key_unavailable'});assert.equal(calls,1);
  raw.contentMetadata.OID='../secret';await assert.rejects(driver.media({id:'u-synthetic',kind:'direct'},{id:'123',media:{kind:'image'}}),{code:'media_unsupported'});assert.equal(calls,1);
  driver.client.request.request=async()=>[];await assert.rejects(driver.media({id:'u-synthetic',kind:'direct'},{id:'123',media:{kind:'image'}}),{code:'media_history_unavailable'});
});
test('sticker preview uses only fixed credential-free CDN URL with redirects disabled',async t=>{
  const driver=new LineDriver({device:'IOSIPAD'},{},{qr(){},pin(){},fault(){}});const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;driver.stop();});let calls=0;
  globalThis.fetch=async(url,options)=>{calls++;assert.equal(url,'https://stickershop.line-scdn.net/stickershop/v1/sticker/123/android/sticker.png');assert.equal(options.redirect,'error');assert.equal(options.headers,undefined);return new Response(png);};
  const result=await driver.media({kind:'openchat'},{id:'1',media:{kind:'sticker',stickerId:'123'}});assert.equal(result.preview,true);
  await assert.rejects(driver.media({kind:'openchat'},{id:'1',media:{kind:'sticker',stickerId:'../evil'}}),{code:'sticker_unsupported'});assert.equal(calls,1);
});
async function cli(args,fetchImpl){let stdout='';const code=await runCli(args,{env:{LINE_BRIDGE_TOKEN:'synthetic'},stdin:Readable.from([]),stdout:{write:v=>stdout+=v},stderr:{write(){}},fetchImpl});return {code,...JSON.parse(stdout)};}
test('CLI writes validated image to an exclusive local file without printing base64 or invoking vision',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'linebridge-media-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=join(dir,'image.png');
  const args=['media','--account','a','--chat','c','--message','123','--output',file],fetchImpl=async()=>new Response(JSON.stringify(imageResult(png)));
  const result=await cli(args,fetchImpl);assert.equal(result.code,0);assert.equal(result.visionInvoked,false);assert.equal(result.data,undefined);assert.deepEqual(await readFile(file),png);
  const again=await cli(args,fetchImpl);assert.equal(again.error,'output_failed');assert.deepEqual(await readFile(file),png);
});
test('CLI Flex validates before networking and preserves payload/key with exactly one request',async()=>{
  const args=['send-flex','--account','a','--chat','c','--key','cli-flex-001','--payload'];
  for(const body of ['not json',JSON.stringify({...payload(),acknowledgeTransportSecurity:false})]){
    const result=await cli([...args,body],()=>assert.fail('Invalid Flex must not reach network'));assert.equal(result.code,2);
  }
  let calls=0;const result=await cli([...args,JSON.stringify(payload())],async(url,options)=>{calls++;assert.ok(url.endsWith('/accounts/a/chats/c/flex'));assert.equal(options.headers['Idempotency-Key'],'cli-flex-001');assert.deepEqual(JSON.parse(options.body),payload());return new Response('{"messageId":"synthetic"}');});assert.equal(result.code,0);assert.equal(calls,1);
  const unknown=await cli([...args,JSON.stringify(payload())],async()=>{throw new Error('synthetic network failure');});assert.equal(unknown.error,'delivery_unknown');
});
test('HTTP/MCP image and Flex tools enforce the same authenticated boundary',async t=>{
  const {hub,store,account,driver}=await fixture(t);driver.media=async()=>imageResult(png);driver.sendFlex=async()=>({messageId:'synthetic-flex',protection:'line_transport'});
  const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const tunnels=new Tunnels(store,hub.vault,process.cwd(),port);t.after(()=>tunnels.close());
  const {gateway}=createApps({hub,tunnels,root:process.cwd(),adminPort:0,gatewayPort:port});const server=gateway.listen(port,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>{server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${server.address().port}`,token=hub.createToken({name:'Synthetic',grants:[{accountId:account.id,read:true,send:true}]}),headers={Authorization:`Bearer ${token.token}`};
  const path=`${base}/api/v1/accounts/${account.id}/chats/demo-group/messages/image-1/media`;
  assert.equal((await fetch(path)).status,401);const response=await fetch(path,{headers});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  const client=new Client({name:'media-test',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`),{requestInit:{headers}}));t.after(()=>client.close());
  const image=await client.callTool({name:'line_read_image',arguments:{accountId:account.id,chatId:'demo-group',messageId:'image-1'}});assert.equal(image.content[1].type,'image');assert.equal(image.content[1].data,png.toString('base64'));assert.ok(!image.content[0].text.includes(png.toString('base64')));
  const flex=await client.callTool({name:'line_send_flex',arguments:{accountId:account.id,chatId:'demo-group',payload:payload(),idempotencyKey:'mcp-flex-001'}});assert.equal(flex.isError,undefined);assert.equal(JSON.parse(flex.content[0].text).messageId,'synthetic-flex');
});
