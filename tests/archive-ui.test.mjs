import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createArchive} from '../public/archive.js';
import {formTimeRange} from '../public/search-time.js';

function fixture(t){
  const node=()=>({value:'',listeners:{},hidden:false,disabled:false,innerHTML:'',textContent:'',addEventListener(type,fn){this.listeners[type]=fn;},replaceChildren(){this.innerHTML='';},querySelectorAll(){return [];},focus(){}});
  const nodes=new Map(['form','count','more','submit','status','results','clear-time'].map(id=>[`#archive-${id}`,node()]));
  const form=nodes.get('#archive-form');form.elements=Object.fromEntries(['query','mode','accountId','chatId','startTime','endTime','timeOffset'].map(key=>[key,node()]));
  Object.assign(form.elements.query,{value:'needle'});form.elements.mode.value='all';form.elements.timeOffset.value='+00:00';
  const original=globalThis.document;globalThis.document={querySelector:s=>nodes.get(s)};t.after(()=>{if(original===undefined)delete globalThis.document;else globalThis.document=original;});
  const requests=[],errors=[],responses=[],state={accounts:[{id:'a',label:'Synthetic',monitor:{storedMessages:0}}]};
  const archive=createArchive({api:async(path,options)=>{if(path!=='/messages/search')return [{id:'c',name:'Synthetic chat',enabled:true}];requests.push(JSON.parse(options.body));return await (responses.shift()??{results:[],hasMore:false,nextBefore:null});},action:async job=>{try{return await job();}catch(e){errors.push(e);}},escape:String,when:String,short:String,getState:()=>state,openChat(){}});
  return {nodes,form,requests,errors,responses,archive,submit:()=>form.listeners.submit({preventDefault(){}}),more:()=>nodes.get('#archive-more').listeners.click(),change:()=>form.listeners.input()};
}

test('archive UI keeps time criteria through empty pages, resets new searches and clears filters',async t=>{
  const f=fixture(t);f.form.elements.startTime.value='2026-10-06T08:00';f.form.elements.endTime.value='2026-10-07T08:00';f.form.elements.timeOffset.value='+08:00';
  f.responses.push({results:[],hasMore:true,nextBefore:15});await f.submit();assert.equal(f.nodes.get('#archive-more').hidden,false);
  await f.more();assert.deepEqual(f.requests[1],{...f.requests[0],before:15});
  assert.equal(f.requests[0].startTime,'2026-10-06T08:00:00+08:00');
  f.form.elements.startTime.value='2026-10-06T12:00';f.change();assert.equal(f.nodes.get('#archive-more').hidden,true);
  await f.more();assert.equal(f.requests.length,2);await f.submit();assert.equal(f.requests[2].before,undefined);
  assert.equal(f.requests[2].startTime,'2026-10-06T12:00:00+08:00');
  f.nodes.get('#archive-clear-time').listeners.click();await f.submit();assert.equal(f.requests[3].startTime,undefined);assert.equal(f.requests[3].endTime,undefined);
  f.form.elements.endTime.value='2026-10-07T00:00';await f.submit();assert.equal(f.requests[4].startTime,undefined);assert.equal(f.requests[4].endTime,'2026-10-07T00:00:00+08:00');
  await f.archive.open('a','c');assert.equal(f.form.elements.endTime.value,'');assert.equal(f.form.elements.startTime.value,'');
  assert.equal(f.errors.length,0);
});

test('archive UI prevents invalid range requests and ignores responses after editing filters',async t=>{
  const f=fixture(t);
  for(const [start,end,offset] of [['2026-10-07T00:00','2026-10-06T00:00','+00:00'],['2026-10-06T00:00','',''],['2026-02-30T00:00','','+00:00']]){
    f.form.elements.startTime.value=start;f.form.elements.endTime.value=end;f.form.elements.timeOffset.value=offset;await f.submit();
  }
  assert.equal(f.requests.length,0);assert.equal(f.errors.length,3);assert.ok(f.nodes.get('#archive-status').textContent);
  f.form.elements.startTime.value='2026-10-06T00:00';f.form.elements.timeOffset.value='+00:00';
  let complete;f.responses.push(new Promise(resolve=>{complete=resolve;}));const pending=f.submit();
  await f.submit();assert.equal(f.requests.length,1); // no duplicate while pending
  f.form.elements.startTime.value='2026-10-06T01:00';f.change();complete({results:[],hasMore:true,nextBefore:100});await pending;
  assert.equal(f.nodes.get('#archive-more').hidden,true);assert.equal(f.nodes.get('#archive-submit').disabled,false);
  assert.match(f.nodes.get('#archive-status').textContent,/重新搜尋/);
  await f.submit();assert.equal(f.requests.length,2);assert.equal(f.requests[1].before,undefined);
});

test('web time inputs expose timezone and preserve seconds/milliseconds without host timezone inference',()=>{
  assert.deepEqual(formTimeRange('2026-10-06T08:30:01.005','','+08:00'),{startTime:'2026-10-06T08:30:01.005+08:00'});
  assert.deepEqual(formTimeRange('','2026-10-06T08:30','-03:30'),{endTime:'2026-10-06T08:30:00-03:30'});
  assert.throws(()=>formTimeRange('2026-10-06T08:30','','-00:00'));
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  assert.match(html,/name="timeOffset"[^>]*value="\+00:00"/);assert.match(html,/id="archive-time-help"/);assert.match(html,/step="0.001"/);
});
