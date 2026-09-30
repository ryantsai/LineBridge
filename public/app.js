import { sendIntent } from './send-intent.js';
const $=selector=>document.querySelector(selector);
const escape=value=>String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const nice=value=>String(value ?? '').replaceAll('_',' ');
const when=value=>value?new Date(value).toLocaleString(): '—';
let state,selectedAccount,selectedChat,chats=[],loginAccount,loginTimer,toastTimer,lastConfig,sendAttempt,chatFilter='all';
let refreshRunning=false;
async function api(path,options={}) {
  const res=await fetch(`/admin${path}`,{...options,headers:{'Content-Type':'application/json','X-Line-Bridge':'dashboard',...options.headers}});
  const result=await res.json();if(!res.ok){const error=new Error(result.message || nice(result.error));error.code=result.error;throw error;}return result;
}
function toast(message,error=false) {const el=$('#toast');el.textContent=message;el.classList.toggle('error',error);el.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{el.hidden=true;},error?9000:4500);}
async function action(job){try{return await job();}catch(error){toast(error.message,true);}}
function badge(text,kind=''){return `<span class="badge ${kind}">${escape(text)}</span>`;}
function statusBadge(a){return badge(a.kind==='demo'?'Sandbox':nice(a.status),a.status==='connected'?'good':a.status==='error'?'danger':'warn');}
function switchTab(tab){document.querySelectorAll('.nav').forEach(e=>e.classList.toggle('active',e.dataset.tab===tab));document.querySelectorAll('.page').forEach(e=>e.classList.toggle('active',e.id===tab));$('#page-title').textContent={accounts:'Accounts & chats',access:'AI access',tunnel:'Private connection',activity:'Activity'}[tab];$('#page-description').textContent={accounts:'A controlled connection between LINE and your AI clients.',access:'Let AI clients use exactly the accounts and chats you choose.',tunnel:'A protected route from your cloud AI host to this PC.',activity:'See what your clients read, send and change.'}[tab];}
document.querySelectorAll('[data-tab]').forEach(e=>e.addEventListener('click',()=>switchTab(e.dataset.tab)));
document.querySelectorAll('[data-close]').forEach(e=>e.addEventListener('click',()=>{$(`#${e.dataset.close}`).close();if(e.dataset.close==='secret-dialog')$('#new-secret').value='';}));
$('#secret-dialog').addEventListener('close',()=>{$('#new-secret').value='';});

async function refresh(){
  if(refreshRunning)return;refreshRunning=true;
  try {
    state=await api('/state');$('#service-error').hidden=true;
    $('#metric-accounts').textContent=state.accounts.filter(a=>a.status==='connected'&&a.kind==='line').length;
    const demos=state.accounts.filter(a=>a.kind==='demo').length;
    $('#metric-account-detail').textContent=`${state.accounts.filter(a=>a.kind==='line').length} LINE account${state.accounts.filter(a=>a.kind==='line').length===1?'':'s'}${demos?` · ${demos} sandbox`:''}`;
    $('#metric-tokens').textContent=state.tokens.filter(t=>!t.revoked&&Date.parse(t.expires_at)>Date.now()).length;
    $('#metric-tunnel').textContent=state.tunnel.connected?'Connected':'Not connected';$('#metric-tunnel').className=`text-status ${state.tunnel.connected?'good':'warn'}`;
    $('#metric-tunnel-detail').textContent=state.tunnel.provider==='cloudflare'?'Cloudflare Tunnel + Access':'Tailscale · private tailnet';
    $('#metric-gateway').textContent=state.gateway.enabled?'Ready':'Paused';$('#metric-gateway').className=`text-status ${state.gateway.enabled?'good':'warn'}`;
    $('#pause').textContent=state.gateway.enabled?'Pause':'Resume';$('#vault-detail').textContent=state.vault;
    renderAccounts();renderTokens();renderAudit();renderTunnel();
    const base=state.tunnel.url || `http://127.0.0.1:${state.gateway.port}`;
    $('#mcp-url').textContent=`${base}/mcp`;$('#api-url').textContent=`${base}/openapi.json`;
    if(selectedAccount&&!state.accounts.some(a=>a.id===selectedAccount)){selectedAccount=null;selectedChat=null;chats=[];renderAccountPane();}
  }catch(error){$('#service-error').textContent=`Dashboard service unavailable: ${error.message}`;$('#service-error').hidden=false;}finally{refreshRunning=false;}
}
$('#refresh').addEventListener('click',()=>action(async()=>{await refresh();if(selectedAccount)await loadChats();}));
$('#pause').addEventListener('click',()=>action(async()=>{await api('/pause',{method:'POST',body:JSON.stringify({enabled:!state.gateway.enabled})});await refresh();}));
function renderAccounts(){
  $('#account-count').textContent=state.accounts.length;
  $('#account-list').innerHTML=state.accounts.length?state.accounts.map(a=>`<button class="account-item ${selectedAccount===a.id?'selected':''}" data-account="${escape(a.id)}"><span class="avatar">${escape(a.label.slice(0,1).toUpperCase())}</span><span class="account-info"><strong>${escape(a.label)}</strong><small class="${a.kind==='demo'?'demo-text':''}">${a.kind==='demo'?'Synthetic sandbox':escape(nice(a.status))} · ${a.designatedChats} designated</small></span></button>`).join(''):'<div class="chat-placeholder">No accounts yet</div>';
  document.querySelectorAll('[data-account]').forEach(e=>e.addEventListener('click',()=>action(async()=>{selectedAccount=e.dataset.account;selectedChat=null;sendAttempt=null;await loadChats();renderAccounts();})));
  if(selectedAccount){const a=state.accounts.find(a=>a.id===selectedAccount);if(a){const el=$('#selected-status');if(el)el.innerHTML=statusBadge(a);renderDiscoveryNotice(a);}}
}
function renderDiscoveryNotice(account){
  const el=$('#discovery-notice');if(!el)return;
  const d=account.discovery;
  el.hidden=!d;
  if(d){const s=d.stages ?? {},parts=['groups','direct','openchat'].filter(k=>s[k]).map(k=>`${k==='openchat'?'OpenChat':k==='direct'?'Contacts':'Groups'}: ${s[k].status!=='failed'?s[k].count+' found'+(s[k].status==='partial'?' (partial)':''):'discovery failed ('+s[k].errorCode+')'}`);el.textContent=parts.join(' · ') || d.warnings.join(' ');el.classList.toggle('discovery-error',!!d.warnings.length);}
}
async function loadChats(){const id=selectedAccount;const result=await api(`/accounts/${id}/chats`);if(id!==selectedAccount)return;chats=result;if(selectedChat&&!chats.some(c=>c.id===selectedChat))selectedChat=null;renderAccountPane();if(selectedChat)await readMessages();}
function renderAccountPane(){
  const a=state?.accounts.find(a=>a.id===selectedAccount);if(!a)return;
  const visibleChats=chats.filter(c=>chatFilter==='all'||c.kind===chatFilter);
  $('#chat-pane').innerHTML=`<div class="account-head"><div><h3>${escape(a.label)} <span id="selected-status">${statusBadge(a)}</span></h3><p>${a.kind==='demo'?'Synthetic account · no LINE network calls':`${escape(a.profile?.displayName || nice(a.device))} · Last checked ${escape(when(a.lastChecked))}`}</p></div><div class="button-row">${a.status!=='connected'?'<button class="button tiny" id="connect-account">'+(a.kind==='demo'?'Reconnect':'Connect with QR')+'</button>':'<button class="button tiny" id="disconnect-account">Disconnect</button>'}<button class="button tiny danger" id="remove-account">Remove</button></div></div>${a.error?`<div class="notice account-error">${escape(nice(a.error))}. Reconnect to verify the session.</div>`:''}<div class="chat-tools"><button class="button" id="discover-chats" ${a.status!=='connected'?'disabled':''}>↻ Discover chats</button><button class="button" id="add-chat">＋ Add known chat</button><select id="chat-filter" aria-label="Chat type">${[["all","All chats"],["group","Groups"],["direct","Contacts"],["openchat","OpenChats"]].map(([kind,label])=>`<option value="${kind}" ${chatFilter===kind?"selected":""}>${label} (${chats.filter(c=>kind==="all"||c.kind===kind).length})</option>`).join("")}</select><span class="badge">${chats.filter(c=>c.enabled).length} designated for AI</span></div><div class="chat-access-help">Check a chat’s box to allow designated AI clients to use it. You can inspect chats locally while AI access is off.</div><div class="notice discovery-notice" id="discovery-notice" hidden></div><div class="chat-layout"><div class="chat-list">${visibleChats.length?visibleChats.map(c=>`<div class="chat-item ${selectedChat===c.id?'selected':''}" data-chat="${escape(c.id)}" role="button" tabindex="0"><label class="checkbox-label" title="Designate for AI access"><input type="checkbox" data-designate="${escape(c.id)}" aria-label="Allow AI access to ${escape(c.name)}" ${c.enabled?'checked':''}></label><div><strong>${escape(c.name)}</strong><small>${escape(c.kind==='openchat'?'OpenChat · experimental':nice(c.kind))} · ${c.enabled?'AI enabled':'AI access off'}</small></div></div>`).join(''):'<div class="chat-placeholder">Discover chats after connecting,<br>or add a known chat ID.</div>'}</div><div class="chat-reader" id="reader">${selectedChat?'<p class="muted">Loading messages…</p>':'<div class="chat-placeholder">Select a chat to inspect messages.<p class="muted">Check its box to designate it for AI access.</p></div>'}</div></div>`;
  renderDiscoveryNotice(a);
  $('#connect-account')?.addEventListener('click',()=>action(()=>a.kind==='demo'?reconnect():login(a.id)));
  if(a.status!=='connected' && a.kind==='line' && a.canResume){const button=document.createElement('button');button.className='button tiny';button.textContent='Resume saved session';button.addEventListener('click',()=>action(reconnect));$('.account-head .button-row').prepend(button);}
  $('#disconnect-account')?.addEventListener('click',()=>action(async()=>{await api(`/accounts/${a.id}/disconnect`,{method:'POST',body:'{}'});await refresh();await loadChats();}));
  $('#remove-account').addEventListener('click',()=>action(async()=>{if(!confirm(`Remove ${a.label} and forget its saved credentials?`))return;await api(`/accounts/${a.id}`,{method:'DELETE'});selectedAccount=null;selectedChat=null;chats=[];$('#chat-pane').innerHTML='<div class="empty"><h3>Choose or add an account</h3><p>Your account workspace will appear here.</p></div>';await refresh();}));
  $('#discover-chats').addEventListener('click',()=>action(async()=>{$('#discover-chats').disabled=true;const result=await api(`/accounts/${a.id}/discover`,{method:'POST',body:'{}'});chats=result.chats;toast(result.warnings.join(' ')||`Found ${chats.length} chats`,!!result.warnings.length);await refresh();renderAccountPane();}));
  $('#chat-filter').addEventListener('change',event=>{chatFilter=event.target.value;if(!chats.some(c=>c.id===selectedChat&&(chatFilter==='all'||c.kind===chatFilter))){selectedChat=null;sendAttempt=null;}renderAccountPane();if(selectedChat)action(readMessages);});
  $('#add-chat').addEventListener('click',()=>$('#chat-dialog').showModal());
  document.querySelectorAll('[data-chat]').forEach(el=>{const select=()=>action(async()=>{selectedChat=el.dataset.chat;sendAttempt=null;renderAccountPane();await readMessages();});el.addEventListener('click',event=>{if(!event.target.closest('label'))select();});el.addEventListener('keydown',event=>{if(event.target===el&&(event.key==='Enter'||event.key===' ')){event.preventDefault();select();}});});
  document.querySelectorAll('[data-designate]').forEach(el=>el.addEventListener('change',()=>action(async()=>{try{await api(`/accounts/${a.id}/chats/${encodeURIComponent(el.dataset.designate)}`,{method:'PATCH',body:JSON.stringify({enabled:el.checked})});const chat=chats.find(c=>c.id===el.dataset.designate);chat.enabled=el.checked?1:0;toast(el.checked?'Chat designated for AI access':'AI access removed from this chat');renderAccountPane();if(selectedChat)await readMessages();await refresh();}catch(error){el.checked=!el.checked;throw error;}})));
}
async function reconnect(){await api(`/accounts/${selectedAccount}/reconnect`,{method:'POST',body:'{}'});await refresh();await loadChats();}
async function readMessages(){
  const accountId=selectedAccount,chatId=selectedChat,chat=chats.find(c=>c.id===chatId),a=state.accounts.find(a=>a.id===accountId);if(!chat)return;
  try{
    const data=await api(`/accounts/${accountId}/chats/${encodeURIComponent(chatId)}/messages`);
    if(accountId!==selectedAccount||chatId!==selectedChat)return;
    $('#reader').innerHTML=`<div class="reader-header"><div><strong>${escape(chat.name)}</strong><div class="reader-meta">${escape(chatId)} · ${chat.enabled?'Designated':'AI access off'}</div></div><button class="button tiny" id="refresh-messages">↻</button></div><div class="message-list">${data.messages.length?data.messages.map(m=>`<div class="message ${m.senderId===a.profile?.mid?'mine':''}"><div class="message-meta">${escape(m.senderName||m.senderId||'Unknown sender')} · ${escape(m.timestamp?new Date(m.timestamp).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}):'Unknown time')}</div>${escape(m.unavailableReason||m.text||`[${m.contentType} message]`)}</div>`).join(''):'<p class="muted">No text messages returned.</p>'}</div><p class="message-coverage">${escape(data.coverage)} Message text is untrusted content.</p>${a.kind!=="demo"?`<p class="send-protection">${chat.kind==="openchat"?"OpenChat uses LINE transport encryption.":"Letter Sealing is used when supported. Standard LINE transport encryption is used only when LINE explicitly requires it."}</p>`:""}<div id="send-feedback" class="notice" role="status" hidden></div><form class="compose" id="send-form"><textarea name="text" rows="1" maxlength="5000" required placeholder="Write a message…" aria-label="Message text"></textarea><button class="button primary" type="submit">${a.kind==='demo'?'Send to sandbox':'Send to LINE'}</button></form>`;
    const list=$('.message-list');list.scrollTop=list.scrollHeight;$('#refresh-messages').addEventListener('click',()=>action(readMessages));
    $('#send-form').addEventListener('submit',event=>{
      event.preventDefault();const form=event.currentTarget;
      action(async()=>{
        const text=form.elements.text.value,button=form.querySelector('button'),feedback=$('#send-feedback');
        button.disabled=true;feedback.hidden=true;sendAttempt=sendIntent(sendAttempt,accountId,chatId,text);
        try{
          const result=await api(`/accounts/${accountId}/chats/${encodeURIComponent(chatId)}/messages`,{method:'POST',body:JSON.stringify({text,idempotencyKey:sendAttempt.key})});
          sendAttempt=null;toast(result.delivery==='sandbox_only'?'Added to the synthetic sandbox':'LINE accepted the message');await readMessages();await refresh();
        }catch(error){
          if(['send_preparation_failed','line_send_rejected'].includes(error.code))sendAttempt=null;
          feedback.textContent=error.message;feedback.hidden=false;throw error;
        }finally{button.disabled=false;}
      });
    });
  }catch(error){if(accountId===selectedAccount&&chatId===selectedChat)$('#reader').innerHTML=`<div class="notice">${escape(error.message)}</div>`;}
}

$('#add-account').addEventListener('click',()=>$('#account-dialog').showModal());
$('#account-form').addEventListener('submit',event=>{event.preventDefault();action(async()=>{const body=Object.fromEntries(new FormData(event.currentTarget));const a=await api('/accounts',{method:'POST',body:JSON.stringify(body)});$('#account-dialog').close();$('#account-form').reset();selectedAccount=a.id;await refresh();await loadChats();if(a.kind==='line')await login(a.id);});});
$('#try-demo').addEventListener('click',()=>action(async()=>{const existing=state.accounts.find(a=>a.kind==='demo');if(existing){selectedAccount=existing.id;}else{const a=await api('/accounts',{method:'POST',body:JSON.stringify({label:'Sandbox account',kind:'demo',device:'IOSIPAD'})});selectedAccount=a.id;}selectedChat=null;await refresh();await loadChats();toast('Sandbox uses synthetic data. It does not contact LINE.');}));
$('#chat-form').addEventListener('submit',event=>{event.preventDefault();action(async()=>{await api(`/accounts/${selectedAccount}/chats`,{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(event.currentTarget)))});$('#chat-dialog').close();$('#chat-form').reset();await loadChats();});});
async function login(id){await api(`/accounts/${id}/login`,{method:'POST',body:'{}'});loginAccount=id;$('#login-content').textContent='Requesting a QR code…';$('#login-dialog').showModal();clearInterval(loginTimer);loginTimer=setInterval(()=>{void pollLogin();},1500);await pollLogin();}
async function pollLogin(){
  if(!loginAccount)return;
  try{const data=await api(`/accounts/${loginAccount}/login`);$('#login-content').innerHTML=data.qr?`<img src="${escape(data.qr)}" alt="LINE account login QR code">${data.pin?`<p>Confirm this PIN on your phone</p><strong>${escape(data.pin)}</strong>`:''}`:`<p>${escape(nice(data.status))}</p>`;
    if(data.status==='connected'){clearInterval(loginTimer);loginAccount=null;$('#login-dialog').close();toast('LINE account connected');await refresh();await loadChats();}
    else if(data.status==='error') {clearInterval(loginTimer);$('#login-content').textContent='Login failed or expired. Cancel and try again.';await refresh();}
  }catch(error){toast(error.message,true);clearInterval(loginTimer);}
}
async function cancelLogin(){clearInterval(loginTimer);if(loginAccount)await api(`/accounts/${loginAccount}/disconnect`,{method:'POST',body:'{}'});loginAccount=null;$('#login-dialog').close();await refresh();if(selectedAccount)await loadChats();}
$('#cancel-login').addEventListener('click',()=>action(cancelLogin));$('#close-login').addEventListener('click',()=>action(cancelLogin));$('#login-dialog').addEventListener('cancel',event=>{event.preventDefault();action(cancelLogin);});

function renderTokens(){
  $('#token-list').innerHTML=state.tokens.length?state.tokens.map(t=>{const expired=Date.parse(t.expires_at)<=Date.now(),active=!t.revoked&&!expired;return `<div class="token-item"><div><strong>${escape(t.name)}</strong> ${badge(t.revoked?'Revoked':expired?'Expired':'Active',active?'good':'')}<div class="token-meta">${t.grants.map(g=>`${badge(`${state.accounts.find(a=>a.id===g.accountId)?.label||'Removed account'} · ${[g.read?'read':null,g.send?'send':null].filter(Boolean).join(' + ')}`)}`).join('')}</div><p>Expires ${escape(when(t.expires_at))} · Last used ${escape(when(t.last_used))}</p></div>${active?`<button class="button tiny danger" data-revoke="${escape(t.id)}">Revoke</button>`:''}</div>`;}).join(''):'<div class="token-empty">No AI clients have access yet. Create an expiring token after designating your chats.</div>';
  document.querySelectorAll('[data-revoke]').forEach(e=>e.addEventListener('click',()=>action(async()=>{await api(`/tokens/${e.dataset.revoke}`,{method:'DELETE'});toast('Access revoked immediately');await refresh();})));
}
$('#new-token').addEventListener('click',()=>{if(!state.accounts.length){toast('Add an account first');return;}$('#grant-list').innerHTML=state.accounts.map(a=>`<div class="grant-row" data-grant="${escape(a.id)}"><div><strong>${escape(a.label)}</strong><div class="grant-account">${a.designatedChats} designated chats ${a.kind==='demo'?'· sandbox':''}</div></div><div class="grant-options"><label><input type="checkbox" name="read">Read</label><label><input type="checkbox" name="send">Send</label></div></div>`).join('');$('#token-dialog').showModal();});
$('#token-form').addEventListener('submit',event=>{event.preventDefault();action(async()=>{const form=event.currentTarget,grants=[...document.querySelectorAll('[data-grant]')].map(e=>({accountId:e.dataset.grant,read:e.querySelector('[name=read]').checked,send:e.querySelector('[name=send]').checked})).filter(g=>g.read||g.send);const data=await api('/tokens',{method:'POST',body:JSON.stringify({name:form.elements.name.value,days:Number(form.elements.days.value),grants})});$('#token-dialog').close();$('#token-form').reset();$('#new-secret').value=data.token;$('#secret-dialog').showModal();await refresh();});});
$('#copy-secret').addEventListener('click',()=>action(async()=>{await navigator.clipboard.writeText($('#new-secret').value);toast('Token copied');}));
function renderAudit(){
  const actorName=id=>id==='local-admin'?'Local dashboard':state.tokens.find(t=>t.id===id)?.name||'AI client';
  $('#audit-list').innerHTML=state.audit.length?state.audit.map(row=>`<tr><td>${escape(when(row.at))}</td><td>${escape(row.action)}</td><td>${escape(state.accounts.find(a=>a.id===row.account_id)?.label||'—')}${row.chat_id?`<small>${escape(row.chat_id.slice(0,20))}</small>`:''}</td><td>${escape(actorName(row.actor))}</td><td>${badge(row.outcome,['ok','enabled'].includes(row.outcome)?'good':['failed','rejected','unknown'].includes(row.outcome)?'danger':'')}</td></tr>`).join(''):'<tr><td colspan="5">No gateway events yet.</td></tr>';
}
function renderTunnel(){
  const t=state.tunnel,config=JSON.stringify([t.provider,t.hostname,t.teamDomain,t.audience]);
  if(lastConfig!==config){const form=$('#tunnel-form');for(const key of ['provider','hostname','teamDomain','audience'])form.elements[key].value=t[key]||'';lastConfig=config;updateProvider();}
  $('#tunnel-badge').className=`badge ${t.connected?'good':'warn'}`;$('#tunnel-badge').textContent=t.connected?'Connected':t.hostname?'Configured · not connected':'Setup needed';
  $('#tunnel-health').textContent=t.provider==='cloudflare'?`Connector ${t.cloudflaredInstalled?'installed':'missing'} · ${nice(t.status)}. ${t.accessLastValidated?`Access verified ${when(t.accessLastValidated)}`:'Access has not been verified by a real request.'}`:`Tailscale ${nice(t.tailscale.state)} · HTTPS sharing uses port 8443. Your AI host must join the tailnet.`;
}
function updateProvider(){const cf=$('#tunnel-form').elements.provider.value==='cloudflare';$('#cloudflare-fields').hidden=!cf;$('#connector-label').hidden=!cf;}
$('#tunnel-form').elements.provider.addEventListener('change',updateProvider);
async function saveTunnel(){const form=$('#tunnel-form');const cf=form.elements.provider.value==='cloudflare';return api('/tunnel',{method:'PUT',body:JSON.stringify({provider:form.elements.provider.value,hostname:cf?form.elements.hostname.value:'',teamDomain:cf?form.elements.teamDomain.value:'',audience:cf?form.elements.audience.value:''})});}
$('#tunnel-form').addEventListener('submit',event=>{event.preventDefault();action(async()=>{await saveTunnel();toast('Gateway configuration saved');await refresh();});});
$('#start-tunnel').addEventListener('click',()=>action(async()=>{await saveTunnel();const input=$('#tunnel-form').elements.connectorToken;try{await api('/tunnel/start',{method:'POST',body:JSON.stringify({connectorToken:input.value||undefined})});toast('Connection is starting');}finally{input.value='';await refresh();}}));
$('#stop-tunnel').addEventListener('click',()=>action(async()=>{await api('/tunnel/stop',{method:'POST',body:'{}'});toast('Connection stopped');await refresh();}));
await refresh();if(state?.accounts.length){selectedAccount=state.accounts[0].id;await loadChats();renderAccounts();}setInterval(()=>{void refresh();},10000);
