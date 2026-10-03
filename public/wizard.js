import {icon} from './icons.js';
import {accountName} from './names.js';
import {localCliInstructions} from './ai-instructions.js';

export function createWizard(ctx){
  const {escape,action,nice}=ctx;
  const root=document.querySelector('#wizard-content');
  let step=1,mode='welcome',waiting=false,awaitingNew=false,lastPicker='',draftAccount=null,rooms=[],chosen=new Set(),busy=false;
  const account=()=>ctx.getState()?.accounts.find(a=>a.id===ctx.getSelected());
  function listen(selector,job){root.querySelector(selector)?.addEventListener('click',()=>action(job));}
  function bottom(back,next,label='繼續',disabled=false){return `<div class="wizard-bottom"><button class="text-button" id="wizard-back" ${busy?'disabled':''}>${icon('caret-left')}${back}</button><button class="button primary" id="wizard-next" ${disabled?'disabled':''}>${label}${icon('caret-right')}</button></div>`;}
  function frame(title,intro,body,buttons){return `<div class="wizard-inner"><div class="wizard-kicker">步驟 ${step} / 3</div><h2>${title}</h2><p class="wizard-intro">${intro}</p><div class="wizard-body">${body}</div>${buttons}</div>`;}
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
      root.innerHTML=frame('恢復你的帳號連線','使用已儲存的憑證，或重新掃描 QR Code。',`<div class="wizard-context"><span class="avatar">${escape(Array.from(accountName(a))[0])}</span><div><strong>${escape(accountName(a))}</strong><p>${escape(nice(a?.status))}</p></div></div><div class="wizard-choice">${icon('plug')}<div><h3>準備連接帳號</h3><p>完成連線即完成帳號綁定。接著選擇聊天室，並確認 AI 的讀取與傳送權限。</p><div class="button-row">${a?.canResume?'<button class="button primary" id="wizard-resume">恢復已儲存的工作階段</button>':''}<button class="button" id="wizard-login">${a?.kind==='demo'?'連接沙盒':'使用 QR Code 連線'}</button></div></div></div>`,bottom('選擇其他帳號',null,'繼續',a?.status!=='connected'));
      listen('#wizard-back',()=>{mode='stored';waiting=false;render();});listen('#wizard-resume',()=>ctx.connect(false));listen('#wizard-login',()=>ctx.connect(true));listen('#wizard-next',()=>{step=2;waiting=false;render();});return;
    }
    if(draftAccount!==a.id){draftAccount=a.id;rooms=ctx.getChats();chosen=new Set(a.localSetup?.chatIds??rooms.filter(c=>c.enabled).map(c=>c.id));}
    if(step===2){
      root.innerHTML=frame('選擇 AI 可以讀取與傳送的聊天室','勾選聊天室後，下一步會顯示完整授權範圍。此步驟不會啟用 AI 權限。',`<div class="wizard-context"><span class="avatar">${escape(Array.from(accountName(a))[0])}</span><div><strong>${escape(accountName(a))}</strong><p>${escape(a.label)} · ${escape(a.id)}</p></div></div><div class="button-row"><button class="button" id="setup-discover" ${busy?'disabled':''}>探索聊天室</button><button class="text-button" id="setup-manual">新增已知聊天室</button></div><div class="setup-chat-list">${rooms.length?rooms.map(c=>`<label class="setup-chat"><input type="checkbox" data-setup-chat="${escape(c.id)}" ${chosen.has(c.id)?'checked':''} ${busy?'disabled':''}><span><strong>${escape(c.name)}</strong><small>${escape(c.kind)} · ${escape(c.id)}</small></span></label>`).join(''):'<p>按「探索聊天室」取得清單，或新增已知聊天室。</p>'}</div>`,bottom('返回帳號選擇',null,'確認權限',busy||!chosen.size));
      root.querySelectorAll('[data-setup-chat]').forEach(el=>el.addEventListener('change',()=>{if(el.checked)chosen.add(el.dataset.setupChat);else chosen.delete(el.dataset.setupChat);root.querySelector('#wizard-next').disabled=!chosen.size;}));
      listen('#setup-discover',async()=>{const id=a.id;busy=true;render();try{const next=await ctx.discover(id);if(account()?.id===id)rooms=next;}finally{busy=false;if(account()?.id===id)render();}});
      listen('#setup-manual',()=>ctx.openChat());
      listen('#wizard-back',()=>{step=1;mode='stored';render();});listen('#wizard-next',()=>{step=3;render();});return;
    }
    const setup=a.localSetup??{phase:'not_enabled'},selected=rooms.filter(c=>chosen.has(c.id));
    const active=setup.phase==='enabled',hasSetup=!['not_enabled','revoked'].includes(setup.phase);
    root.innerHTML=frame('確認並啟用 AI 讀取 + 傳送','此授權只限這台電腦上的 AI 用戶端與下列聊天室。LineBridge 自動保存受 OS 保護的 CLI 憑證。',`<div class="wizard-context"><span class="avatar">${escape(Array.from(accountName(a))[0])}</span><div><strong>${escape(accountName(a))}</strong><p>${escape(a.label)} · ${escape(a.id)}</p></div></div><div class="notice"><strong>允許：讀取訊息、封存搜尋與事件；傳送訊息</strong><p>持有本機設定檔的 AI 可在選定聊天室傳送訊息。啟用後會開始本機訊息接收與加密封存；AI 的自動工作排程需另行設定。</p><p>權限有效 90 天；到期或變更聊天室時，先停用再重新確認啟用。</p></div><ul class="setup-scope">${selected.map(c=>`<li><strong>${escape(c.name)}</strong><small>${escape(c.kind)} · ${escape(c.id)}</small></li>`).join('')}</ul><div id="setup-status" role="status" aria-live="polite"></div>${hasSetup?`<button class="button danger" id="setup-revoke" ${busy?'disabled':''}>停用並移除本機 AI 憑證</button>`:''}<div id="setup-ai-instructions"></div><details><summary>進階：遠端 AI / 手動設定</summary><p>雲端 AI 使用左側「API 金鑰與 AI 存取」及「雲端連線與通道」。本機設定檔不提供遠端存取。</p><button class="text-button" id="setup-advanced">開啟進階設定</button></details>`,bottom('修改聊天室',null,active?'已啟用讀取 + 傳送':'啟用 AI 讀取 + 傳送',busy||active||hasSetup||!selected.length||selected.length!==chosen.size||a.status!=='connected'));
    renderStatus();
    listen('#wizard-back',()=>{step=2;render();});
    listen('#setup-advanced',()=>ctx.go('access'));
    listen('#wizard-next',async()=>{if(busy)return;busy=true;render();try{await ctx.enable(a.id,{chatIds:[...chosen],read:true,send:true,confirmed:true});}finally{busy=false;render();}});
    listen('#setup-revoke',async()=>{if(busy)return;busy=true;render();try{await ctx.revoke(a.id);}finally{busy=false;render();}});
  }
  function renderStatus(){
    const a=account(),setup=a?.localSetup,target=root.querySelector('#setup-status');if(!target)return;
    const health={ready:'已就緒：所有選定接收串流均有近期成功紀錄',sandbox:'沙盒已啟用；不會連線至 LINE',waiting:'等待每一個接收串流首次成功',initializing:'正在建立接收起始位置',retrying:'接收串流重試中',stale:'接收紀錄已超過 60 秒',off:'接收已停止',disconnected:'帳號未連線',paused:'AI 存取已暫停',selection_changed:'聊天室選擇已變更；停用後重新確認',unavailable:'受保護憑證儲存無法使用',profile_conflict:'本機設定檔與此授權不符',endpoint_changed:'閘道連接埠已變更；停用後重新啟用',disabled:'存取未啟用或已撤銷／到期'};
    target.innerHTML=setup?.phase==='cleanup_required'?'<p>存取已撤銷。OS 憑證清理尚未完成；解鎖憑證儲存後再按停用重試。</p>':setup?.phase==='enabled'?`<p class="${setup.ready?'good':'muted'}">${escape(health[setup.health]??setup.health)}</p>${Object.values(setup.monitor?.streams??{}).map(s=>`<p>${escape(s.channel)} · ${escape(s.health)} · 最後成功：${escape(s.lastSuccessAt??'尚無紀錄')}</p>`).join('')}`:'<p>尚未啟用；請確認以上帳號、聊天室及權限。</p>';
    const instructions=root.querySelector('#setup-ai-instructions');
    if(instructions&&setup?.grantActive&&setup.credentialStatus==='protected'){
      if(!instructions.querySelector('textarea'))instructions.innerHTML='<h3>交給這台電腦上的 AI</h3><p>使用已保存的設定檔即可；不需要複製金鑰或開啟 Terminal。</p><textarea aria-label="本機 AI 指令" rows="7" readonly></textarea><button class="button" id="setup-copy">複製 AI 指令</button><span id="setup-copy-status" role="status"></span>';
      instructions.querySelector('textarea').value=localCliInstructions(a);
      instructions.querySelector('#setup-copy').onclick=()=>action(async()=>{const el=instructions.querySelector('textarea');try{await navigator.clipboard.writeText(el.value);}catch{el.select();if(!document.execCommand('copy'))throw new Error('請選取並複製 AI 指令。');}instructions.querySelector('#setup-copy-status').textContent='已複製';});
    }else if(instructions)instructions.innerHTML='';

  }
  return {
    render,
    cancelNewAccount(){awaitingNew=false;if(step===1)waiting=false;},
    accountAdded(){if(waiting){awaitingNew=false;mode='connect';if(account()?.status==='connected'){waiting=false;step=2;}render();}},
    sync(){
      if(waiting&&!awaitingNew&&account()?.status==='connected'){waiting=false;step=2;render();}
      else if(step===2){const next=ctx.getChats();if(JSON.stringify(next)!==JSON.stringify(rooms)){rooms=next;render();}}
      else if(step===3){renderStatus();}
      else if(step===1&&mode==='stored'){const next=JSON.stringify((ctx.getState()?.accounts ?? []).map(a=>[a.id,a.status,a.profile?.displayName]));if(next!==lastPicker)render();}
    },
    get step(){return step;}
  };
}
