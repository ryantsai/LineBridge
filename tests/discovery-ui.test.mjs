import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
function section(start,end){
  const from=source.indexOf(start),to=source.indexOf(end,from);
  assert.ok(from>=0&&to>from,'Dashboard function boundaries exist');
  return source.slice(from,to);
}
// Exercise the actual dashboard handlers without starting a service, browser,
// timers, or LINE session. Only their DOM and HTTP boundaries are simulated.
const handlers=[
  section('function switchTab(tab){',"document.querySelectorAll('[data-tab]')"),
  section('async function refresh(){',"$('#refresh').addEventListener"),
  section('function flushDiscoveredChats(){','function renderChatList(){'),
  section('function renderChatList(){','async function reconnect(){')
].join('\n');

function fixture(){
  const nodes=new Map(),requests=[];
  function node(selector){
    if(!nodes.has(selector)){
      let html='';
      nodes.set(selector,{
        textContent:'',value:'',focused:false,writes:0,listeners:{},
        classList:{add(){},remove(){},toggle(){}},
        get innerHTML(){return html;},set innerHTML(value){html=value;this.writes++;},
        matches(value){return value===':focus'&&this.focused;},
        querySelectorAll(){return [];},
        addEventListener(type,handler){this.listeners[type]=handler;},
        focus(){this.focused=true;}
      });
    }
    return nodes.get(selector);
  }
  const oldChat={id:'synthetic-old',name:'Existing room',kind:'group',enabled:1};
  const next=[oldChat,{id:'synthetic-new',name:'New room',kind:'openchat',enabled:1}];
  const account={id:'synthetic-account',kind:'line',status:'connected',designatedChats:2,
    discovery:{at:'2026-01-01T00:00:00Z'},monitor:{lastSequence:1}};
  const state={accounts:[account],gateway:{enabled:true,authentication:'token',port:3211},
    tunnel:{connected:false,provider:'local'},tokens:[],vault:'synthetic'};
  const context={
    state,selectedAccount:account.id,selectedChat:oldChat.id,chats:[oldChat],
    currentPage:'accounts',chatFilter:'all',chatSearch:'',refreshRunning:false,reading:false,sending:false,
    chatListRefreshPending:false,observedDiscoveries:new Map(),observedSequences:new Map([[account.id,1]]),
    sendAttempt:{key:'synthetic-intent'},$:node,
    document:{body:{dataset:{}},querySelectorAll(){return [];}},
    api:async(path,options)=>{requests.push({path,options});if(path==='/state')return state;if(path===`/accounts/${account.id}/chats`)return next;throw new Error('Unexpected request: '+path);},
    renderRefreshSettings(){},renderAccounts(){},renderLocalAccess(){},renderTokens(){},
    renderAudit(){},renderTunnel(){},renderMonitoring(){},renderAiInstructions(){},
    archive:{render(){}},wizard:{sync(){},render(){}},providerName:value=>value,
    renderAccountPane(){throw new Error('Discovery must preserve the account pane');},
    readMessages(){throw new Error('Discovery must not fetch messages');},
    escape:value=>String(value??'').replace(/[&<>"]/g,value=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[value])),
    nice:value=>({group:'群組',direct:'一對一',openchat:'OpenChat'}[value]??value),
    chatName:chat=>chat.name
  };
  node('#reader').innerHTML='Existing conversation';
  node('#send-form textarea').value='Unsent synthetic draft';
  node('#chat-filter').options=['all','group','direct','openchat'].map(value=>({value,textContent:''}));
  vm.createContext(context);vm.runInContext(handlers,context);
  return {context,node,requests,next,account};
}
function assertReaderUnchanged(f){
  assert.equal(f.node('#reader').innerHTML,'Existing conversation');
  assert.equal(f.node('#reader').writes,1);
  assert.equal(f.node('#send-form textarea').value,'Unsent synthetic draft');
  assert.equal(f.context.selectedChat,'synthetic-old');
  assert.equal(f.context.sendAttempt.key,'synthetic-intent');
  assert.ok(f.requests.every(request=>request.options===undefined),'No permission or message mutations');
}

test('automatic discovery updates chat controls in place without clearing the reader or draft',async()=>{
  const f=fixture();
  await f.context.refresh();
  assert.match(f.node('#chat-list').innerHTML,/New room/);
  assert.deepEqual(f.node('#chat-filter').options.map(option=>option.textContent),['全部 (2)','群組 (1)','一對一 (0)','OpenChat (1)']);
  assert.equal(f.node('.chat-tools .badge').textContent,'AI · 2');
  assert.equal(f.context.chatListRefreshPending,false);
  assertReaderUnchanged(f);
  await f.context.refresh();
  assert.equal(f.node('#chat-list').writes,1,'Unchanged discovery does not rebuild the list');
  assert.equal(f.requests.filter(request=>request.path.endsWith('/chats')).length,1);
});

test('deferred discovery survives consumed timestamps and flushes when requests finish',async()=>{
  for(const blocked of ['reading','sending']){
    const f=fixture();
    f.context[blocked]=true;
    await f.context.refresh();
    assert.equal(f.context.chatListRefreshPending,true,blocked);
    assert.equal(f.node('#chat-list').writes,0,blocked);
    f.context[blocked]=false;
    await f.context.refresh();
    assert.match(f.node('#chat-list').innerHTML,/New room/,blocked);
    assert.equal(f.context.chatListRefreshPending,false,blocked);
    assert.equal(f.requests.filter(request=>request.path.endsWith('/chats')).length,1,blocked);
    assertReaderUnchanged(f);
  }
});

test('discovery updates while typing without replacing the compose field or handling blur',async()=>{
  const f=fixture();f.node('#send-form textarea').focused=true;
  const compose=f.node('#send-form textarea');
  await f.context.refresh();
  assert.match(f.node('#chat-list').innerHTML,/New room/);
  assert.equal(f.node('#send-form textarea'),compose);
  assert.equal(compose.focused,true);
  assert.equal(f.context.chatListRefreshPending,false);
  assert.equal(source.includes("$('#chat-pane').addEventListener('focusout'"),false,'Blur must not replace a sidebar click target');
  assert.equal(f.requests.length,2);
  assertReaderUnchanged(f);
});

test('discovery on another page is applied when returning to the existing account reader',async()=>{
  const f=fixture();f.context.currentPage='setup';
  await f.context.refresh();
  assert.equal(f.context.chatListRefreshPending,true);
  assert.equal(f.node('#chat-list').writes,0);
  f.context.switchTab('accounts');
  assert.match(f.node('#chat-list').innerHTML,/New room/);
  assert.equal(f.requests.length,2);
  assertReaderUnchanged(f);
});
