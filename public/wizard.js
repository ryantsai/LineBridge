import {icon} from './icons.js';
import {accountName,chatName} from './names.js';

export function createWizard(ctx){
  const {escape,action,api,nice}=ctx;
  const root=document.querySelector('#wizard-content');
  let step=1,mode='welcome',waiting=false,awaitingNew=false,search='',lastPicker='';
  const account=()=>ctx.getState()?.accounts.find(a=>a.id===ctx.getSelected());
  const activeTokens=()=>ctx.getState()?.tokens.filter(t=>!t.revoked&&Date.parse(t.expires_at)>Date.now()&&t.grants.some(g=>g.accountId===ctx.getSelected()&&(g.read||g.send))) ?? [];
  function listen(selector,job){root.querySelector(selector)?.addEventListener('click',()=>action(job));}
  function bottom(back,next,label='繼續',disabled=false){return `<div class="wizard-bottom"><button class="text-button" id="wizard-back">${icon('caret-left')}${back}</button><button class="button primary" id="wizard-next" ${disabled?'disabled':''}>${label}${icon('caret-right')}</button></div>`;}
  function frame(title,intro,body,buttons){return `<div class="wizard-inner"><div class="wizard-kicker">步驟 ${step} / 5</div><h2>${title}</h2><p class="wizard-intro">${intro}</p><div class="wizard-body">${body}</div>${buttons}</div>`;}
  function progress(){document.querySelectorAll('.wizard-steps li').forEach((el,index)=>{el.classList.toggle('current',index===step-1);el.classList.toggle('complete',index<step-1);if(index===step-1)el.setAttribute('aria-current','step');else el.removeAttribute('aria-current');el.querySelector('span').innerHTML=index<step-1?icon('check'):String(index+1);});}
  function render(){
    progress();const a=account();
    if(step>1&&!a){step=1;mode='stored';progress();}
    if(step===1&&mode==='welcome'){
      root.innerHTML=`<div class="wizard-welcome"><div class="welcome-art"><img src="/assets/bridge-welcome.png" width="1536" height="1024" alt="LINE 訊息與 AI 之間的橋樑"></div><h2>連接你的 LINE 帳號</h2><p>使用手機掃描 QR Code，開始建立你的專屬橋接。</p><div class="welcome-benefits"><div class="welcome-benefit"><span class="benefit-icon">${icon('shield-check')}</span>憑證留在本機</div><span class="benefit-divider" aria-hidden="true"></span><div class="welcome-benefit"><span class="benefit-icon">${icon('chat-circle-dots')}</span>由你選擇聊天室</div></div><div class="welcome-actions"><button class="button primary" id="wizard-add">新增 LINE 帳號</button><button class="button" id="wizard-stored">使用已儲存的帳號</button></div><div class="welcome-sandbox"><button class="text-button" id="wizard-demo">先試用沙盒${icon('caret-right')}</button></div></div>`;
      listen('#wizard-add',()=>{waiting=true;awaitingNew=true;ctx.openAccount();});
      listen('#wizard-stored',()=>{mode='stored';render();});
      listen('#wizard-demo',async()=>{await ctx.tryDemo();step=2;render();});return;
    }
    if(step===1&&mode==='stored'){
      const accounts=ctx.getState()?.accounts ?? [];
      lastPicker=JSON.stringify(accounts.map(a=>[a.id,a.status,a.profile?.displayName]));
      root.innerHTML=frame('選擇已儲存的帳號','從這台電腦上的帳號繼續設定。',`<div class="wizard-account-list">${accounts.length?accounts.map(a=>`<button class="wizard-account" data-wizard-account="${escape(a.id)}"><span class="avatar">${escape(Array.from(accountName(a))[0])}</span><span class="account-info"><strong>${escape(accountName(a))}</strong><small>${escape(a.label)} · ${a.kind==='demo'?'模擬沙盒':escape(nice(a.status))}</small></span><span class="badge ${a.status==='connected'?'good':''}">${escape(nice(a.status))}</span>${icon('caret-right')}</button>`).join(''):'<div class="wizard-empty">尚未儲存帳號。新增 LINE 帳號，或先試用沙盒。</div>'}</div>`,bottom('返回歡迎頁',null,'新增帳號'));
      root.querySelectorAll('[data-wizard-account]').forEach(el=>el.addEventListener('click',()=>action(async()=>{await ctx.select(el.dataset.wizardAccount);awaitingNew=false;waiting=true;if(account()?.status==='connected'){step=2;waiting=false;}else mode='connect';render();})));
      listen('#wizard-back',()=>{mode='welcome';render();});listen('#wizard-next',()=>{waiting=true;awaitingNew=true;ctx.openAccount();});return;
    }
    if(step===1){
      root.innerHTML=frame('恢復你的帳號連線','使用已儲存的憑證，或重新掃描 QR Code。',`<div class="wizard-context"><span class="avatar">${escape(Array.from(accountName(a))[0])}</span><div><strong>${escape(accountName(a))}</strong><p>${escape(nice(a?.status))}</p></div></div><div class="wizard-choice">${icon('plug')}<div><h3>準備連接帳號</h3><p>完成連線後，接著選擇可供 AI 存取的聊天室。</p><div class="button-row">${a?.canResume?'<button class="button primary" id="wizard-resume">恢復已儲存的工作階段</button>':''}<button class="button" id="wizard-login">${a?.kind==='demo'?'連接沙盒':'使用 QR Code 連線'}</button></div></div></div>`,bottom('選擇其他帳號',null,'繼續',a?.status!=='connected'));
      listen('#wizard-back',()=>{mode='stored';waiting=false;render();});listen('#wizard-resume',()=>ctx.connect(false));listen('#wizard-login',()=>ctx.connect(true));listen('#wizard-next',()=>{step=2;waiting=false;render();});return;
    }
    if(step===2){
      const chats=ctx.getChats();
      root.innerHTML=frame('選擇要開放的聊天室','只有你勾選的聊天室，才能提供給已授權的 AI 用戶端與新訊息監聽。',`<div class="wizard-context"><span class="avatar">${escape(Array.from(accountName(a))[0])}</span><div><strong>${escape(accountName(a))}</strong><p>${a.kind==='demo'?'模擬沙盒 · 不會連線至 LINE':escape(nice(a.status))}</p></div></div><div class="wizard-chat-tools"><input id="wizard-search" type="search" placeholder="搜尋聊天室…" aria-label="搜尋聊天室" value="${escape(search)}"><button class="button" id="wizard-discover" ${a.status!=='connected'?'disabled':''}>${icon('arrows-clockwise')}探索聊天室</button></div><div class="wizard-chat-list" id="wizard-chat-list"></div><p class="wizard-optional" id="wizard-chat-count"></p>`,bottom('更換帳號',null,'繼續'));
      renderChatChoices();root.querySelector('#wizard-search').addEventListener('input',event=>{search=event.target.value;renderChatChoices();});
      listen('#wizard-discover',async()=>{const button=root.querySelector('#wizard-discover');button.disabled=true;try{await ctx.discover();renderChatChoices();}finally{if(button.isConnected)button.disabled=false;}});
      listen('#wizard-back',()=>{step=1;mode='stored';render();});listen('#wizard-next',()=>{step=3;render();});return;
    }
    if(step===3){
      const access=a.localAccess??{read:true,send:true};
      root.innerHTML=frame('決定本機 AI 的存取權限','AI 與 LineBridge 在同一台 VM 時，不需要建立或複製權杖。',`<div class="wizard-choice">${icon('shield-check')}<div><h3>${escape(accountName(a))} 的指定聊天室</h3><p>AI 只能存取你選擇的聊天室。讀取與傳送可分別調整，之後也能在「AI 存取權限」變更。</p><div class="grant-options"><label><input type="checkbox" id="wizard-local-read" ${access.read?'checked':''}>允許讀取</label><label><input type="checkbox" id="wizard-local-send" ${access.send?'checked':''}>允許傳送</label></div></div></div><div class="wizard-choice">${icon('key')}<div><h3>遠端用戶端（選用）</h3><p>只有跨主機或通道連線才需建立有期限的權杖，可稍後在設定頁處理。</p></div></div>`,bottom('返回聊天室',null,'儲存並繼續'));
      listen('#wizard-back',()=>{step=2;render();});listen('#wizard-next',async()=>{const button=root.querySelector('#wizard-next');button.disabled=true;try{await api(`/accounts/${a.id}/local-access`,{method:'PUT',body:JSON.stringify({read:root.querySelector('#wizard-local-read').checked,send:root.querySelector('#wizard-local-send').checked})});await ctx.refresh();step=4;render();}finally{if(button.isConnected)button.disabled=false;}});return;
    }
    if(step===4){
      const t=ctx.getState()?.tunnel;
      const local=ctx.getState()?.gateway.authentication==='local';
      root.innerHTML=frame('連接你的 AI','把這個 MCP 網址提供給同一台 VM 上的 AI 即可。',`<div class="wizard-choice">${icon('plug')}<div><h3>同一台主機，直接連線</h3><p><code>http://127.0.0.1:${ctx.getState()?.gateway.port||3211}/mcp</code></p><p>${local?'不用權杖、通道或額外服務帳號。AI 安裝並啟動 LineBridge 後即可連接指定聊天室。':'目前閘道要求權杖。若要免權杖本機連線，請選擇「同一台主機 · 直接連線」，並以未加 --require-token 的方式啟動服務。'}</p></div></div><div class="wizard-choice">${icon('arrows-left-right')}<div><h3>跨主機連線（選用）</h3><p>AI 在另一台主機時，可使用 Cloudflare Quick Tunnel、Cloudflare Access 或 Tailscale，並另行設定遠端權杖。</p><button class="button" id="wizard-tunnel">開啟連線設定${icon('caret-right')}</button></div></div>`,bottom('返回 AI 權限',null,'繼續'));
      listen('#wizard-tunnel',()=>ctx.go('tunnel',true));listen('#wizard-back',()=>{step=3;render();});listen('#wizard-next',()=>{step=5;render();});return;
    }
    const count=ctx.getChats().filter(c=>c.enabled).length,t=ctx.getState()?.tunnel;
    const local=ctx.getState()?.gateway.authentication==='local',access=a.localAccess??{read:true,send:true};
    root.innerHTML=frame('你的 LineBridge 已準備就緒','開始使用本機工作區，或前往訊息監控開啟新訊息監聽。',`<div class="wizard-finish-icon">${icon('check')}</div><dl class="wizard-summary"><dt>LINE 帳號</dt><dd>${escape(accountName(a))}${a.kind==='demo'?' · 沙盒':''}</dd><dt>指定聊天室</dt><dd>${count} 個</dd><dt>AI 存取</dt><dd>${local?`本機免權杖 · ${[access.read?'讀取':null,access.send?'傳送':null].filter(Boolean).join(' + ')||'已停用'}`:activeTokens().length?`${activeTokens().length} 個遠端權杖`:'遠端權杖尚未設定'}</dd><dt>AI 連線</dt><dd>${t?.connected?t.provider==='local'?'同一台主機 · 直接連線':'已連線':'稍後設定'}</dd><dt>訊息監聽</dt><dd>${a.monitor?.enabled?'已啟用':'可在訊息監控頁啟用'}</dd></dl>`,bottom('返回連線設定',null,'前往訊息監控'));
    listen('#wizard-back',()=>{step=4;render();});listen('#wizard-next',()=>ctx.go('monitoring'));
  }
  function renderChatChoices(){
    const target=root.querySelector('#wizard-chat-list');if(!target)return;
    const a=account(),chats=ctx.getChats(),visible=chats.filter(c=>chatName(c).toLocaleLowerCase().includes(search.toLocaleLowerCase()));
    target.innerHTML=visible.length?visible.map(c=>`<label class="wizard-chat-row"><input type="checkbox" data-wizard-chat="${escape(c.id)}" ${c.enabled?'checked':''} aria-label="允許 AI 存取：${escape(chatName(c))}"><span><strong>${escape(chatName(c))}</strong><small>${escape(nice(c.kind))}</small></span></label>`).join(''):`<div class="wizard-empty">${chats.length?'沒有符合搜尋的聊天室。':'按下「探索聊天室」取得這個帳號可使用的聊天室。'}</div>`;
    root.querySelector('#wizard-chat-count').textContent=`已選擇 ${chats.filter(c=>c.enabled).length} 個聊天室。可以稍後在「帳號與聊天室」變更。`;
    target.querySelectorAll('[data-wizard-chat]').forEach(el=>el.addEventListener('change',()=>action(async()=>{const enabled=el.checked;el.disabled=true;try{await api(`/accounts/${a.id}/chats/${encodeURIComponent(el.dataset.wizardChat)}`,{method:'PATCH',body:JSON.stringify({enabled})});const chat=ctx.getChats().find(c=>c.id===el.dataset.wizardChat);if(chat)chat.enabled=enabled?1:0;await ctx.refresh();renderChatChoices();}catch(error){el.checked=!enabled;throw error;}finally{el.disabled=false;}})));
  }
  return {
    render,
    cancelNewAccount(){awaitingNew=false;if(step===1)waiting=false;},
    accountAdded(){if(waiting){awaitingNew=false;mode='connect';if(account()?.status==='connected'){waiting=false;step=2;}render();}},
    sync(){
      if(waiting&&!awaitingNew&&account()?.status==='connected'){waiting=false;step=2;render();}
      else if(step===1&&mode==='stored'){const next=JSON.stringify((ctx.getState()?.accounts ?? []).map(a=>[a.id,a.status,a.profile?.displayName]));if(next!==lastPicker)render();}
    },
    tokenCreated(){if(step===3)render();},
    get step(){return step;}
  };
}
