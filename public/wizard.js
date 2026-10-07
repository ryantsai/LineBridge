import {icon} from './icons.js';
import {accountName,chatName} from './names.js';
import {localCliInstructions} from './ai-instructions.js';
import {copyText,reducedMotion} from './ui.js';

// Views in reading order; moving forward slides left, back slides right.
const order={welcome:0,stored:1,connect:2,chats:3,confirm:4};
function hero(){
  const path='M128 100C170 26 270 26 312 100';
  const sparks=reducedMotion()?'':`<g class="hero-particles"><circle r="7" class="hero-spark-glow" filter="url(#hero-blur)"><animateMotion dur="2.8s" repeatCount="indefinite"><mpath href="#hero-path"/></animateMotion></circle><circle r="3.2" class="hero-spark"><animateMotion dur="2.8s" repeatCount="indefinite"><mpath href="#hero-path"/></animateMotion></circle><circle r="2.4" class="hero-spark dim"><animateMotion dur="2.8s" repeatCount="indefinite" calcMode="linear" keyTimes="0;.5;.5;1" keyPoints=".5;1;0;.5"><mpath href="#hero-path"/></animateMotion></circle></g>`;
  return `<svg class="hero-art" viewBox="0 0 440 200" aria-hidden="true" focusable="false"><defs><radialGradient id="hero-glow"><stop offset="0" class="hero-glow-a"/><stop offset="1" class="hero-glow-b"/></radialGradient><linearGradient id="hero-ink" x1="0" y1="0" x2="1" y2="1"><stop offset="0" class="hero-ink-a"/><stop offset="1" class="hero-ink-b"/></linearGradient><filter id="hero-shadow" x="-40%" y="-40%" width="180%" height="190%"><feDropShadow dx="0" dy="14" stdDeviation="14" class="hero-shadow"/></filter><filter id="hero-blur" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="4"/></filter></defs><ellipse cx="220" cy="108" rx="210" ry="92" fill="url(#hero-glow)"/><path id="hero-path" class="hero-bridge" pathLength="1" d="${path}"/><path class="hero-flow" d="${path}"/>${sparks}<ellipse class="hero-floor" cx="110" cy="178" rx="40" ry="6"/><ellipse class="hero-floor late" cx="330" cy="178" rx="40" ry="6"/><g class="hero-enter left"><g class="hero-tile"><rect class="hero-card" x="62" y="56" width="96" height="96" rx="28" filter="url(#hero-shadow)"/><path class="hero-bubble" d="M94 86h32a10 10 0 0 1 10 10v16a10 10 0 0 1-10 10h-17l-11 9v-9h-4a10 10 0 0 1-10-10V96a10 10 0 0 1 10-10z"/><circle class="hero-dot" cx="100" cy="104" r="3.4"/><circle class="hero-dot" cx="110" cy="104" r="3.4"/><circle class="hero-dot" cx="120" cy="104" r="3.4"/></g></g><g class="hero-enter right"><g class="hero-tile late"><rect x="282" y="56" width="96" height="96" rx="28" fill="url(#hero-ink)" filter="url(#hero-shadow)"/><path class="hero-star" d="M330 80Q332.6 101.4 354 104 332.6 106.6 330 128 327.4 106.6 306 104 327.4 101.4 330 80z"/><path class="hero-star small" d="M352 70Q352.9 77.1 360 78 352.9 78.9 352 86 351.1 78.9 344 78 351.1 77.1 352 70z"/></g></g></svg>`;
}

export function createWizard(ctx){
  const {escape,action,nice,avatar}=ctx;
  const root=document.querySelector('#wizard-content');
  let step=1,mode='welcome',waiting=false,awaitingNew=false,lastPicker='',lastConnect='',draftAccount=null,rooms=[],chosen=new Set(),busy=false,chatSearch='',autoMonitorNewChats=false,lastScope='',view='';
  const account=()=>ctx.getState()?.accounts.find(a=>a.id===ctx.getSelected());
  const setupSignature=setup=>JSON.stringify([setup?.chatIds,setup?.autoMonitorNewChats,setup?.phase,setup?.grantActive]);
  function listen(selector,job){root.querySelector(selector)?.addEventListener('click',()=>action(job));}
  // Re-rendering the same view (status polling, search) must not replay motion.
  function paint(next,html){
    root.innerHTML=html;
    if(next!==view){root.firstElementChild.classList.add('enter',!view?'fade':order[next]>order[view]?'from-right':'from-left');view=next;}
  }
  function bottom(back,label,disabled=false,done=false){return `<footer class="wizard-foot"><button class="btn ghost" id="wizard-back" ${busy?'disabled':''}>${icon('chevronLeft')}${back}</button><button class="btn primary" id="wizard-next" ${disabled?'disabled':''}>${done?icon('check','draw'):''}${label}${done?'':icon('chevronRight')}</button></footer>`;}
  function frame(title,intro,body,buttons,aside=''){return `<div class="wizard-view"><header class="wizard-head"><div><h2>${title}</h2>${intro?`<p>${intro}</p>`:''}</div>${aside}</header><div class="wizard-body">${body}</div>${buttons}</div>`;}
  const chip=a=>`<div class="account-chip">${avatar(accountName(a),a.id,'sm')}<span>${escape(accountName(a))}</span></div>`;
  function progress(){document.querySelectorAll('.stepper li').forEach((el,index)=>{const done=index<step-1;el.classList.toggle('current',index===step-1);if(el.classList.contains('complete')!==done){el.classList.toggle('complete',done);el.querySelector('.step-dot').innerHTML=done?icon('check'):String(index+1);}if(index===step-1)el.setAttribute('aria-current','step');else el.removeAttribute('aria-current');});}
  function renderChatList(){
    const normalize=value=>String(value??'').normalize('NFKC').toLocaleLowerCase();
    const terms=normalize(chatSearch).trim().split(/\s+/).filter(Boolean);
    const visible=rooms.filter(c=>terms.every(term=>normalize(`${chatName(c)} ${c.id} ${nice(c.kind)}`).includes(term)));
    const count=()=>`${visible.length===rooms.length?'':`${visible.length} / `}${rooms.length} 個聊天室 · 已選 ${chosen.size}`;
    root.querySelector('#setup-chat-count').textContent=count();
    const list=root.querySelector('#setup-chat-list');
    list.innerHTML=visible.length?visible.map(c=>`<label class="pick"><input type="checkbox" data-setup-chat="${escape(c.id)}" ${chosen.has(c.id)?'checked':''} ${busy?'disabled':''}>${avatar(chatName(c),c.id,'sm')}<span class="pick-main"><strong>${escape(chatName(c))}</strong><small><span class="tag">${escape(nice(c.kind))}</span><code>${escape(c.id)}</code></small></span></label>`).join(''):rooms.length?'<div class="list-empty">沒有符合的聊天室<button class="link-btn" id="setup-clear-search">清除搜尋</button></div>':'<div class="list-empty">按「探索」載入聊天室，或新增已知 ID</div>';
    list.querySelectorAll('[data-setup-chat]').forEach(el=>el.addEventListener('change',()=>{
      if(el.checked)chosen.add(el.dataset.setupChat);else chosen.delete(el.dataset.setupChat);
      root.querySelector('#wizard-next').disabled=busy||!chosen.size;
      root.querySelector('#setup-chat-count').textContent=count();
    }));
    list.querySelector('#setup-clear-search')?.addEventListener('click',()=>{chatSearch='';const search=root.querySelector('#setup-chat-search');search.value='';renderChatList();search.focus();});
  }
  function render(){
    progress();const a=account();
    if(step>1&&!a){step=1;mode='stored';progress();}
    if(step===1&&mode==='welcome'){
      paint('welcome',`<div class="wizard-view welcome"><div class="hero">${hero()}</div><h2>連接你的 LINE</h2><p class="lead">掃描 QR Code 綁定帳號，憑證只存在這台電腦。</p><div class="welcome-actions"><button class="btn primary lg" id="wizard-add">${icon('qr')}新增 LINE 帳號</button><button class="btn lg" id="wizard-stored" ${ctx.getState()?.accounts.length?'':'hidden'}>使用已儲存的帳號</button></div><button class="link-btn" id="wizard-demo">先試用沙盒${icon('arrowRight')}</button></div>`);
      listen('#wizard-add',()=>{waiting=true;awaitingNew=true;ctx.openAccount();});
      listen('#wizard-stored',()=>{mode='stored';render();});
      listen('#wizard-demo',async()=>{await ctx.tryDemo();step=2;render();});return;
    }
    if(step===1&&mode==='stored'){
      const accounts=ctx.getState()?.accounts ?? [];
      lastPicker=JSON.stringify(accounts.map(a=>[a.id,a.status,a.profile?.displayName]));
      paint('stored',frame('選擇帳號','',`<div class="choice-list">${accounts.length?accounts.map(a=>`<button class="choice" data-wizard-account="${escape(a.id)}">${avatar(accountName(a),a.id)}<span class="choice-main"><strong>${escape(accountName(a))}</strong><small>${a.kind==='demo'?'沙盒':escape(a.label!==accountName(a)?a.label:nice(a.device))}</small></span><span class="badge ${a.status==='connected'?'good':''}">${escape(nice(a.status))}</span>${icon('chevronRight')}</button>`).join(''):'<div class="list-empty">尚無已儲存的帳號</div>'}</div>`,bottom('返回','新增帳號')));
      root.querySelectorAll('[data-wizard-account]').forEach(el=>el.addEventListener('click',()=>action(async()=>{await ctx.select(el.dataset.wizardAccount);awaitingNew=false;waiting=true;if(account()?.status==='connected'){step=2;waiting=false;}else mode='connect';render();})));
      listen('#wizard-back',()=>{mode='welcome';render();});listen('#wizard-next',()=>{waiting=true;awaitingNew=true;ctx.openAccount();});return;
    }
    if(step===1){
      const connected=a?.status==='connected',pending=['connecting','reconnecting','awaiting_login'].includes(a?.status);
      lastConnect=JSON.stringify([a?.status,a?.canResume]);
      paint('connect',frame('連線帳號','',`<div class="connect"><div class="connect-avatar ${connected?'on':pending?'busy':''}">${avatar(accountName(a),a?.id,'xl')}</div><strong class="connect-name">${escape(accountName(a))}</strong><span class="badge ${connected?'good':a?.status==='error'?'danger':pending?'warn':''}">${escape(nice(a?.status))}</span>${connected?'':`<div class="btn-row">${a?.canResume?`<button class="btn primary" id="wizard-resume">${icon('refresh')}恢復工作階段</button>`:''}<button class="btn ${a?.canResume?'':'primary'}" id="wizard-login">${icon('qr')}${a?.kind==='demo'?'連接沙盒':'掃描 QR Code'}</button></div>`}</div>`,bottom('其他帳號','繼續',!connected)));
      listen('#wizard-back',()=>{mode='stored';waiting=false;render();});listen('#wizard-resume',()=>ctx.connect(false));listen('#wizard-login',()=>ctx.connect(true));listen('#wizard-next',()=>{step=2;waiting=false;render();});return;
    }
    if(draftAccount!==a.id){
      draftAccount=a.id;rooms=ctx.getChats();
      const monitored=rooms.filter(c=>c.enabled).map(c=>c.id),setup=a.localSetup;
      // An active scope also starts with rooms monitored outside it (older toggles),
      // so confirming reconciles them instead of silently stopping their reception.
      chosen=new Set(setup?.grantActive?[...setup.chatIds,...monitored]:setup?.chatIds??monitored);
      chatSearch='';autoMonitorNewChats=setup?.autoMonitorNewChats===true;lastScope=JSON.stringify(setup?.chatIds??[]);
    }
    if(step===2){
      const searching=root.querySelector('#setup-chat-search')===document.activeElement;
      paint('chats',frame('選擇聊天室','AI 只能存取你勾選的聊天室。',`<div class="picker-tools"><div class="input-icon">${icon('search')}<label class="sr-only" for="setup-chat-search">搜尋聊天室名稱、類型或 ID</label><input id="setup-chat-search" type="search" placeholder="搜尋名稱、類型或 ID" value="${escape(chatSearch)}"></div><button class="btn" id="setup-discover" ${busy?'disabled':''}>${icon('refresh',busy?'spin':'')}探索</button><button class="btn ghost" id="setup-manual" ${busy?'disabled':''}>${icon('plus')}新增 ID</button></div><p class="picker-count" id="setup-chat-count" role="status" aria-live="polite"></p><div class="picker-list" id="setup-chat-list"></div><label class="toggle-card"><input type="checkbox" class="switch" id="setup-auto-monitor" ${autoMonitorNewChats?'checked':''} ${busy?'disabled':''}><span><strong>自動加入新聊天室</strong><small>監聽時每 ${ctx.getState()?.refresh?.intervalSeconds??15} 秒探索一次；新的一對一、群組與 OpenChat 會自動開放 AI 讀取與傳送並封存。</small></span></label>`,bottom('返回','下一步',busy||!chosen.size),chip(a)));
      const search=root.querySelector('#setup-chat-search');
      search.addEventListener('input',()=>{chatSearch=search.value;renderChatList();});
      root.querySelector('#setup-auto-monitor').addEventListener('change',event=>{autoMonitorNewChats=event.target.checked;});
      renderChatList();if(searching)search.focus();
      listen('#setup-discover',async()=>{const id=a.id;busy=true;render();try{const next=await ctx.discover(id);if(account()?.id===id)rooms=next;}finally{busy=false;if(account()?.id===id)render();}});
      listen('#setup-manual',()=>ctx.openChat());
      listen('#wizard-back',()=>{step=1;mode='stored';render();});listen('#wizard-next',()=>{step=3;render();});return;
    }
    const setup=a.localSetup??{phase:'not_enabled'},selected=rooms.filter(c=>chosen.has(c.id)),saved=new Set(setup.chatIds??[]);
    lastScope=setupSignature(setup);
    const active=setup.grantActive===true,hasSetup=!['not_enabled','revoked'].includes(setup.phase);
    const unchanged=chosen.size===saved.size&&[...saved].every(id=>chosen.has(id))&&autoMonitorNewChats===(setup.autoMonitorNewChats===true);
    // An active profile is updated in place: same profile and bearer, no new credential.
    const updating=active&&!unchanged,stopping=rooms.filter(c=>c.enabled&&!chosen.has(c.id));
    const blocked=busy||(updating?!selected.length||selected.length!==chosen.size:!active&&(hasSetup||!selected.length||selected.length!==chosen.size||a.status!=='connected'));
    const reach=`本機 AI 可讀取並傳送訊息到以上聊天室${autoMonitorNewChats?'與之後新發現的聊天室':''}`;
    paint('confirm',frame('確認授權','只限這台電腦上的 AI 使用。',`<dl class="summary"><div><dt>帳號</dt><dd>${escape(accountName(a))}<code title="${escape(a.id)}">${escape(a.id)}</code></dd></div><div><dt>權限</dt><dd><span class="chip good">讀取</span><span class="chip good">搜尋</span><span class="chip good">傳送</span></dd></div><div><dt>期限</dt><dd>${active&&setup.expiresAt?`${escape(new Date(setup.expiresAt).toLocaleDateString('zh-TW'))} 到期`:'90 天'}</dd></div><div><dt>新聊天室</dt><dd>${autoMonitorNewChats?'自動加入':'手動加入'}</dd></div></dl><div class="scope"><div class="scope-head">聊天室<span class="count">${selected.length}</span></div><ul class="scope-list">${selected.map(c=>`<li>${avatar(chatName(c),c.id,'sm')}<span class="scope-main"><strong>${escape(chatName(c))}</strong><code>${escape(c.id)}</code></span>${active&&!saved.has(c.id)?'<span class="tag good">新增</span>':''}<span class="tag">${escape(nice(c.kind))}</span></li>`).join('')}</ul></div>${stopping.length?`<p class="note warn">${icon('alert')}<span>將停止監控並移除 AI 存取：${stopping.map(c=>escape(chatName(c))).join('、')}</span></p>`:''}<p class="note">${icon('info')}<span>${active?`${reach}，並持續接收與加密封存。${updating?'更新範圍會沿用現有的設定檔與憑證，AI 不需重新連線。':''}`:`啟用後，${reach}，並開始接收與加密封存。${setup.phase==='enabled'?'目前的授權已到期或撤銷；請先停用並移除憑證，再重新啟用。':''}`}</span></p><div id="setup-status" role="status" aria-live="polite"></div>${hasSetup?`<button class="btn danger sm" id="setup-revoke" ${busy?'disabled':''}>${icon('power')}停用並移除憑證</button>`:''}<div id="setup-ai-instructions"></div><button class="link-btn" id="setup-advanced">需要雲端 AI？前往 AI 存取${icon('arrowRight')}</button>`,bottom('修改',!active?'啟用':updating?'更新範圍':'完成',blocked,active&&!updating),chip(a)));
    renderStatus();
    listen('#wizard-back',()=>{step=2;render();});
    listen('#setup-advanced',()=>ctx.go('access'));
    listen('#wizard-next',async()=>{
      if(busy)return;if(active&&!updating){ctx.go('dashboard');return;}busy=true;render();
      try{
        if(updating)await ctx.updateScope(a.id,{chatIds:[...chosen],currentChatIds:setup.chatIds??[],autoMonitorNewChats,confirmed:true});
        else await ctx.enable(a.id,{chatIds:[...chosen],read:true,send:true,confirmed:true,autoMonitorNewChats});
      }finally{busy=false;render();}
    });
    listen('#setup-revoke',async()=>{if(busy)return;busy=true;render();try{await ctx.revoke(a.id);}finally{busy=false;render();}});
  }
  function renderStatus(){
    const a=account(),setup=a?.localSetup,target=root.querySelector('#setup-status');if(!target)return;
    const health={ready:'已就緒',sandbox:'沙盒已啟用，不連線 LINE',waiting:'等待每個接收串流首次成功',initializing:'正在建立接收起點',retrying:'接收串流重試中',stale:'超過 60 秒未成功接收',off:'接收已停止',disconnected:'帳號未連線',paused:'AI 存取已暫停',selection_changed:'監控中的聊天室與 AI 授權範圍不一致；請返回確認後按「更新範圍」',unavailable:'受保護的憑證儲存無法使用',profile_conflict:'本機設定檔與此授權不符',endpoint_changed:'閘道連接埠已變更；請停用後重新啟用',disabled:'未啟用、已撤銷或已到期'};
    const fine=setup?.ready||setup?.health==='sandbox',streams=Object.values(setup?.monitor?.streams??{}).filter(s=>s.channel!=='demo');
    const streamLabel={healthy:'正常',stale:'逾時',waiting:'等待中',initializing:'建立中',retrying:'重試中',disconnected:'未連線',off:'已停止',no_chats:'無聊天室'};
    const html=setup?.phase==='cleanup_required'?`<p class="status-line warn">${icon('alert')}存取已撤銷，但憑證清理未完成。解鎖憑證儲存後再按停用。</p>`:setup?.phase==='enabled'?`<p class="status-line ${fine?'good':'warn'}"><span class="dot ${fine?'good live':'warn'}"></span>${escape(health[setup.health]??setup.health)}</p>${streams.length?`<div class="streams">${streams.map(s=>`<span class="stream" title="最後成功：${escape(s.lastSuccessAt??'尚無紀錄')}"><span class="dot ${s.health==='healthy'?'good':''}"></span>${escape(s.channel==='talk'?'一對一與群組':'OpenChat')} · ${escape(streamLabel[s.health]??s.health)}</span>`).join('')}</div>`:''}`:'';
    if(target.dataset.view!==html){target.innerHTML=html;target.dataset.view=html;}
    const instructions=root.querySelector('#setup-ai-instructions');
    if(instructions&&setup?.grantActive&&setup.credentialStatus==='protected'){
      if(!instructions.querySelector('textarea'))instructions.innerHTML=`<div class="handoff"><div class="handoff-head"><span class="handoff-icon">${icon('terminal')}</span><div><strong>本機 AI 存取已啟用</strong><small>AI 可自行查詢帳號與聊天室，不需複製指令。</small></div></div><details class="preview"><summary>連線說明（選用）</summary><p class="muted">AI 可依 README 的探索步驟連線；需要手動提供連線資訊時，可複製下方說明。</p><button class="btn sm" id="setup-copy">${icon('copy')}複製連線說明</button><textarea aria-label="本機 AI 連線說明" rows="8" readonly></textarea></details></div>`;
      instructions.querySelector('textarea').value=localCliInstructions(a,ctx.getState()?.cli);
      instructions.querySelector('#setup-copy').onclick=()=>action(()=>copyText(instructions.querySelector('textarea').value,instructions.querySelector('#setup-copy')));
    }else if(instructions)instructions.innerHTML='';
  }
  return {
    start(){if(busy){render();return;}step=1;mode=ctx.getState()?.accounts.length?'stored':'welcome';waiting=false;awaitingNew=false;draftAccount=null;rooms=[];chosen=new Set();chatSearch='';lastScope='';view='';render();},
    render,
    cancelNewAccount(){awaitingNew=false;if(step===1)waiting=false;},
    // A room added by ID from the picker is meant to be chosen; show it now
    // instead of waiting for the next periodic refresh.
    chatAdded(id){if(step!==2)return;rooms=ctx.getChats();if(rooms.some(c=>c.id===id))chosen.add(id);render();},
    accountAdded(){if(waiting){awaitingNew=false;mode='connect';if(account()?.status==='connected'){waiting=false;step=2;}render();}},
    sync(){
      if(waiting&&!awaitingNew&&account()?.status==='connected'){waiting=false;step=2;render();}
      else if(step===2){const next=ctx.getChats();if(JSON.stringify(next)!==JSON.stringify(rooms)){rooms=next;render();}}
      else if(step===3){const setup=account()?.localSetup,scope=setupSignature(setup);if(scope!==lastScope){if(setup?.grantActive){rooms=ctx.getChats();chosen=new Set(setup.chatIds);autoMonitorNewChats=setup.autoMonitorNewChats===true;}render();}else renderStatus();}
      else if(step===1&&mode==='stored'){const next=JSON.stringify((ctx.getState()?.accounts ?? []).map(a=>[a.id,a.status,a.profile?.displayName]));if(next!==lastPicker)render();}
      else if(step===1&&mode==='welcome'){const stored=root.querySelector('#wizard-stored');if(stored)stored.hidden=!ctx.getState()?.accounts.length;}
      else if(step===1){const a=account();if(JSON.stringify([a?.status,a?.canResume])!==lastConnect)render();}
    },
    get step(){return step;}
  };
}
