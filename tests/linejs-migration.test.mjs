import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomBytes,generateKeyPairSync} from 'node:crypto';
import {createRequire} from 'node:module';
import {InternalError} from '@evex/linejs/base';
import {Thrift,Protocols,LINEStruct} from '@evex/linejs/thrift';
import {LineDriver} from '../server/drivers.mjs';
import {Store} from '../server/store.mjs';
import {Vault,VaultStorage} from '../server/vault.mjs';
import {existingKeyE2EE} from '../server/encryption-policy.mjs';
import {prepareText} from '../server/send-preparation.mjs';
import {LiveMonitor} from '../protocol/monitor.mjs';

const self='u'+'1'.repeat(32),friend='u'+'2'.repeat(32),group='c'+'3'.repeat(32);
function keyPair(keyId){const pair=generateKeyPairSync('x25519');return {keyId,privKey:pair.privateKey.export({type:'pkcs8',format:'der'}).subarray(-32).toString('base64'),pubKey:pair.publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('base64')};}
function fixture(t){
  const store=new Store(':memory:'),vault=new Vault(randomBytes(32),'synthetic'),account=store.addAccount('Synthetic migration','line','IOSIPAD'),storage=new VaultStorage(store,vault,account.id);
  const driver=new LineDriver(account,storage,{fault:()=>{}},{fetch:async()=>assert.fail('No live transport permitted')});
  t.after(()=>{driver.stop();store.close();});return {store,storage,driver,client:driver.client};
}
test('official JSR LineJS is pinned with registry integrity and bundled signal forwarding',async()=>{
  const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url))),lock=JSON.parse(await readFile(new URL('../package-lock.json',import.meta.url)));
  assert.equal(pkg.dependencies['@evex/linejs'],'npm:@jsr/evex__linejs@3.4.2');assert.equal(pkg.dependencies.lineclientbot,undefined);
  assert.equal(pkg.dependencies['@jsr/evex__linejs'],undefined,'Do not install the obsolete package suggested by npm audit fix --force');
  assert.equal(lock.packages['node_modules/@jsr/evex__linejs'],undefined);
  const sdkRequire=createRequire(import.meta.resolve('@evex/linejs/thrift'));
  assert.equal(sdkRequire('thrift/package.json').version,'0.23.0','The SDK must resolve the patched Thrift runtime');
  assert.equal(lock.packages['node_modules/@evex/linejs'].version,'3.4.2');assert.equal(lock.packages['node_modules/@evex/linejs'].resolved,'https://npm.jsr.io/~/11/@jsr/evex__linejs/3.4.2.tgz');
  assert.equal(lock.packages['node_modules/@evex/linejs'].integrity,'sha512-nq7q2DKMdOUn1bK5I2sdTb0waaD0JkK/8Zi18T8iQA+nsHLJSlXuTYpvQcfrY2EFPu5IJ5HEUaiJfOkVIzTWIg==');
  // Behavior is separately exercised with real SDK encrypted timeout/body tests.
  const legy=await readFile(new URL('../node_modules/@evex/linejs/base/request/legy.js',import.meta.url),'utf8');assert.match(legy,/signal: request\.signal/);
});
test('patched Thrift preserves LineJS binary and compact wire formats and 64-bit cursors',()=>{
  const thrift=new Thrift(),value=[[12,0,[[10,1,9007199254740999n],[11,2,'測試 LINE'],[15,3,[8,[1,-2,3]]],[2,4,true]]]];
  // Captured with LineJS 3.4.2 and Thrift 0.20.0 before the security override.
  const fixtures={
    3:'800100010000000766697874757265000000000c00000a000100200000000000070b00020000000be6b8ace8a9a6204c494e450f0003080000000300000001fffffffe0000000302000401000000',
    4:'82210007666978747572650c00168e80808080808020180be6b8ace8a9a6204c494e45193502030611000000'
  };
  for(const id of [3,4]){
    const wire=Buffer.from(fixtures[id],'hex');
    assert.deepEqual(Buffer.from(thrift.writeThrift(value,'fixture',Protocols[id])),wire);
    assert.deepEqual(thrift.readThrift(wire,Protocols[id]),{data:{0:{1:9007199254740999n,2:'測試 LINE',3:[1,-2,3],4:true}},_info:{fname:'fixture',mtype:1,rseqid:0}});
  }
});
test('token resume preserves legacy encrypted key/cursor records and does not enroll keys or log in again',async t=>{
  const {storage,driver,client}=fixture(t),pair=keyPair(123),groupKey={keyId:77,privKey:randomBytes(32).toString('base64')};
  const prior={'bridge.authToken':'synthetic-opaque-token','refreshToken':'synthetic-refresh','expire':1234567890,'reqseq':'{"talk":7,"sq":12}',[`e2eeKeys:${self}`]:JSON.stringify(pair),'e2eeKeys:123':JSON.stringify(pair),[`e2eeGroupKeys:${group}`]:JSON.stringify(groupKey),'monitor.talk':{revision:9007199254740999n,globalRev:2n,individualRev:3n},'monitor.square:synthetic-room':{syncToken:'synthetic-room-cursor',ready:true}};
  for(const [key,value] of Object.entries(prior))await storage.set(key,value);
  client.talk.getProfile=async()=>({mid:self,displayName:'Synthetic'});
  client.loginProcess.withQrCode=()=>assert.fail('Resume must not pair');client.e2ee.registerE2EEKeyPair=()=>assert.fail('Resume must not enroll');client.e2ee.tryRegisterE2EEGroupKey=()=>assert.fail('Resume must not enroll');
  assert.equal((await driver.login(false)).mid,self);await new Promise(resolve=>setImmediate(resolve));
  for(const [key,value] of Object.entries(prior))assert.deepEqual(await storage.get(key),value);
  assert.deepEqual(await client.e2ee.getE2EESelfKeyData(self),pair);assert.deepEqual(await existingKeyE2EE(client).getE2EELocalPublicKey(group,77),groupKey);
  assert.deepEqual(await Promise.all([client.getReqseq(),client.getReqseq(),client.getReqseq('sq')]),[7,8,12]);assert.deepEqual(JSON.parse(await storage.get('reqseq')),{talk:9,sq:13});
});
test('legacy public-key cache is retained but not reused across people; historical group generation remains readable',async t=>{
  const {storage,client}=fixture(t),old=randomBytes(32).toString('base64'),right=randomBytes(32),calls=[];
  client.profile={mid:self};await storage.set('e2eePublicKeys:55',old);
  client.talk.negotiateE2EEPublicKey=async({mid})=>{calls.push(mid);return {specVersion:2,publicKey:{keyId:55,keyData:right}};};
  assert.deepEqual(await client.e2ee.getE2EELocalPublicKey(friend,55),right);assert.deepEqual(calls,[friend]);assert.equal(await storage.get('e2eePublicKeys:55'),old);assert.equal(await storage.get(`e2eePublicKeys:${friend}:55`),right.toString('base64'));
  const historic={keyId:70,privKey:randomBytes(32).toString('base64')},current={keyId:71,privKey:randomBytes(32).toString('base64')};
  await storage.set(`e2eeGroupKeys:${group}`,JSON.stringify(current));await storage.set(`e2eeGroupKeys:${group}:70`,JSON.stringify(historic));
  assert.deepEqual(await existingKeyE2EE(client).getE2EELocalPublicKey(group,'70'),historic);assert.deepEqual(await existingKeyE2EE(client).getE2EELocalPublicKey(group,71),current);
});
test('missing group key generation cannot trigger SDK registration during reads or send preparation',async t=>{
  const {storage,client}=fixture(t),selfKey=keyPair(123);client.profile={mid:self};await storage.set(`e2eeKeys:${self}`,JSON.stringify(selfKey));
  const queried=[];client.talk.getE2EEGroupSharedKey=async args=>{queried.push(args.groupKeyId);throw new InternalError('RequestError','synthetic',{code:'NOT_FOUND'});};client.talk.getLastE2EEGroupSharedKey=async()=>{throw new InternalError('RequestError','synthetic',{code:'NOT_FOUND'});};
  client.e2ee.tryRegisterE2EEGroupKey=()=>assert.fail('No registration');client.talk.registerE2EEGroupKey=()=>assert.fail('No registration');client.e2ee.registerE2EEKeyPair=()=>assert.fail('No enrollment');
  await assert.rejects(existingKeyE2EE(client).getE2EELocalPublicKey(group,72),error=>error.data.code==='NOT_FOUND');assert.deepEqual(queried,[72]);
  await assert.rejects(prepareText(client,{id:group,kind:'group'},'synthetic'),error=>error.diagnostic==='GROUP_KEY_LOOKUP_NOT_FOUND');
  assert.equal(await storage.get(`e2eeGroupKeys:${group}`),undefined);
});
test('real LineJS Thrift decoder accepts a structured empty Square feed, unlike zero-byte HTTP',async t=>{
  let client;
  const driver=new LineDriver({device:'IOSIPAD'},{},{fault:()=>{}},{fetch:async()=>new Response(client.thrift.writeThrift([[12,0,LINEStruct.FetchMyEventsResponse({events:[],syncToken:'synthetic-durable',continuationToken:'synthetic-next'})]],'fetchMyEvents',Protocols[4]))});t.after(()=>driver.stop());client=driver.client;client.legy.encrypted=false;
  const page=await client.square.fetchMyEvents({limit:100,syncToken:'synthetic-old'});assert.deepEqual(page.events,[]);assert.equal(page.syncToken,'synthetic-durable');assert.equal(page.continuationToken,'synthetic-next');
});
test('Talk fast-empty responses back off to five seconds; a held response or operation restores prompt rearm',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.parse('2026-10-07T00:00:00Z')});let polls=0,releaseHeld;const attempts=[];
  const driver={storage:{get:async()=>({revision:1}),set:async()=>{}},client:{talk:{sync:async()=>{attempts.push(Date.now());polls++;if(polls===7)await new Promise(resolve=>{releaseHeld=resolve;});return {operationResponse:{operations:polls===6?[{revision:2,type:0}]:[]}};}}}};
  const m=new LiveMonitor(driver,()=>{},()=>assert.fail('No message events'),{random:()=>0});t.after(async()=>{m.stop();await m.done();});m.update([{id:'group',kind:'group'}]);
  const tick=async ms=>{t.mock.timers.tick(ms);await new Promise(resolve=>setImmediate(resolve));};
  await tick(1000);for(const delay of [250,1000,2000,4000,5000,250])await tick(delay);
  assert.equal(polls,7);assert.deepEqual(attempts.slice(1).map((at,i)=>at-attempts[i]),[250,1000,2000,4000,5000,250]);
  await tick(1200);releaseHeld();await tick(0);await tick(249);assert.equal(polls,7);await tick(1);assert.equal(polls,8);
});
