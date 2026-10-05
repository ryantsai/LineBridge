import {createConnections,providerName} from './connections.js';
import { sendIntent } from './send-intent.js';
import {label,errorText,coverage} from './locale.js';
import {icon} from './icons.js';
import {accountName,chatName,senderName} from './names.js';
import {createWizard} from './wizard.js';
import {createArchive} from './archive.js';
import {aiInstructionsCard,renderAiInstructions} from './ai-instructions.js';
const $=selector=>document.querySelector(selector);
const escape=value=>String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const nice=label;
const when=value=>value?new Date(value).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false}): '—';
let state,selectedAccount,selectedChat,chats=[],loginAccount,loginTimer,toastTimer,sendAttempt,chatFilter='all',chatSearch='';
let refreshRunning=false,reading=false,sending=false;
let refreshTimer,refreshIntervalSeconds=60,refreshSettingsVersion;
let currentPage='setup',monitorAccount=null,monitorReading=false,monitorVersion='',monitorOptions='',accountOptions='';
const observedSequences=new Map();
const observedDiscoveries=new Map();
async function api(path,options={}) {
  const res=await fetch(`/admin${path}`,{...options,headers:{'Content-Type':'application/json','X-Line-Bridge':'dashboard',...options.headers}});
  const result=await res.json();if(!res.ok){const error=new Error(errorText(result.error,result.message));error.code=result.error;throw error;}return result;
}
function toast(message,error=false) {const el=$('#toast');el.textContent=message;el.classList.toggle('error',error);el.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{el.hidden=true;},error?9000:4500);}
async function action(job){try{return await job();}catch(error){toast(error.message,true);}}
function badge(text,kind=''){return `<span class="badge ${kind}">${escape(text)}</span>`;}
function accountStatus(a){return a.status==='connected'&&a.accountHealth?.status==='retrying'?'帳號驗證重試中':a.status==='connected'&&a.accountHealth?.status==='checking'?'帳號驗證中':nice(a.status);}
function statusBadge(a){return badge(a.kind==='demo'?'沙盒':accountStatus(a),a.status==='connected'&&(!a.accountHealth||a.accountHealth.status==='healthy')?'good':a.status==='error'?'danger':'warn');}
function configureRefreshTimer(seconds=60){
  if(refreshTimer&&seconds===refreshIntervalSeconds)return;
  clearInterval(refreshTimer);refreshIntervalSeconds=seconds;
  refreshTimer=setInterval(()=>{void refresh();},seconds*1000);
}
function renderRefreshSettings(){
  const settings=state.refresh,field=$('#refresh-interval');
  configureRefreshTimer(settings.intervalSeconds);
  if(refreshSettingsVersion!==settings.intervalSeconds&&!field.matches(':focus')){field.value=settings.intervalSeconds;refreshSettingsVersion=settings.intervalSeconds;}
  field.min=settings.minSeconds;field.max=settings.maxSeconds;
  $('#refresh-summary').textContent=`追蹤指定聊天室的新訊息，自動更新間隔為 ${settings.intervalSeconds} 秒。`;
}
function renderAccountHealth(a){
  const notice=$('#account-health-notice');if(notice){notice.hidden=!a.error;notice.textContent=a.error==='health_check_failed'?'帳號驗證暫時失敗，將自動重試。各聊天室的接收狀態請查看訊息監控。':a.error?`${nice(a.error)}。請恢復連線以驗證工作階段。`:'';}
  const checked=$('#account-last-checked');if(checked)checked.textContent=when(a.lastChecked);
}
function switchTab(tab){
  currentPage=tab;document.body.dataset.page=tab;
  document.querySelectorAll('.nav').forEach(e=>{e.classList.toggle('active',e.dataset.tab===tab);if(e.dataset.tab===tab)e.setAttribute('aria-current','page');else e.removeAttribute('aria-current');});
  document.querySelectorAll('.page').forEach(e=>e.classList.toggle('active',e.id===tab));
  $('#page-title').textContent={setup:'開始設定',monitoring:'訊息監控',archive:'封存搜尋',accounts:'帳號與聊天室',access:'API 金鑰與 AI 存取',tunnel:'雲端連線與通道',activity:'活動紀錄'}[tab];
  $('#breadcrumb-page').textContent=$('#page-title').textContent;
  $('#page-description').textContent={setup:'連接帳號、選擇聊天室，並確認 AI 讀取與傳送權限。',monitoring:'每一則新訊息，都在你的掌握之中。',archive:'任何語言的訊息，都能在本機封存中查找。',accounts:'管理你的 LINE 帳號，與你指定的聊天室。',access:'讓 AI 用戶端存取你指定的帳號與聊天室。',tunnel:'透過通道，將這台電腦與雲端 AI 連接。',activity:'查看用戶端的讀取、搜尋、傳送與異動紀錄。'}[tab];
  if(tab==='setup')wizard.render();
  if(tab==='accounts'&&!selectedAccount&&state?.accounts.length)action(async()=>{selectedAccount=state.accounts[0].id;await loadChats();renderAccounts();});
  if(tab==='monitoring'){monitorAccount=monitorAccount||selectedAccount;renderMonitoring();action(()=>refreshMonitorFeed(true));}
}
document.querySelectorAll('[data-tab]').forEach(e=>{e.setAttribute('aria-label',e.textContent.trim());e.title=e.textContent.trim();e.addEventListener('click',()=>switchTab(e.dataset.tab));});
document.querySelectorAll('[data-close]').forEach(e=>e.addEventListener('click',()=>{$(`#${e.dataset.close}`).close();if(e.dataset.close==='account-dialog')wizard.cancelNewAccount();if(e.dataset.close==='secret-dialog')$('#new-secret').value='';}));
$('#secret-dialog').addEventListener('close',()=>{$('#new-secret').value='';});
document.querySelectorAll('.dialog-heading button').forEach(e=>{e.innerHTML=icon('x');});
$('#new-token').innerHTML=icon('plus')+'建立遠端權杖';
const wizard=createWizard({escape,action,nice,getState:()=>state,getSelected:()=>selectedAccount,
  select:async id=>{selectedAccount=id;selectedChat=null;sendAttempt=null;await loadChats();renderAccounts();},
  tryDemo,
  getChats:()=>chats,
  openChat:()=>$('#chat-dialog').showModal(),
  discover:async id=>{const data=await api(`/accounts/${id}/discover`,{method:'POST',body:'{}'});if(id===selectedAccount){chats=data.chats;renderAccountPane();}if(data.warnings.length)toast('部分聊天室探索未完成，請確認清單或新增已知聊天室。',true);await refresh();return data.chats;},
  enable:async(id,body)=>{try{await api(`/accounts/${id}/local-setup`,{method:'POST',body:JSON.stringify(body)});}finally{await refresh();await loadChats();}},
  revoke:async id=>{await api(`/accounts/${id}/local-setup`,{method:'DELETE'});await refresh();await loadChats();},
  openAccount:()=>{$('#account-form').elements.kind.value='line';$('#account-dialog').showModal();},
  connect:async qr=>{const a=state.accounts.find(a=>a.id===selectedAccount);if(a.kind==='demo'||!qr)await reconnect();else await login(a.id);},
  go:tab=>{if(tab==='monitoring')monitorAccount=selectedAccount;switchTab(tab);}
});
const archive=createArchive({api,action,escape,when,getState:()=>state,openChat:async(id,chat)=>{selectedAccount=id;selectedChat=chat;chatFilter='all';chatSearch='';sendAttempt=null;switchTab('accounts');await loadChats();renderAccounts();}});
$('#access-ai-instructions').innerHTML=aiInstructionsCard('access-ai-prompt');
document.body.dataset.page='setup';wizard.render();
$('#account-dialog').addEventListener('cancel',()=>wizard.cancelNewAccount());

async function refresh(){
  if(refreshRunning)return;refreshRunning=true;
  try {
    state=await api('/state');$('#service-error').hidden=true;$('#local-status-dot').classList.remove('offline');$('#local-status-text').textContent='本機服務運作中';
    $('#metric-accounts').textContent=state.accounts.filter(a=>a.status==='connected'&&a.kind==='line').length;
    const demos=state.accounts.filter(a=>a.kind==='demo').length;
    $('#metric-account-detail').textContent=`${state.accounts.filter(a=>a.kind==='line').length} 個 LINE 帳號${demos?` · ${demos} 個沙盒`:''}`;
    const local=state.gateway.authentication==='local',localAccounts=state.accounts.filter(a=>a.designatedChats&&(a.localAccess?.read||a.localAccess?.send));
    $('#metric-tokens').textContent=local?'免權杖':state.tokens.filter(t=>!t.revoked&&Date.parse(t.expires_at)>Date.now()).length;
    $('#metric-access-detail').textContent=local?`${localAccounts.length} 個指定帳號 · 本機 AI`:'有效的遠端權杖';
    $('#metric-tunnel').textContent=state.tunnel.connected?'已連線':'未連線';$('#metric-tunnel').className=`text-status ${state.tunnel.connected?'good':'warn'}`;
    $('#metric-tunnel-detail').textContent=providerName(state.tunnel.provider);
    $('#metric-gateway').textContent=state.gateway.enabled?'可使用':'已暫停';$('#metric-gateway').className=`text-status ${state.gateway.enabled?'good':'warn'}`;
    $('#pause').textContent=state.gateway.enabled?'暫停':'恢復';$('#vault-detail').textContent=`本機 SQLite · ${state.vault}`;
    const selected=state.accounts.find(a=>a.id===selectedAccount);
    if(selected?.discovery&&observedDiscoveries.get(selected.id)!==selected.discovery.at){
      const next=await api(`/accounts/${selected.id}/chats`);
      if(selected.id===selectedAccount){
        observedDiscoveries.set(selected.id,selected.discovery.at);
        if(JSON.stringify(next)!==JSON.stringify(chats)){
          chats=next;
          if(currentPage==='accounts'&&!reading&&!sending&&!$('#send-form textarea')?.matches(':focus'))renderAccountPane();
        }
      }
    }
    renderRefreshSettings();renderAccounts();renderLocalAccess();renderTokens();renderAudit();renderTunnel();renderMonitoring();archive.render();wizard.sync();renderAiInstructions($('#access-ai-instructions'),state,null,action);
    const base=state.tunnel.url || `http://127.0.0.1:${state.gateway.port}`;
    $('#mcp-url').textContent=`${base}/mcp`;$('#api-url').textContent=`${base}/openapi.json`;
    if(selectedAccount&&!state.accounts.some(a=>a.id===selectedAccount)){selectedAccount=null;selectedChat=null;chats=[];renderAccountPane();}
    const a=state.accounts.find(a=>a.id===selectedAccount);if(a){const sequence=a.monitor?.lastSequence || 0,previous=observedSequences.get(a.id),editing=$('#send-form textarea')?.matches(':focus');if(currentPage==='accounts'&&previous!==undefined&&sequence>previous&&selectedChat&&!reading&&!sending&&!editing)await readMessages();if(!reading&&!sending&&!editing&&currentPage==='accounts')observedSequences.set(a.id,sequence);}
    if(currentPage==='monitoring')await refreshMonitorFeed();
  }catch(error){$('#service-error').textContent=`管理服務暫時無法使用： ${error.message}`;$('#service-error').hidden=false;$('#local-status-dot').classList.add('offline');$('#local-status-text').textContent='本機服務暫時無法使用';}finally{refreshRunning=false;}
}
$('#refresh').addEventListener('click',()=>action(async()=>{await refresh();if(selectedAccount)await loadChats();}));
$('#refresh-settings-form').addEventListener('submit',event=>{
  event.preventDefault();action(async()=>{
    const button=$('#save-refresh-settings');button.disabled=true;
    try{const settings=await api('/refresh-settings',{method:'PUT',body:JSON.stringify({intervalSeconds:Number($('#refresh-interval').value)})});state.refresh=settings;renderRefreshSettings();$('#refresh-settings-status').textContent=`已儲存：每 ${settings.intervalSeconds} 秒自動更新。`;}
    finally{button.disabled=false;}
  });
});
$('#pause').addEventListener('click',()=>action(async()=>{await api('/pause',{method:'POST',body:JSON.stringify({enabled:!state.gateway.enabled})});await refresh();}));
function renderAccounts(){
  $('#account-count').textContent=state.accounts.length;
  const signature=JSON.stringify([selectedAccount,state.accounts.map(a=>[a.id,a.label,a.profile?.displayName,a.kind,a.status,a.accountHealth?.status,a.designatedChats])]);
  if(signature!==accountOptions){
  accountOptions=signature;
  $('#account-list').innerHTML=state.accounts.length?state.accounts.map(a=>`<button class="account-item ${selectedAccount===a.id?'selected':''}" data-account="${escape(a.id)}"><span class="avatar">${escape(Array.from(accountName(a))[0])}</span><span class="account-info"><strong>${escape(accountName(a))}</strong><small class="${a.kind==='demo'?'demo-text':''}">${a.kind==='demo'?'模擬沙盒':escape(accountStatus(a))} · ${a.designatedChats} 個指定聊天室</small></span></button>`).join(''):'<div class="chat-placeholder">尚未新增帳號</div>';
  document.querySelectorAll('[data-account]').forEach(e=>e.addEventListener('click',()=>action(async()=>{selectedAccount=e.dataset.account;selectedChat=null;sendAttempt=null;await loadChats();renderAccounts();})));
  }
  if(selectedAccount){const a=state.accounts.find(a=>a.id===selectedAccount);if(a){const el=$('#selected-status');if(el)el.innerHTML=statusBadge(a);renderAccountHealth(a);renderDiscoveryNotice(a);}}
}
function renderDiscoveryNotice(account){
  const el=$('#discovery-notice');if(!el)return;
  const d=account.discovery;
  el.hidden=!d;
  if(d){const s=d.stages ?? {},parts=['groups','direct','openchat'].filter(k=>s[k]).map(k=>`${k==='openchat'?'OpenChat':k==='direct'?'聯絡人':'群組'}: ${s[k].status!=='failed'?s[k].count+' 個'+(s[k].status==='partial'?'（部分）':''):'探索失敗（'+s[k].errorCode+'）'}`);el.textContent=parts.join(' · ') || d.warnings.join(' ');el.classList.toggle('discovery-error',!!d.warnings.length);}
}
async function loadChats(){const id=selectedAccount;const result=await api(`/accounts/${id}/chats`);if(id!==selectedAccount)return;chats=result;observedDiscoveries.set(id,state?.accounts.find(a=>a.id===id)?.discovery?.at);if(selectedChat&&!chats.some(c=>c.id===selectedChat))selectedChat=null;renderAccountPane();if(selectedChat)await readMessages();}
function renderAccountPane(){
  const a=state?.accounts.find(a=>a.id===selectedAccount);if(!a){$('#chat-pane').innerHTML=`<div class="empty"><span class="empty-icon">${icon('users')}</span><h3>選擇或新增帳號</h3><p>帳號工作區會顯示在這裡。</p></div>`;return;}

  $('#chat-pane').innerHTML=`<div class="account-head"><div><h3>${escape(accountName(a))} <span id="selected-status">${statusBadge(a)}</span></h3><p>${a.kind==='demo'?'模擬帳號 · 不會連線至 LINE':`${escape(a.profile?.displayName || nice(a.device))} · 最後驗證：<span id="account-last-checked">${escape(when(a.lastChecked))}</span>`}</p></div><div class="button-row">${a.status!=='connected'?'<button class="button tiny" id="connect-account">'+(a.kind==='demo'?'重新連線':'使用 QR Code 連線')+'</button>':'<button class="button tiny" id="disconnect-account">中斷連線</button>'}<button class="button tiny danger" id="remove-account">移除</button></div></div><div class="notice account-error" id="account-health-notice" hidden></div><div class="chat-tools"><label class="sr-only" for="chat-search">搜尋聊天室名稱或 ID</label><input id="chat-search" type="search" placeholder="搜尋聊天室名稱或 ID…" value="${escape(chatSearch)}"><button class="button" id="discover-chats" ${a.status!=='connected'?'disabled':''}>探索聊天室</button><button class="button" id="add-chat">新增已知聊天室</button><select id="chat-filter" aria-label="聊天室類型">${[["all","所有聊天室"],["group","群組"],["direct","聯絡人"],["openchat","OpenChat"]].map(([kind,label])=>`<option value="${kind}" ${chatFilter===kind?"selected":""}>${label} (${chats.filter(c=>kind==="all"||c.kind===kind).length})</option>`).join("")}</select><span class="badge">${chats.filter(c=>c.enabled).length} 個開放給 AI</span></div><div class="chat-access-help"><span id="chat-search-count" role="status" aria-live="polite"></span> · 勾選允許 AI 存取的聊天室。本機讀取與手動傳送不受 AI 存取開關限制。</div><div class="notice discovery-notice" id="discovery-notice" hidden></div><div class="chat-layout"><div class="chat-list" id="chat-list"></div><div class="chat-reader" id="reader">${selectedChat?'<p class="muted">正在讀取訊息…</p>':'<div class="chat-placeholder">選擇聊天室以檢視訊息。<p class="muted">勾選聊天室即可開放給 AI 存取。</p></div>'}</div></div>`;
  renderAccountHealth(a);renderDiscoveryNotice(a);
  $('#discover-chats').insertAdjacentHTML('afterbegin',icon('arrows-clockwise'));
  $('#add-chat').insertAdjacentHTML('afterbegin',icon('plus'));
  $('#connect-account')?.addEventListener('click',()=>action(()=>a.kind==='demo'?reconnect():login(a.id)));
  if(a.status!=='connected' && a.kind==='line' && a.canResume){const button=document.createElement('button');button.className='button tiny';button.textContent='恢復已儲存的工作階段';button.addEventListener('click',()=>action(reconnect));$('.account-head .button-row').prepend(button);}
  $('#disconnect-account')?.addEventListener('click',()=>action(async()=>{await api(`/accounts/${a.id}/disconnect`,{method:'POST',body:'{}'});await refresh();await loadChats();}));
  $('#remove-account').addEventListener('click',()=>action(async()=>{if(!confirm(`移除「${a.label}」及其已儲存的登入憑證？`))return;await api(`/accounts/${a.id}`,{method:'DELETE'});selectedAccount=null;selectedChat=null;chats=[];$('#chat-pane').innerHTML='<div class="empty"><h3>選擇或新增帳號</h3><p>帳號工作區會顯示在這裡。</p></div>';await refresh();}));
  $('#discover-chats').addEventListener('click',()=>action(async()=>{$('#discover-chats').disabled=true;const result=await api(`/accounts/${a.id}/discover`,{method:'POST',body:'{}'});chats=result.chats;toast(`找到 ${chats.length} 個聊天室${result.warnings.length?'；部分探索失敗，請查看上方狀態。':''}`,!!result.warnings.length);await refresh();renderAccountPane();}));
  $('#chat-filter').addEventListener('change',event=>{chatFilter=event.target.value;if(!chats.some(c=>c.id===selectedChat&&(chatFilter==='all'||c.kind===chatFilter))){selectedChat=null;sendAttempt=null;}renderAccountPane();if(selectedChat)action(readMessages);});
  $('#add-chat').addEventListener('click',()=>$('#chat-dialog').showModal());
  $('#chat-search').addEventListener('input',event=>{chatSearch=event.target.value;renderChatList();});
  renderChatList();
}
function renderChatList(){
  const target=$('#chat-list'),a=state?.accounts.find(a=>a.id===selectedAccount);if(!target||!a)return;
  const normalize=value=>String(value??'').normalize('NFKC').toLocaleLowerCase();
  const terms=normalize(chatSearch).trim().split(/\s+/).filter(Boolean);
  const visibleChats=chats.filter(c=>(chatFilter==='all'||c.kind===chatFilter)&&terms.every(term=>normalize(chatName(c)+' '+c.id).includes(term)));
  $('#chat-search-count').textContent=`顯示 ${visibleChats.length} / ${chats.length} 個聊天室`;
  target.innerHTML=visibleChats.length?visibleChats.map(c=>`<div class="chat-item ${selectedChat===c.id?'selected':''}" data-chat="${escape(c.id)}" role="button" tabindex="0"><label class="checkbox-label" title="開放給 AI 存取"><input type="checkbox" data-designate="${escape(c.id)}" aria-label="允許 AI 存取：${escape(chatName(c))}" ${c.enabled?'checked':''}></label><div><strong>${escape(chatName(c))}</strong><small>${escape(c.kind==='openchat'?'OpenChat · 實驗性支援':nice(c.kind))} · ${c.enabled?'AI 已啟用':'AI 存取已關閉'}</small></div></div>`).join(''):chats.length?'<div class="chat-placeholder">沒有符合搜尋或類型的聊天室。<br><button class="text-button" id="clear-chat-search">清除搜尋與類型篩選</button></div>':'<div class="chat-placeholder">連線後按下「探索聊天室」，<br>或新增已知的聊天室 ID。</div>';
  $('#clear-chat-search')?.addEventListener('click',()=>{chatSearch='';chatFilter='all';$('#chat-search').value='';$('#chat-filter').value='all';renderChatList();$('#chat-search').focus();});
  target.querySelectorAll('[data-chat]').forEach(el=>{const select=()=>action(async()=>{if(reading||sending)return;selectedChat=el.dataset.chat;sendAttempt=null;renderChatList();$('#reader').innerHTML='<p class="muted">正在讀取訊息…</p>';await readMessages();});el.addEventListener('click',event=>{if(!event.target.closest('label'))select();});el.addEventListener('keydown',event=>{if(event.target===el&&(event.key==='Enter'||event.key===' ')){event.preventDefault();select();}});});
  document.querySelectorAll('[data-designate]').forEach(el=>el.addEventListener('change',()=>action(async()=>{try{await api(`/accounts/${a.id}/chats/${encodeURIComponent(el.dataset.designate)}`,{method:'PATCH',body:JSON.stringify({enabled:el.checked})});const chat=chats.find(c=>c.id===el.dataset.designate);chat.enabled=el.checked?1:0;toast(el.checked?'已開放此聊天室給 AI':'已移除此聊天室的 AI 存取權限');renderAccountPane();if(selectedChat)await readMessages();await refresh();}catch(error){el.checked=!el.checked;throw error;}})));
}
async function reconnect(){await api(`/accounts/${selectedAccount}/reconnect`,{method:'POST',body:'{}'});await refresh();await loadChats();}
function renderMonitoring(){
  if(!state)return;
  if(!state.accounts.some(a=>a.id===monitorAccount)){monitorAccount=selectedAccount || state.accounts[0]?.id || null;monitorVersion='';}
  const options=JSON.stringify(state.accounts.map(a=>[a.id,accountName(a)]));
  if(options!==monitorOptions){$('#monitor-account').innerHTML=state.accounts.length?state.accounts.map(a=>`<option value="${escape(a.id)}">${escape(accountName(a))}${a.kind==='demo'?' · 沙盒':''}</option>`).join(''):'<option value="">尚未新增帳號</option>';monitorOptions=options;}
  $('#monitor-account').value=monitorAccount || '';
  const a=state.accounts.find(a=>a.id===monitorAccount),m=a?.monitor ?? {enabled:false,status:'off',storedMessages:0};
  $('#monitor-account-name').textContent=a?accountName(a):'尚未新增帳號';
  $('#toggle-monitor').textContent=m.enabled?'停止監聽':'開始監聽';$('#toggle-monitor').disabled=!a||(!m.enabled&&a.status!=='connected');
  $('#monitor-detail').textContent=a?`${nice(a.status==='connected'?m.status:m.enabled?'disconnected':'off')} · ${a.designatedChats} 個指定聊天室${a.localSetup?.grantActive&&a.localSetup.autoMonitorNewChats?' · 自動監控新聊天室':''} · 已儲存 ${m.storedMessages || 0} 則${m.lastMessage?` · 最新 ${when(m.lastMessage)}`:''}`:'前往「開始設定」連接帳號。';
  const streams=Array.isArray(m.streams)?m.streams:Object.values(m.streams ?? {});
  const healthLabel={healthy:'輪詢正常',stale:`超過 ${(m.staleAfterMs??120000)/1000} 秒未成功`,waiting:'等待首次成功',initializing:'建立起始位置',retrying:'重試中',disconnected:'帳號未連線',off:'已停止',sandbox:'模擬沙盒',no_chats:'尚未指定聊天室'};
  $('#monitor-streams').innerHTML=streams.map(s=>`<div class="monitor-stream-health">${badge(`${s.channel==='talk'?'一對一與群組':s.channel==='demo'?'沙盒':'OpenChat'} · ${healthLabel[s.health]||nice(s.status)}`,s.health==='healthy'?'good':['stale','retrying','disconnected'].includes(s.health)?'warn':'')}<span>最後成功輪詢：${s.lastSuccessAt?escape(when(s.lastSuccessAt)):s.channel==='demo'?'沙盒不輪詢 LINE':'尚無成功紀錄'}</span>${s.lastAttemptAt?`<small>最後嘗試：${escape(when(s.lastAttemptAt))}</small>`:''}${s.channel!=='talk'&&s.channel!=='demo'?`<small>${escape(s.channel)}</small>`:''}</div>`).join('')||`<p>${healthLabel[m.health]||'尚未開始輪詢'}</p>`;
  if(!a)$('#monitor-feed').innerHTML='<div class="empty"><h3>連接你的第一個帳號</h3><p>完成設定後，就能在這裡查看指定聊天室的新訊息。</p></div>';
}
async function refreshMonitorFeed(force=false){
  const id=monitorAccount,a=state?.accounts.find(a=>a.id===id);if(!a||monitorReading)return;
  const version=JSON.stringify([id,a.monitor?.lastSequence,a.designatedChats,a.status]);if(!force&&version===monitorVersion)return;
  monitorReading=true;
  try{
    const after=Math.max(0,(a.monitor?.lastSequence || 0)-100);
    const [data,rooms]=await Promise.all([api(`/accounts/${id}/events?after=${after}&limit=100`),api(`/accounts/${id}/chats`)]);
    if(id!==monitorAccount)return;
    const list=data.events.slice().reverse();
    $('#monitor-feed').innerHTML=list.length?list.map(event=>{const chat=rooms.find(c=>c.id===event.chatId),message=event.message,name=senderName(message,a,chat);return `<div class="feed-item"><span class="avatar">${escape(Array.from(name)[0])}</span><div class="feed-content"><div class="feed-heading"><strong>${escape(name)}</strong><button class="text-button" data-open-chat="${escape(event.chatId)}">${escape(chatName(chat))}${icon('caret-right')}</button></div><div class="feed-text">${escape(message.unavailableReason?'無法解密此訊息，內容未顯示。':message.text || `[${message.contentType || '非文字'} 訊息]`)}</div><div class="feed-time">${escape(when(message.timestamp || event.receivedAt))}</div></div></div>`;}).join(''):`<div class="empty"><span class="empty-icon">${icon('chats-circle')}</span><h3>${a.monitor?.enabled?'正在等候新訊息':'訊息會顯示在這裡'}</h3><p>${a.kind==='demo'?'可以到沙盒聊天室手動傳送訊息，體驗本機收件匣。':'啟用監聽後，指定聊天室的新訊息會儲存到本機的加密收件匣。'}</p></div>`;
    $('#monitor-feed').querySelectorAll('[data-open-chat]').forEach(el=>el.addEventListener('click',()=>action(async()=>{selectedAccount=id;selectedChat=el.dataset.openChat;sendAttempt=null;switchTab('accounts');await loadChats();renderAccounts();})));
    monitorVersion=version;
  }catch(error){if(id===monitorAccount)$('#monitor-feed').innerHTML=`<div class="empty"><h3>暫時無法讀取收件匣</h3><p>${escape(error.message)}</p></div>`;}
  finally{monitorReading=false;}
}
$('#monitor-account').addEventListener('change',()=>{monitorAccount=$('#monitor-account').value;monitorVersion='';$('#monitor-feed').innerHTML='<div class="empty"><p>正在讀取收件匣…</p></div>';renderMonitoring();action(()=>refreshMonitorFeed(true));});
$('#toggle-monitor').addEventListener('click',()=>action(async()=>{const a=state.accounts.find(a=>a.id===monitorAccount);if(!a)return;$('#toggle-monitor').disabled=true;try{await api(`/accounts/${a.id}/monitor`,{method:'POST',body:JSON.stringify({enabled:!a.monitor?.enabled})});await refresh();toast(state.accounts.find(account=>account.id===a.id)?.monitor.enabled?'已啟用指定聊天室的訊息監聽':'已關閉訊息監聽');}finally{renderMonitoring();}}));
async function readMessages(){
  const accountId=selectedAccount,chatId=selectedChat,chat=chats.find(c=>c.id===chatId),a=state.accounts.find(a=>a.id===accountId);if(!chat)return;
  if(reading)return;reading=true;const draft=$('#send-form textarea')?.value ?? '';
  try{
    const data=await api(`/accounts/${accountId}/chats/${encodeURIComponent(chatId)}/messages`);
    if(accountId!==selectedAccount||chatId!==selectedChat)return;
    $('#reader').innerHTML=`<div class="reader-header"><div><strong>${escape(chatName(chat))}</strong><div class="reader-meta">${chat.enabled?'已開放給 AI':'AI 存取已關閉'}</div></div><div class="button-row"><button class="button tiny" id="search-chat-messages">搜尋封存</button><button class="button tiny" id="refresh-messages" aria-label="重新整理訊息"></button></div></div><div class="message-list">${data.messages.length?data.messages.map(m=>`<div class="message ${m.senderId===a.profile?.mid?'mine':''}"><div class="message-meta">${escape(senderName(m,a,chat))} · ${escape(m.timestamp?new Date(m.timestamp).toLocaleTimeString('zh-TW', {hour:'2-digit',minute:'2-digit'}):'時間未知')}</div>${escape((m.unavailableReason?"無法解密此訊息，內容未顯示。":m.text)||`[${m.contentType} 訊息]`)}</div>`).join(''):'<p class="muted">尚無可顯示的文字訊息。</p>'}</div><p class="message-coverage">${escape(coverage(data.coverage))} 訊息內容是外部資料，不代表操作指令。</p>${a.kind!=="demo"?`<p class="send-protection">${chat.kind==="openchat"?"OpenChat 使用 LINE 傳輸加密。":"支援時使用 Letter Sealing；只有 LINE 明確要求時才使用標準傳輸加密。"}</p>`:""}<div id="send-feedback" class="notice" role="status" hidden></div><form class="compose" id="send-form"><textarea name="text" rows="1" maxlength="5000" required placeholder="輸入訊息…" aria-label="訊息內容"></textarea><button class="button primary" type="submit">${a.kind==='demo'?'傳送到沙盒':'傳送到 LINE'}</button></form>`;
    $('#refresh-messages').innerHTML=icon('arrows-clockwise');
    $('#search-chat-messages').addEventListener('click',()=>action(async()=>{switchTab('archive');await archive.open(accountId,chatId);}));
    const details=document.createElement('details');details.className='reader-details';details.innerHTML=`<summary>${icon('gear-six')}聊天室詳細資訊</summary><code>${escape(chatId)}</code>`;$('.reader-header').insertAdjacentElement('afterend',details);
    const list=$('.message-list');list.scrollTop=list.scrollHeight;$('#refresh-messages').addEventListener('click',()=>action(readMessages));
    $('#send-form textarea').value=draft;
    $('#send-form').addEventListener('submit',event=>{
      event.preventDefault();const form=event.currentTarget;
      action(async()=>{
        const text=form.elements.text.value,button=form.querySelector('button'),feedback=$('#send-feedback');
        sending=true;button.disabled=true;feedback.hidden=true;sendAttempt=sendIntent(sendAttempt,accountId,chatId,text);
        try{
          const result=await api(`/accounts/${accountId}/chats/${encodeURIComponent(chatId)}/messages`,{method:'POST',body:JSON.stringify({text,idempotencyKey:sendAttempt.key})});
          sendAttempt=null;form.elements.text.value='';toast(result.delivery==='sandbox_only'?'已加入模擬沙盒':'LINE 已接受這則訊息');await readMessages();await refresh();
        }catch(error){
          if(['send_preparation_failed','line_send_rejected'].includes(error.code))sendAttempt=null;
          feedback.textContent=error.message;feedback.hidden=false;throw error;
        }finally{button.disabled=false;sending=false;}
      });
    });
  }catch(error){if(accountId===selectedAccount&&chatId===selectedChat)$('#reader').innerHTML=`<div class="notice">${escape(error.message)}</div>`;}finally{reading=false;}
}

$('#add-account').addEventListener('click',()=>$('#account-dialog').showModal());
$('#account-form').addEventListener('submit',event=>{event.preventDefault();action(async()=>{const form=event.currentTarget,button=form.querySelector('[type=submit]');button.disabled=true;try{const body=Object.fromEntries(new FormData(form));const a=await api('/accounts',{method:'POST',body:JSON.stringify(body)});$('#account-dialog').close();form.reset();selectedAccount=a.id;selectedChat=null;sendAttempt=null;await refresh();await loadChats();wizard.accountAdded();if(a.kind==='line')await login(a.id);}finally{button.disabled=false;}});});
async function tryDemo(){const existing=state?.accounts.find(a=>a.kind==='demo');if(existing){selectedAccount=existing.id;if(existing.status!=='connected')await api(`/accounts/${existing.id}/reconnect`,{method:'POST',body:'{}'});}else{const a=await api('/accounts',{method:'POST',body:JSON.stringify({label:'沙盒帳號',kind:'demo',device:'IOSIPAD'})});selectedAccount=a.id;}selectedChat=null;sendAttempt=null;await refresh();await loadChats();toast('沙盒使用模擬資料，不會連線至 LINE。');}
$('#try-demo').addEventListener('click',()=>action(tryDemo));
$('#chat-form').addEventListener('submit',event=>{event.preventDefault();action(async()=>{await api(`/accounts/${selectedAccount}/chats`,{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(event.currentTarget)))});$('#chat-dialog').close();$('#chat-form').reset();await loadChats();});});
async function login(id){await api(`/accounts/${id}/login`,{method:'POST',body:'{}'});loginAccount=id;$('#login-content').textContent='正在取得 QR Code…';$('#login-dialog').showModal();clearInterval(loginTimer);loginTimer=setInterval(()=>{void pollLogin();},1500);await pollLogin();}
async function pollLogin(){
  if(!loginAccount)return;
  try{const data=await api(`/accounts/${loginAccount}/login`);$('#login-content').innerHTML=data.qr?`<img src="${escape(data.qr)}" alt="LINE 帳號登入 QR Code">${data.pin?`<p>請在手機上確認這組 PIN</p><strong>${escape(data.pin)}</strong>`:''}`:`<p>${escape(nice(data.status))}</p>`;
    if(data.status==='connected'){clearInterval(loginTimer);loginAccount=null;$('#login-dialog').close();toast('LINE 帳號已連線');await refresh();await loadChats();}
    else if(data.status==='error') {clearInterval(loginTimer);$('#login-content').textContent='登入失敗或已過期，請取消後重試。';await refresh();}
  }catch(error){toast(error.message,true);clearInterval(loginTimer);}
}
async function cancelLogin(){clearInterval(loginTimer);if(loginAccount)await api(`/accounts/${loginAccount}/disconnect`,{method:'POST',body:'{}'});loginAccount=null;$('#login-dialog').close();await refresh();if(selectedAccount)await loadChats();}
$('#cancel-login').addEventListener('click',()=>action(cancelLogin));$('#close-login').addEventListener('click',()=>action(cancelLogin));$('#login-dialog').addEventListener('cancel',event=>{event.preventDefault();action(cancelLogin);});

function renderTokens(){
  $('#token-list').innerHTML=state.tokens.length?state.tokens.map(t=>{const expired=Date.parse(t.expires_at)<=Date.now(),active=!t.revoked&&!expired;return `<div class="token-item"><div><strong>${escape(t.name)}</strong> ${badge(t.revoked?'已撤銷':expired?'已過期':'有效',active?'good':'')}<div class="token-meta">${t.grants.map(g=>`${badge(`${state.accounts.find(a=>a.id===g.accountId)?.label||'已移除帳號'} · ${[g.read?'讀取':null,g.send?'傳送':null].filter(Boolean).join(' + ')}`)}`).join('')}</div><p>到期：${escape(when(t.expires_at))} · 最後使用：${escape(when(t.last_used))}</p></div>${active?`<button class="button tiny danger" data-revoke="${escape(t.id)}">撤銷</button>`:''}</div>`;}).join(''):'<div class="token-empty">尚未建立 AI 權杖。建立權杖並提供通道網址，即可授權雲端 AI 存取指定聊天室。</div>';
  document.querySelectorAll('[data-revoke]').forEach(e=>e.addEventListener('click',()=>action(async()=>{await api(`/tokens/${e.dataset.revoke}`,{method:'DELETE'});toast('存取權限已立即撤銷');await refresh();})));
}
let localAccessSignature;
function renderLocalAccess(){
  const local=state.gateway.authentication==='local';
  $('#local-access-panel').hidden=!local;
  $('#local-access-mode').textContent=local?'本機免權杖':'閘道要求權杖';$('#local-access-mode').className=`badge ${local?'good':'warn'}`;
  $('#access-connection-description').textContent=local?'已明確啟用本機開發信任。直接連線不需要驗證標頭；通道連線仍要求權杖。':'提供通道 HTTPS 網址及 Authorization: Bearer 權杖給雲端 AI。讀取與全文搜尋共用帳號的讀取權限。';
  const signature=JSON.stringify(state.accounts.map(a=>[a.id,accountName(a),a.designatedChats,a.localAccess]));if(signature===localAccessSignature)return;localAccessSignature=signature;
  $('#local-access-list').innerHTML=state.accounts.length?state.accounts.map(a=>`<div class="grant-row" data-local-account="${escape(a.id)}"><div><strong>${escape(accountName(a))}</strong><div class="grant-account">${a.designatedChats} 個指定聊天室${a.kind==='demo'?' · 沙盒':''}</div></div><div class="grant-options"><label><input type="checkbox" name="read" ${a.localAccess.read?'checked':''}>讀取</label><label><input type="checkbox" name="send" ${a.localAccess.send?'checked':''}>傳送</label></div></div>`).join(''):'<div class="token-empty">請先連接 LINE 帳號並指定聊天室。不需要建立權杖。</div>';
  document.querySelectorAll('[data-local-account]').forEach(row=>row.querySelectorAll('input').forEach(input=>input.addEventListener('change',()=>action(async()=>{const inputs=[...row.querySelectorAll('input')];inputs.forEach(i=>i.disabled=true);try{await api(`/accounts/${row.dataset.localAccount}/local-access`,{method:'PUT',body:JSON.stringify({read:row.querySelector('[name=read]').checked,send:row.querySelector('[name=send]').checked})});toast('已更新本機 AI 權限');}catch(error){input.checked=!input.checked;throw error;}finally{inputs.forEach(i=>i.disabled=false);await refresh();}}))));
}
function openToken(accountId){if(!state?.accounts.length){toast('請先新增帳號');return;}$('#grant-list').innerHTML=state.accounts.filter(a=>!accountId||a.id===accountId).map(a=>`<div class="grant-row" data-grant="${escape(a.id)}"><div><strong>${escape(accountName(a))}</strong><div class="grant-account">${a.designatedChats} 個指定聊天室 ${a.kind==='demo'?'· 沙盒':''}</div></div><div class="grant-options"><label><input type="checkbox" name="read">讀取</label><label><input type="checkbox" name="send">傳送</label></div></div>`).join('');$('#token-dialog').showModal();}
$('#new-token').addEventListener('click',()=>openToken());
$('#token-form').addEventListener('submit',event=>{event.preventDefault();action(async()=>{const form=event.currentTarget,grants=[...document.querySelectorAll('[data-grant]')].map(e=>({accountId:e.dataset.grant,read:e.querySelector('[name=read]').checked,send:e.querySelector('[name=send]').checked})).filter(g=>g.read||g.send);const data=await api('/tokens',{method:'POST',body:JSON.stringify({name:form.elements.name.value,days:Number(form.elements.days.value),grants})});$('#token-dialog').close();$('#token-form').reset();$('#new-secret').value=data.token;$('#secret-dialog').showModal();await refresh();});});
$('#copy-secret').addEventListener('click',()=>action(async()=>{try{await navigator.clipboard.writeText($('#new-secret').value);}catch{$('#new-secret').select();if(!document.execCommand('copy'))throw new Error('請選取並手動複製權杖。');}toast('已複製權杖');}));
function renderAudit(){
  const actorName=id=>id==='local-admin'?'本機管理介面':id==='local-agent'?'本機 AI':state.tokens.find(t=>t.id===id)?.name||'AI 用戶端';
  $('#audit-list').innerHTML=state.audit.length?state.audit.map(row=>`<tr><td>${escape(when(row.at))}</td><td>${escape(nice(row.action))}</td><td>${escape(state.accounts.find(a=>a.id===row.account_id)?.label||'—')}${row.chat_id?`<small>${escape(row.chat_id.slice(0,20))}</small>`:''}</td><td>${escape(actorName(row.actor))}</td><td>${badge(nice(row.outcome),['ok','enabled'].includes(row.outcome)?'good':['failed','rejected','unknown'].includes(row.outcome)?'danger':'')}</td></tr>`).join(''):'<tr><td colspan="5">尚無閘道活動紀錄。</td></tr>';
}
const connections=createConnections({api,action,toast,refresh,escape,when,getState:()=>state});
function renderTunnel(){connections.render();}
await refresh();configureRefreshTimer(state?.refresh?.intervalSeconds??60);
