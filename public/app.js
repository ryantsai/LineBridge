import { sendIntent } from './send-intent.js';
import {label,errorText,coverage} from './locale.js';
const $=selector=>document.querySelector(selector);
const escape=value=>String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const nice=label;
const when=value=>value?new Date(value).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false}): '—';
let state,selectedAccount,selectedChat,chats=[],loginAccount,loginTimer,toastTimer,lastConfig,sendAttempt,chatFilter='all';
let refreshRunning=false,reading=false,sending=false;
const observedSequences=new Map();
async function api(path,options={}) {
  const invoke=window.__TAURI__?.core?.invoke;
  if(invoke){try{return await invoke('admin_request',{method:options.method || 'GET',path:`/admin${path}`,body:options.body?JSON.parse(options.body):{}});}catch(result){const error=new Error(errorText(result.code || result.error,result.message));error.code=result.code || result.error;throw error;}}
  const res=await fetch(`/admin${path}`,{...options,headers:{'Content-Type':'application/json','X-Line-Bridge':'dashboard',...options.headers}});
  const result=await res.json();if(!res.ok){const error=new Error(errorText(result.error,result.message));error.code=result.error;throw error;}return result;
}
function toast(message,error=false) {const el=$('#toast');el.textContent=message;el.classList.toggle('error',error);el.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{el.hidden=true;},error?9000:4500);}
async function action(job){try{return await job();}catch(error){toast(error.message,true);}}
function badge(text,kind=''){return `<span class="badge ${kind}">${escape(text)}</span>`;}
function statusBadge(a){return badge(a.kind==='demo'?'沙盒':nice(a.status),a.status==='connected'?'good':a.status==='error'?'danger':'warn');}
function switchTab(tab){document.querySelectorAll('.nav').forEach(e=>e.classList.toggle('active',e.dataset.tab===tab));document.querySelectorAll('.page').forEach(e=>e.classList.toggle('active',e.id===tab));$('#page-title').textContent={accounts:'帳號與聊天室',access:'AI 存取權限',tunnel:'私人連線',activity:'活動紀錄'}[tab];$('#page-description').textContent={accounts:'連接 LINE 與雲端 AI，隨時掌握連線狀態。',access:'讓 AI 用戶端存取你指定的帳號與聊天室。',tunnel:'建立雲端 AI 主機與這台電腦之間的受保護連線。',activity:'查看用戶端的讀取、傳送與異動紀錄。'}[tab];}
document.querySelectorAll('[data-tab]').forEach(e=>e.addEventListener('click',()=>switchTab(e.dataset.tab)));
document.querySelectorAll('[data-close]').forEach(e=>e.addEventListener('click',()=>{$(`#${e.dataset.close}`).close();if(e.dataset.close==='secret-dialog')$('#new-secret').value='';}));
$('#secret-dialog').addEventListener('close',()=>{$('#new-secret').value='';});

async function refresh(){
  if(refreshRunning)return;refreshRunning=true;
  try {
    state=await api('/state');$('#service-error').hidden=true;
    $('#metric-accounts').textContent=state.accounts.filter(a=>a.status==='connected'&&a.kind==='line').length;
    const demos=state.accounts.filter(a=>a.kind==='demo').length;
    $('#metric-account-detail').textContent=`${state.accounts.filter(a=>a.kind==='line').length} 個 LINE 帳號${demos?` · ${demos} 個沙盒`:''}`;
    $('#metric-tokens').textContent=state.tokens.filter(t=>!t.revoked&&Date.parse(t.expires_at)>Date.now()).length;
    $('#metric-tunnel').textContent=state.tunnel.connected?'已連線':'未連線';$('#metric-tunnel').className=`text-status ${state.tunnel.connected?'good':'warn'}`;
    $('#metric-tunnel-detail').textContent=state.tunnel.provider==='cloudflare'?'Cloudflare Tunnel + Access':'Tailscale · 私人 tailnet';
    $('#metric-gateway').textContent=state.gateway.enabled?'可使用':'已暫停';$('#metric-gateway').className=`text-status ${state.gateway.enabled?'good':'warn'}`;
    $('#pause').textContent=state.gateway.enabled?'暫停':'恢復';$('#vault-detail').textContent=`本機 SQLite · ${state.vault}`;
    renderAccounts();renderTokens();renderAudit();renderTunnel();
    const base=state.tunnel.url || `http://127.0.0.1:${state.gateway.port}`;
    $('#mcp-url').textContent=`${base}/mcp`;$('#api-url').textContent=`${base}/openapi.json`;
    if(selectedAccount&&!state.accounts.some(a=>a.id===selectedAccount)){selectedAccount=null;selectedChat=null;chats=[];renderAccountPane();}
    const a=state.accounts.find(a=>a.id===selectedAccount);if(a){renderMonitor(a);const sequence=a.monitor?.lastSequence || 0,previous=observedSequences.get(a.id),editing=$('#send-form textarea')?.matches(':focus');if(previous!==undefined&&sequence>previous&&selectedChat&&!reading&&!sending&&!editing)await readMessages();if(!reading&&!sending&&!editing)observedSequences.set(a.id,sequence);}
  }catch(error){$('#service-error').textContent=`管理服務暫時無法使用： ${error.message}`;$('#service-error').hidden=false;}finally{refreshRunning=false;}
}
$('#refresh').addEventListener('click',()=>action(async()=>{await refresh();if(selectedAccount)await loadChats();}));
$('#pause').addEventListener('click',()=>action(async()=>{await api('/pause',{method:'POST',body:JSON.stringify({enabled:!state.gateway.enabled})});await refresh();}));
function renderAccounts(){
  $('#account-count').textContent=state.accounts.length;
  $('#account-list').innerHTML=state.accounts.length?state.accounts.map(a=>`<button class="account-item ${selectedAccount===a.id?'selected':''}" data-account="${escape(a.id)}"><span class="avatar">${escape(a.label.slice(0,1).toUpperCase())}</span><span class="account-info"><strong>${escape(a.label)}</strong><small class="${a.kind==='demo'?'demo-text':''}">${a.kind==='demo'?'模擬沙盒':escape(nice(a.status))} · ${a.designatedChats} 個指定聊天室</small></span></button>`).join(''):'<div class="chat-placeholder">尚未新增帳號</div>';
  document.querySelectorAll('[data-account]').forEach(e=>e.addEventListener('click',()=>action(async()=>{selectedAccount=e.dataset.account;selectedChat=null;sendAttempt=null;await loadChats();renderAccounts();})));
  if(selectedAccount){const a=state.accounts.find(a=>a.id===selectedAccount);if(a){const el=$('#selected-status');if(el)el.innerHTML=statusBadge(a);renderDiscoveryNotice(a);}}
}
function renderDiscoveryNotice(account){
  const el=$('#discovery-notice');if(!el)return;
  const d=account.discovery;
  el.hidden=!d;
  if(d){const s=d.stages ?? {},parts=['groups','direct','openchat'].filter(k=>s[k]).map(k=>`${k==='openchat'?'OpenChat':k==='direct'?'聯絡人':'群組'}: ${s[k].status!=='failed'?s[k].count+' 個'+(s[k].status==='partial'?'（部分）':''):'探索失敗（'+s[k].errorCode+'）'}`);el.textContent=parts.join(' · ') || d.warnings.join(' ');el.classList.toggle('discovery-error',!!d.warnings.length);}
}
async function loadChats(){const id=selectedAccount;const result=await api(`/accounts/${id}/chats`);if(id!==selectedAccount)return;chats=result;if(selectedChat&&!chats.some(c=>c.id===selectedChat))selectedChat=null;renderAccountPane();if(selectedChat)await readMessages();}
function renderAccountPane(){
  const a=state?.accounts.find(a=>a.id===selectedAccount);if(!a)return;
  const visibleChats=chats.filter(c=>chatFilter==='all'||c.kind===chatFilter);
  $('#chat-pane').innerHTML=`<div class="account-head"><div><h3>${escape(a.label)} <span id="selected-status">${statusBadge(a)}</span></h3><p>${a.kind==='demo'?'模擬帳號 · 不會連線至 LINE':`${escape(a.profile?.displayName || nice(a.device))} · 最後驗證：${escape(when(a.lastChecked))}`}</p></div><div class="button-row">${a.status!=='connected'?'<button class="button tiny" id="connect-account">'+(a.kind==='demo'?'重新連線':'使用 QR Code 連線')+'</button>':'<button class="button tiny" id="disconnect-account">中斷連線</button>'}<button class="button tiny danger" id="remove-account">移除</button></div></div>${a.error?`<div class="notice account-error">${escape(nice(a.error))}。請恢復連線以驗證工作階段。</div>`:''}<div class="chat-tools"><button class="button" id="discover-chats" ${a.status!=='connected'?'disabled':''}>↻ 探索聊天室</button><button class="button" id="add-chat">＋ 新增已知聊天室</button><select id="chat-filter" aria-label="聊天室類型">${[["all","所有聊天室"],["group","群組"],["direct","聯絡人"],["openchat","OpenChat"]].map(([kind,label])=>`<option value="${kind}" ${chatFilter===kind?"selected":""}>${label} (${chats.filter(c=>kind==="all"||c.kind===kind).length})</option>`).join("")}</select><span class="badge">${chats.filter(c=>c.enabled).length} 個開放給 AI</span></div><div class="chat-access-help">勾選允許 AI 存取的聊天室。本機讀取與手動傳送不受 AI 存取開關限制。</div><div class="notice discovery-notice" id="discovery-notice" hidden></div><div class="chat-layout"><div class="chat-list">${visibleChats.length?visibleChats.map(c=>`<div class="chat-item ${selectedChat===c.id?'selected':''}" data-chat="${escape(c.id)}" role="button" tabindex="0"><label class="checkbox-label" title="開放給 AI 存取"><input type="checkbox" data-designate="${escape(c.id)}" aria-label="允許 AI 存取：${escape(c.name)}" ${c.enabled?'checked':''}></label><div><strong>${escape(c.name)}</strong><small>${escape(c.kind==='openchat'?'OpenChat · 實驗性支援':nice(c.kind))} · ${c.enabled?'AI 已啟用':'AI 存取已關閉'}</small></div></div>`).join(''):'<div class="chat-placeholder">連線後探索聊天室，<br>或新增已知的聊天室 ID。</div>'}</div><div class="chat-reader" id="reader">${selectedChat?'<p class="muted">正在讀取訊息…</p>':'<div class="chat-placeholder">選擇聊天室以檢視訊息。<p class="muted">勾選聊天室即可開放給 AI 存取。</p></div>'}</div></div>`;
  const monitor=document.createElement('div');monitor.className='monitor-bar';monitor.innerHTML='<div><strong>新訊息監聽</strong><p id="monitor-detail"></p></div><button class="button tiny" id="toggle-monitor"></button>';$('.account-head').insertAdjacentElement('afterend',monitor);renderMonitor(a);
  $('#toggle-monitor').addEventListener('click',()=>action(async()=>{await api(`/accounts/${a.id}/monitor`,{method:'POST',body:JSON.stringify({enabled:!state.accounts.find(account=>account.id===a.id).monitor.enabled})});await refresh();toast(state.accounts.find(account=>account.id===a.id).monitor.enabled?'已啟用指定聊天室的訊息監聽':'已關閉訊息監聽');}));
  renderDiscoveryNotice(a);
  $('#connect-account')?.addEventListener('click',()=>action(()=>a.kind==='demo'?reconnect():login(a.id)));
  if(a.status!=='connected' && a.kind==='line' && a.canResume){const button=document.createElement('button');button.className='button tiny';button.textContent='恢復已儲存的工作階段';button.addEventListener('click',()=>action(reconnect));$('.account-head .button-row').prepend(button);}
  $('#disconnect-account')?.addEventListener('click',()=>action(async()=>{await api(`/accounts/${a.id}/disconnect`,{method:'POST',body:'{}'});await refresh();await loadChats();}));
  $('#remove-account').addEventListener('click',()=>action(async()=>{if(!confirm(`移除「${a.label}」及其已儲存的登入憑證？`))return;await api(`/accounts/${a.id}`,{method:'DELETE'});selectedAccount=null;selectedChat=null;chats=[];$('#chat-pane').innerHTML='<div class="empty"><h3>選擇或新增帳號</h3><p>帳號工作區會顯示在這裡。</p></div>';await refresh();}));
  $('#discover-chats').addEventListener('click',()=>action(async()=>{$('#discover-chats').disabled=true;const result=await api(`/accounts/${a.id}/discover`,{method:'POST',body:'{}'});chats=result.chats;toast(`找到 ${chats.length} 個聊天室${result.warnings.length?'；部分探索失敗，請查看上方狀態。':''}`,!!result.warnings.length);await refresh();renderAccountPane();}));
  $('#chat-filter').addEventListener('change',event=>{chatFilter=event.target.value;if(!chats.some(c=>c.id===selectedChat&&(chatFilter==='all'||c.kind===chatFilter))){selectedChat=null;sendAttempt=null;}renderAccountPane();if(selectedChat)action(readMessages);});
  $('#add-chat').addEventListener('click',()=>$('#chat-dialog').showModal());
  document.querySelectorAll('[data-chat]').forEach(el=>{const select=()=>action(async()=>{selectedChat=el.dataset.chat;sendAttempt=null;renderAccountPane();await readMessages();});el.addEventListener('click',event=>{if(!event.target.closest('label'))select();});el.addEventListener('keydown',event=>{if(event.target===el&&(event.key==='Enter'||event.key===' ')){event.preventDefault();select();}});});
  document.querySelectorAll('[data-designate]').forEach(el=>el.addEventListener('change',()=>action(async()=>{try{await api(`/accounts/${a.id}/chats/${encodeURIComponent(el.dataset.designate)}`,{method:'PATCH',body:JSON.stringify({enabled:el.checked})});const chat=chats.find(c=>c.id===el.dataset.designate);chat.enabled=el.checked?1:0;toast(el.checked?'已開放此聊天室給 AI':'已移除此聊天室的 AI 存取權限');renderAccountPane();if(selectedChat)await readMessages();await refresh();}catch(error){el.checked=!el.checked;throw error;}})));
}
async function reconnect(){await api(`/accounts/${selectedAccount}/reconnect`,{method:'POST',body:'{}'});await refresh();await loadChats();}
function renderMonitor(a){const button=$('#toggle-monitor'),detail=$('#monitor-detail');if(!button||!detail)return;const m=a.monitor ?? {enabled:false,status:'off',storedMessages:0};button.textContent=m.enabled?'停止監聽':'開始監聽';button.disabled=!m.enabled&&a.status!=='connected';detail.textContent=`${nice(a.status==='connected'?m.status:m.enabled?'disconnected':'off')} · 僅指定聊天室 · 已儲存 ${m.storedMessages || 0} 則${m.lastMessage?` · 最新 ${when(m.lastMessage)}`:''}`;}
async function readMessages(){
  const accountId=selectedAccount,chatId=selectedChat,chat=chats.find(c=>c.id===chatId),a=state.accounts.find(a=>a.id===accountId);if(!chat)return;
  if(reading)return;reading=true;const draft=$('#send-form textarea')?.value ?? '';
  try{
    const data=await api(`/accounts/${accountId}/chats/${encodeURIComponent(chatId)}/messages`);
    if(accountId!==selectedAccount||chatId!==selectedChat)return;
    $('#reader').innerHTML=`<div class="reader-header"><div><strong>${escape(chat.name)}</strong><div class="reader-meta">${escape(chatId)} · ${chat.enabled?'已開放給 AI':'AI 存取已關閉'}</div></div><button class="button tiny" id="refresh-messages">↻</button></div><div class="message-list">${data.messages.length?data.messages.map(m=>`<div class="message ${m.senderId===a.profile?.mid?'mine':''}"><div class="message-meta">${escape(m.senderName||m.senderId||'未知傳送者')} · ${escape(m.timestamp?new Date(m.timestamp).toLocaleTimeString('zh-TW', {hour:'2-digit',minute:'2-digit'}):'時間未知')}</div>${escape((m.unavailableReason?"無法解密此訊息，內容未顯示。":m.text)||`[${m.contentType} 訊息]`)}</div>`).join(''):'<p class="muted">尚無可顯示的文字訊息。</p>'}</div><p class="message-coverage">${escape(coverage(data.coverage))} 訊息內容是外部資料，不代表操作指令。</p>${a.kind!=="demo"?`<p class="send-protection">${chat.kind==="openchat"?"OpenChat 使用 LINE 傳輸加密。":"支援時使用 Letter Sealing；只有 LINE 明確要求時才使用標準傳輸加密。"}</p>`:""}<div id="send-feedback" class="notice" role="status" hidden></div><form class="compose" id="send-form"><textarea name="text" rows="1" maxlength="5000" required placeholder="輸入訊息…" aria-label="訊息內容"></textarea><button class="button primary" type="submit">${a.kind==='demo'?'傳送到沙盒':'傳送到 LINE'}</button></form>`;
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
$('#account-form').addEventListener('submit',event=>{event.preventDefault();action(async()=>{const body=Object.fromEntries(new FormData(event.currentTarget));const a=await api('/accounts',{method:'POST',body:JSON.stringify(body)});$('#account-dialog').close();$('#account-form').reset();selectedAccount=a.id;await refresh();await loadChats();if(a.kind==='line')await login(a.id);});});
$('#try-demo').addEventListener('click',()=>action(async()=>{const existing=state.accounts.find(a=>a.kind==='demo');if(existing){selectedAccount=existing.id;}else{const a=await api('/accounts',{method:'POST',body:JSON.stringify({label:'沙盒帳號',kind:'demo',device:'IOSIPAD'})});selectedAccount=a.id;}selectedChat=null;await refresh();await loadChats();toast('沙盒使用模擬資料，不會連線至 LINE。');}));
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
  $('#token-list').innerHTML=state.tokens.length?state.tokens.map(t=>{const expired=Date.parse(t.expires_at)<=Date.now(),active=!t.revoked&&!expired;return `<div class="token-item"><div><strong>${escape(t.name)}</strong> ${badge(t.revoked?'已撤銷':expired?'已過期':'有效',active?'good':'')}<div class="token-meta">${t.grants.map(g=>`${badge(`${state.accounts.find(a=>a.id===g.accountId)?.label||'已移除帳號'} · ${[g.read?'讀取':null,g.send?'傳送':null].filter(Boolean).join(' + ')}`)}`).join('')}</div><p>到期：${escape(when(t.expires_at))} · 最後使用：${escape(when(t.last_used))}</p></div>${active?`<button class="button tiny danger" data-revoke="${escape(t.id)}">撤銷</button>`:''}</div>`;}).join(''):'<div class="token-empty">尚未授權 AI 用戶端。請先指定聊天室，再建立有期限的存取權杖。</div>';
  document.querySelectorAll('[data-revoke]').forEach(e=>e.addEventListener('click',()=>action(async()=>{await api(`/tokens/${e.dataset.revoke}`,{method:'DELETE'});toast('存取權限已立即撤銷');await refresh();})));
}
$('#new-token').addEventListener('click',()=>{if(!state.accounts.length){toast('請先新增帳號');return;}$('#grant-list').innerHTML=state.accounts.map(a=>`<div class="grant-row" data-grant="${escape(a.id)}"><div><strong>${escape(a.label)}</strong><div class="grant-account">${a.designatedChats} 個指定聊天室 ${a.kind==='demo'?'· 沙盒':''}</div></div><div class="grant-options"><label><input type="checkbox" name="read">讀取</label><label><input type="checkbox" name="send">傳送</label></div></div>`).join('');$('#token-dialog').showModal();});
$('#token-form').addEventListener('submit',event=>{event.preventDefault();action(async()=>{const form=event.currentTarget,grants=[...document.querySelectorAll('[data-grant]')].map(e=>({accountId:e.dataset.grant,read:e.querySelector('[name=read]').checked,send:e.querySelector('[name=send]').checked})).filter(g=>g.read||g.send);const data=await api('/tokens',{method:'POST',body:JSON.stringify({name:form.elements.name.value,days:Number(form.elements.days.value),grants})});$('#token-dialog').close();$('#token-form').reset();$('#new-secret').value=data.token;$('#secret-dialog').showModal();await refresh();});});
$('#copy-secret').addEventListener('click',()=>action(async()=>{try{await navigator.clipboard.writeText($('#new-secret').value);}catch{$('#new-secret').select();if(!document.execCommand('copy'))throw new Error('請選取並手動複製權杖。');}toast('已複製權杖');}));
function renderAudit(){
  const actorName=id=>id==='local-admin'?'本機管理介面':state.tokens.find(t=>t.id===id)?.name||'AI 用戶端';
  $('#audit-list').innerHTML=state.audit.length?state.audit.map(row=>`<tr><td>${escape(when(row.at))}</td><td>${escape(nice(row.action))}</td><td>${escape(state.accounts.find(a=>a.id===row.account_id)?.label||'—')}${row.chat_id?`<small>${escape(row.chat_id.slice(0,20))}</small>`:''}</td><td>${escape(actorName(row.actor))}</td><td>${badge(nice(row.outcome),['ok','enabled'].includes(row.outcome)?'good':['failed','rejected','unknown'].includes(row.outcome)?'danger':'')}</td></tr>`).join(''):'<tr><td colspan="5">尚無閘道活動紀錄。</td></tr>';
}
function renderTunnel(){
  const t=state.tunnel,config=JSON.stringify([t.provider,t.hostname,t.teamDomain,t.audience]);
  if(lastConfig!==config){const form=$('#tunnel-form');for(const key of ['provider','hostname','teamDomain','audience'])form.elements[key].value=t[key]||'';lastConfig=config;updateProvider();}
  $('#tunnel-badge').className=`badge ${t.connected?'good':'warn'}`;$('#tunnel-badge').textContent=t.connected?'已連線':t.hostname?'已設定 · 尚未連線':'尚未設定';
  $('#tunnel-health').textContent=t.provider==='cloudflare'?`連接器：${t.cloudflaredInstalled?'已安裝':'尚未安裝'} · ${nice(t.status)}. ${t.accessLastValidated?`Access 已驗證：${when(t.accessLastValidated)}`:'Access 尚未經實際請求驗證。'}`:`Tailscale ${nice(t.tailscale.state)} · 使用 HTTPS 連接埠 8443；AI 主機須加入相同的 tailnet。`;
}
function updateProvider(){const cf=$('#tunnel-form').elements.provider.value==='cloudflare';$('#cloudflare-fields').hidden=!cf;$('#connector-label').hidden=!cf;}
$('#tunnel-form').elements.provider.addEventListener('change',updateProvider);
async function saveTunnel(){const form=$('#tunnel-form');const cf=form.elements.provider.value==='cloudflare';return api('/tunnel',{method:'PUT',body:JSON.stringify({provider:form.elements.provider.value,hostname:cf?form.elements.hostname.value:'',teamDomain:cf?form.elements.teamDomain.value:'',audience:cf?form.elements.audience.value:''})});}
$('#tunnel-form').addEventListener('submit',event=>{event.preventDefault();action(async()=>{await saveTunnel();toast('已儲存閘道設定');await refresh();});});
$('#start-tunnel').addEventListener('click',()=>action(async()=>{await saveTunnel();const input=$('#tunnel-form').elements.connectorToken;try{await api('/tunnel/start',{method:'POST',body:JSON.stringify({connectorToken:input.value||undefined})});toast('正在啟動連線');}finally{input.value='';await refresh();}}));
$('#stop-tunnel').addEventListener('click',()=>action(async()=>{await api('/tunnel/stop',{method:'POST',body:'{}'});toast('連線已停止');await refresh();}));
await refresh();if(state?.accounts.length){selectedAccount=(state.accounts.find(a=>a.kind==='line'&&a.status==='connected') || state.accounts[0]).id;await loadChats();renderAccounts();}setInterval(()=>{void refresh();},3000);
