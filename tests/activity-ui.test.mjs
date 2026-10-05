import test from 'node:test';
import assert from 'node:assert/strict';
import {createActivity,debugDescription} from '../public/activity.js';

const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function fixture(t){
  const nodes=new Map(),errors=[],requests=[];
  for(const selector of ['#debug-logging','#debug-logging-status','#audit-list'])nodes.set(selector,{attributes:{},listeners:{},textContent:'',innerHTML:'',setAttribute(name,value){this.attributes[name]=value;},addEventListener(type,handler){this.listeners[type]=handler;}});
  const original=globalThis.document;globalThis.document={querySelector:selector=>nodes.get(selector)};
  t.after(()=>{if(original===undefined)delete globalThis.document;else globalThis.document=original;});
  const state={debugLogging:{enabled:false},accounts:[{id:'a',label:'<img src=x onerror=alert(1)>'}],tokens:[],audit:[]};
  const context={getState:()=>state,api:async(path,options)=>{requests.push({path,options});return JSON.parse(options.body);},action:async job=>{try{return await job();}catch(error){errors.push(error);}},toast(){},refresh:async()=>{},escape,when:value=>value,short:()=>'<short time>'};
  const activity=createActivity(context);activity.render();
  return {state,context,activity,nodes,requests,errors,toggle:nodes.get('#debug-logging')};
}

test('Records toggle saves explicit enable and disable choices',async t=>{
  const f=fixture(t);
  assert.equal(f.toggle.attributes['aria-checked'],'false');
  await f.toggle.listeners.click();assert.equal(f.state.debugLogging.enabled,true);assert.equal(f.toggle.attributes['aria-checked'],'true');
  await f.toggle.listeners.click();assert.equal(f.state.debugLogging.enabled,false);
  assert.deepEqual(f.requests.map(r=>[r.path,JSON.parse(r.options.body)]),[['/debug-settings',{enabled:true}],['/debug-settings',{enabled:false}]]);
  assert.equal(f.toggle.disabled,false);
});

test('Records toggle returns to its saved state when the server rejects an update',async t=>{
  const f=fixture(t);
  // Recreate the controller with a failing boundary, as an unavailable service
  // must never make the UI claim debug logging was enabled.
  const activity=createActivity({...f.context,api:async()=>{throw new Error('Unavailable');}});activity.render();
  await f.toggle.listeners.click();
  assert.equal(f.state.debugLogging.enabled,false);assert.equal(f.toggle.attributes['aria-checked'],'false');assert.equal(f.toggle.disabled,false);assert.equal(f.errors.length,1);
});

test('debug records show precise timestamps, failure context and escaped account labels',t=>{
  const f=fixture(t);f.state.debugLogging.enabled=true;
  f.state.audit=[{id:'log',at:'2026-10-05T00:00:03.500Z',actor:'system',account_id:'a',chat_id:null,action:'debug.poll',outcome:'failed',details:{channel:'talk',status:'retrying',durationMs:180000,failureKind:'timeout',stage:'poll',retryInMs:2000,lastSuccessAt:'2026-10-05T00:00:00.000Z'}}];
  f.activity.render();const html=f.nodes.get('#audit-list').innerHTML;
  assert.match(html,/DEBUG/);assert.match(html,/LINE 訊息輪詢/);assert.match(html,/180,000 ms/);assert.match(html,/逾時/);assert.match(html,/2 秒後重試/);assert.match(html,/2026-10-05T00:00:03.500Z/);
  assert.match(html,/系統/);assert.match(html,/失敗/);assert.doesNotMatch(html,/<img/);assert.match(html,/&lt;img/);
  assert.equal(debugDescription(null,value=>value),'');
  assert.match(debugDescription({accounts:0,connected:0,storedMessages:0,gatewayEnabled:false,durationMs:0},value=>value),/帳號 0 \/ 0 已連線.*封存 0 則.*已暫停/);
});
