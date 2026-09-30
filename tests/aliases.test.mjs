import test from 'node:test';
import assert from 'node:assert/strict';
import {AliasResolver,contactName} from '../server/aliases.mjs';
import {senderName} from '../public/names.js';
const storage=()=>{const data=new Map();return {get:async key=>data.get(key),set:async(key,value)=>data.set(key,structuredClone(value)),data};};
const message=id=>({id:`message-${id}`,senderId:id,text:'sample'});

test('personal aliases take precedence over profile names and cache remains account-local',async()=>{
  let calls=0;
  const client={profile:{mid:'self',displayName:'My profile'},talk:{getContactsV2:async({mids})=>{calls++;return {contacts:Object.fromEntries(mids.map(mid=>[mid,{contact:{mid,displayName:'Public name',displayNameOverridden:'My friend'}}]))};}}};
  const vault=storage(),resolver=new AliasResolver(client,vault);
  const result=await resolver.resolveMessages({kind:'group'},[message('friend'),message('self')]);
  assert.equal(result[0].senderName,'My friend');assert.equal(result[0].senderProfileName,'Public name');assert.equal(result[0].senderNameSource,'contact_alias');assert.equal(result[0].senderId,'friend');
  assert.equal(result[1].senderName,'My profile');assert.equal(calls,1);
  await new AliasResolver(client,vault).resolveMessages({kind:'direct'},[message('friend')]);assert.equal(calls,1);
  const other=new AliasResolver({talk:{getContactsV2:async()=>({contacts:{friend:{contact:{displayName:'Other account alias'}}}})}},storage());
  assert.equal((await other.resolveMessages({kind:'direct'},[message('friend')]))[0].senderName,'Other account alias');
  assert.equal(contactName({displayName:'Name',displayNameOverridden:'  '}),'Name');
});

test('Square members use their OpenChat nickname and never a personal contact alias',async()=>{
  let squareCalls=0,talkCalls=0;
  const client={talk:{getContactsV2:async()=>{talkCalls++;return {contacts:{member:{contact:{displayNameOverridden:'Private friend'}}}};}},square:{getSquareMembers:async request=>{squareCalls++;assert.deepEqual(request,{request:{mids:['member']}});return {members:{member:{squareMemberMid:'member',displayName:'Community nickname'}}};}}};
  const resolver=new AliasResolver(client,storage());
  await resolver.resolveMessages({kind:'direct'},[message('member')]);
  const result=await resolver.resolveMessages({kind:'openchat'},[message('member')]);
  assert.equal(result[0].senderName,'Community nickname');assert.equal(result[0].senderNameSource,'openchat_profile');assert.equal(result[0].senderProfileName,undefined);assert.equal(talkCalls,1);assert.equal(squareCalls,1);
  const event=await resolver.resolveMessages({kind:'openchat'},[{...message('another'),senderName:'Event nickname'}]);
  assert.equal(event[0].senderName,'Event nickname');assert.equal(squareCalls,1);
});

test('missing members, failed lookup and expired negative cache do not drop message content',async()=>{
  let clock=0,calls=0;
  const resolver=new AliasResolver({talk:{getContactsV2:async()=>{calls++;throw new Error('private upstream details');}}},storage(),{now:()=>clock});
  const result=await resolver.resolveMessages({kind:'group'},[message('missing')]);
  assert.equal(result[0].text,'sample');assert.equal(result[0].senderName,null);assert.equal(result[0].senderNameStatus,'unavailable');
  assert.ok(!JSON.stringify(result).includes('private upstream details'));
  await resolver.resolveMessages({kind:'group'},[message('missing')]);assert.equal(calls,1);
  clock=60001;await resolver.resolveMessages({kind:'group'},[message('missing')]);assert.equal(calls,2);
});

test('bounded batches and simultaneous requests coalesce repeated senders',async()=>{
  const batches=[];let release;const wait=new Promise(resolve=>{release=resolve;});
  const resolver=new AliasResolver({talk:{getContactsV2:async({mids})=>{batches.push(mids);await wait;return {contacts:Object.fromEntries(mids.map(mid=>[mid,{contact:{displayName:mid+' name'}}]))};}}},storage());
  const first=resolver.resolveMessages({kind:'group'},Array.from({length:205},(_,i)=>message('user-'+i)));
  const second=resolver.resolveMessages({kind:'group'},[message('user-0')]);
  await new Promise(resolve=>setImmediate(resolve));release();
  const [a,b]=await Promise.all([first,second]);assert.deepEqual(batches.map(b=>b.length),[100,100,5]);assert.equal(a.length,205);assert.equal(b[0].senderName,'user-0 name');
});

test('name lookup timeout leaves IDs stable and UI fallback never renders a GUID',async()=>{
  const resolver=new AliasResolver({talk:{getContactsV2:async()=>new Promise(()=>{})}},storage(),{timeout:15});
  const result=await resolver.resolveMessages({kind:'direct'},[message('u0123456789abcdef0123456789abcdef')]);
  assert.equal(result[0].senderId,'u0123456789abcdef0123456789abcdef');assert.equal(senderName(result[0],{}),'名稱暫時無法取得');
  assert.equal(senderName(result[0],{},{kind:'direct',id:result[0].senderId,name:'已儲存的別名'}),'已儲存的別名');
  assert.equal(senderName({senderId:'self'},{profile:{mid:'self'}}),'我');
});

test('unsupported Square batch RPC falls back to at most four concurrent single-member lookups',async()=>{
  let active=0,peak=0;
  const resolver=new AliasResolver({square:{getSquareMembers:async()=>{throw {data:{errorCode:'NOT_IMPLEMENTED'}};},getSquareMember:async({squareMemberMid})=>{active++;peak=Math.max(peak,active);await new Promise(resolve=>setImmediate(resolve));active--;return {squareMember:{squareMemberMid,displayName:'Community '+squareMemberMid}};}}},storage());
  const result=await resolver.resolveMessages({kind:'openchat'},Array.from({length:12},(_,i)=>message('member-'+i)));
  assert.ok(peak<=4);assert.equal(result[11].senderName,'Community member-11');
});
