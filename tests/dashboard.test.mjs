import test from 'node:test';
import assert from 'node:assert/strict';
import {dashboardSummary,dashboardMarkup} from '../public/dashboard.js';

const empty=()=>({accounts:[],chatCounts:{},tokens:[],gateway:{enabled:true,authentication:'token'},tunnel:{provider:'local',connected:false},refresh:{intervalSeconds:60}});
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

test('dashboard totals come from account, chat and archive state, including disconnected accounts',()=>{
  const state=empty();state.chatCounts={a:5,b:3};
  state.accounts=[{id:'a',label:'A',status:'connected',designatedChats:2,monitor:{enabled:true,storedMessages:12}},{id:'b',label:'B',status:'disconnected',designatedChats:1,monitor:{enabled:true,storedMessages:7}}];
  assert.deepEqual(dashboardSummary(state),{accounts:2,connected:1,chats:8,monitored:3,messages:19,listening:1});
  const html=dashboardMarkup(state,escape);
  assert.match(html,/stroke-dasharray="50 50"/);assert.match(html,/stroke-dasharray="38 62"/);
  assert.match(html,/max="12" value="7"/);assert.match(html,/等待連線/);
});

test('empty dashboards have honest zero graphics and escape account names',()=>{
  const state=empty(),html=dashboardMarkup(state,escape);
  assert.deepEqual(dashboardSummary(state),{accounts:0,connected:0,chats:0,monitored:0,messages:0,listening:0});
  assert.match(html,/stroke-dasharray="0 100"/);assert.doesNotMatch(html,/NaN|Infinity/);
  assert.match(html,/data-go="setup"/);
  state.accounts=[{id:'a',label:'<img src=x onerror=alert(1)>',status:'disconnected',designatedChats:0}];state.chatCounts.a=0;
  const safe=dashboardMarkup(state,escape);assert.doesNotMatch(safe,/<img/);assert.match(safe,/&lt;img/);
});
