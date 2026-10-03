import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../server/store.mjs';
import {Vault} from '../server/vault.mjs';
import {Hub} from '../server/hub.mjs';
import {Tunnels} from '../server/tunnels.mjs';
import {createApps} from '../server/app.mjs';
import {removeClientFixture} from './client-test-utils.mjs';

async function fixture(t) {
  const directory=await mkdtemp(join(tmpdir(),'linebridge-cli-integration-'));
  const store=new Store(':memory:'),vault=new Vault(randomBytes(32),'synthetic test key'),hub=new Hub(store,vault);
  const tunnels=new Tunnels(store,vault,resolve('.'),0),apps=createApps({hub,tunnels,root:resolve('.'),gatewayPort:0});
  const server=apps.gateway.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  // createApps checks the gateway Host against the port it was constructed with.
  const port=server.address().port;server.close();await new Promise(resolve=>server.once('close',resolve));
  const gateway=createApps({hub,tunnels,root:resolve('.'),gatewayPort:port}).gateway.listen(port,'127.0.0.1');
  await new Promise(resolve=>gateway.once('listening',resolve));
  t.after(async()=>{hub.close();tunnels.close();gateway.closeAllConnections();await new Promise(resolve=>gateway.close(resolve));store.close();await removeClientFixture(directory);});
  const account=await hub.addAccount({label:'CLI synthetic sandbox',kind:'demo'});hub.designate(account.id,'demo-group',true);hub.designate(account.id,'demo-openchat',true);await hub.monitor(account.id,true);
  const other=await hub.addAccount({label:'Ungrantable synthetic sandbox',kind:'demo'});
  const writer=hub.createToken({name:'Synthetic CLI writer',grants:[{accountId:account.id,read:true,send:true}]});
  const reader=hub.createToken({name:'Synthetic CLI reader',grants:[{accountId:account.id,read:true,send:false}]});
  async function cli(args,{token=writer.token,input=''}={}) {
    const env={...process.env,LINE_BRIDGE_URL:`http://127.0.0.1:${port}`,LINE_BRIDGE_TOKEN:token,LINE_BRIDGE_CLIENT_CONFIG:directory};
    delete env.CF_ACCESS_CLIENT_ID;delete env.CF_ACCESS_CLIENT_SECRET;
    return new Promise((resolvePromise,reject)=>{
      const child=spawn(process.execPath,['bin/linebridge.mjs',...args],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});
      const timer=setTimeout(()=>{child.kill();reject(new Error('Synthetic CLI subprocess timed out'));},15000);
      let stdout='',stderr='';child.stdout.on('data',b=>{stdout+=b;});child.stderr.on('data',b=>{stderr+=b;});child.on('error',error=>{clearTimeout(timer);reject(error);});
      child.on('close',code=>{clearTimeout(timer);try{resolvePromise({code,json:JSON.parse(stdout),stdout,stderr});}catch{reject(new Error('CLI did not return JSON'));}});child.stdin.end(input);
    });
  }
  return {store,hub,account,other,writer,reader,directory,cli};
}
test('CLI accounts exposes per-stream receiver success and missing-stream health through the scoped gateway',async t=>{
  const {hub,store,account,cli}=await fixture(t);
  // Keep the synthetic driver; change metadata only to exercise live health.
  store.db.prepare("UPDATE accounts SET kind='line' WHERE id=?").run(account.id);
  const lastSuccessAt=new Date().toISOString();
  hub.runtime.get(account.id).monitorStreams={talk:{channel:'talk',status:'polling',lastAttemptAt:lastSuccessAt,lastSuccessAt,ready:true}};
  const result=await cli(['accounts']);assert.equal(result.code,0);
  const monitor=result.json[0].monitor;
  assert.equal(monitor.health,'waiting');assert.equal(monitor.streams.talk.lastSuccessAt,lastSuccessAt);
  assert.equal(monitor.streams.talk.health,'healthy');assert.equal(monitor.streams['demo-openchat'].lastSuccessAt,null);
  assert.equal(monitor.staleAfterMs,60000);assert.ok(monitor.checkedAt);
  const streams=hub.runtime.get(account.id).monitorStreams;
  streams['demo-openchat']={status:'running',lastSuccessAt,ready:true};
  Object.assign(streams.talk,{error:'monitor_poll_failed',pollTimeoutMs:180000,pollDeadlineAt:new Date(Date.now()+180000).toISOString(),lastFailure:{at:lastSuccessAt,kind:'timeout',stage:'poll',errorName:'TimeoutError',elapsedMs:180000,pollTimeoutMs:180000,retryInMs:2000}});
  const retry=(await cli(['accounts'])).json[0].monitor;
  assert.equal(retry.status,'retrying');assert.equal(retry.health,'retrying');assert.equal(retry.streams.talk.status,'polling');
  assert.equal(retry.streams['demo-openchat'].health,'healthy');assert.deepEqual(retry.streams.talk.lastFailure,streams.talk.lastFailure);
  assert.equal(retry.streams.talk.pollTimeoutMs,180000);assert.equal(retry.streams.talk.pollDeadlineAt,streams.talk.pollDeadlineAt);
});

test('installed entrypoint uses scoped gateway reads/search/events and preserves replay for file/stdin sends',async t=>{
  const {hub,account,other,reader,directory,cli}=await fixture(t);
  const accounts=await cli(['accounts']);assert.equal(accounts.code,0);assert.deepEqual(accounts.json.map(a=>a.id),[account.id]);assert.equal(accounts.stderr,'');
  const chats=await cli(['chats','--account',account.id]);assert.deepEqual(chats.json.map(c=>c.id).sort(),['demo-group','demo-openchat']);
  const text='會議 日本語 😀\nمتعدد الأسطر\r\n最後一行\n',path=join(directory,'unicode message.txt');await writeFile(path,text);
  const target=['send','--account',account.id,'--chat','demo-group','--key','cli-integration-key'];
  const first=await cli([...target,'--text-file',path]);assert.equal(first.code,0);assert.equal(first.json.delivery,'sandbox_only');assert.equal(first.json.replayed,false);
  const replay=await cli([...target,'--stdin'],{input:text});assert.equal(replay.code,0);assert.equal(replay.json.messageId,first.json.messageId);assert.equal(replay.json.replayed,true);
  const conflict=await cli([...target,'--text','other synthetic text']);assert.equal(conflict.code,6);assert.equal(conflict.json.error,'idempotency_conflict');
  const read=await cli(['read','--account',account.id,'--chat','demo-group','--limit','1']);assert.equal(read.json.messages.length,1);assert.equal(read.json.messages[0].text,text);assert.equal(read.json.untrustedContent,true);
  const events=await cli(['events','--account',account.id,'--limit','1']);assert.equal(events.json.events.length,1);assert.equal(events.json.events[0].message.text,text);
  const after=await cli(['events','--account',account.id,'--after',String(events.json.cursor)]);assert.deepEqual(after.json.events,[]);assert.equal(after.json.cursor,events.json.cursor);
  for(let i=0;i<3;i++)hub.capture(account.id,'demo-group',{id:`synthetic-search-${i}`,text:`會議 page ${i}`,timestamp:new Date().toISOString()});
  const sequences=[];let before;
  do {
    const page=await cli(['search','--query','會議','--account',account.id,'--chat','demo-group','--limit','1',...(before?['--before',String(before)]:[])]);
    assert.equal(page.code,0);assert.ok(page.json.results.length<=1);sequences.push(...page.json.results.map(r=>r.sequence));before=page.json.hasMore?page.json.nextBefore:null;
  } while(before);
  assert.equal(sequences.length,4);assert.equal(new Set(sequences).size,4);
  const denied=await cli([...target.slice(0,5),'--key','cli-readonly-key','--text','synthetic denial'],{token:reader.token});assert.equal(denied.code,4);assert.equal(denied.json.error,'scope_denied');
  const outside=await cli(['chats','--account',other.id]);assert.equal(outside.code,4);
  hub.designate(account.id,'demo-group',false);assert.equal((await cli(['read','--account',account.id,'--chat','demo-group'])).json.error,'chat_not_designated');
});
test('CLI delivery_unknown does not dispatch again, and revocation/pause still apply through the gateway',async t=>{
  const {store,hub,account,writer,cli}=await fixture(t);
  let sends=0;hub.driver(account.id).send=async()=>{sends++;throw new Error('synthetic lost acknowledgement');};
  const args=['send','--account',account.id,'--chat','demo-group','--key','cli-unknown-key','--text','synthetic ambiguity'];
  const first=await cli(args);assert.equal(first.code,8);assert.equal(first.json.error,'delivery_unknown');assert.equal(sends,1);
  const explicitReplay=await cli(args);assert.equal(explicitReplay.code,8);assert.equal(sends,1);
  store.setSetting('aiEnabled',false);assert.equal((await cli(['accounts'])).code,7);store.setSetting('aiEnabled',true);
  store.revoke(writer.id);assert.equal((await cli(['accounts'])).code,4);assert.equal(sends,1);
});
