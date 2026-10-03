import {icon} from './icons.js';
import {accountName} from './names.js';
import {aiInstructionsCard,renderAiInstructions} from './ai-instructions.js';

export function createWizard(ctx){
  const {escape,action,nice}=ctx;
  const root=document.querySelector('#wizard-content');
  let step=1,mode='welcome',waiting=false,awaitingNew=false,lastPicker='';
  const account=()=>ctx.getState()?.accounts.find(a=>a.id===ctx.getSelected());
  function listen(selector,job){root.querySelector(selector)?.addEventListener('click',()=>action(job));}
  function bottom(back,next,label='繼續',disabled=false){return `<div class="wizard-bottom"><button class="text-button" id="wizard-back">${icon('caret-left')}${back}</button><button class="button primary" id="wizard-next" ${disabled?'disabled':''}>${label}${icon('caret-right')}</button></div>`;}
  function frame(title,intro,body,buttons){return `<div class="wizard-inner"><div class="wizard-kicker">步驟 ${step} / 2</div><h2>${title}</h2><p class="wizard-intro">${intro}</p><div class="wizard-body">${body}</div>${buttons}</div>`;}
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
      root.innerHTML=frame('恢復你的帳號連線','使用已儲存的憑證，或重新掃描 QR Code。',`<div class="wizard-context"><span class="avatar">${escape(Array.from(accountName(a))[0])}</span><div><strong>${escape(accountName(a))}</strong><p>${escape(nice(a?.status))}</p></div></div><div class="wizard-choice">${icon('plug')}<div><h3>準備連接帳號</h3><p>完成連線即完成帳號綁定。聊天室與 AI 存取可稍後從左側選單管理。</p><div class="button-row">${a?.canResume?'<button class="button primary" id="wizard-resume">恢復已儲存的工作階段</button>':''}<button class="button" id="wizard-login">${a?.kind==='demo'?'連接沙盒':'使用 QR Code 連線'}</button></div></div></div>`,bottom('選擇其他帳號',null,'繼續',a?.status!=='connected'));
      listen('#wizard-back',()=>{mode='stored';waiting=false;render();});listen('#wizard-resume',()=>ctx.connect(false));listen('#wizard-login',()=>ctx.connect(true));listen('#wizard-next',()=>{step=2;waiting=false;render();});return;
    }
    root.innerHTML=frame('帳號已綁定，開始使用 LineBridge','你可以立即在本機瀏覽聊天室。需要雲端 AI 時，再從左側設定 API 金鑰與通道。',`<div class="wizard-context"><span class="avatar">${escape(Array.from(accountName(a))[0])}</span><div><strong>${escape(accountName(a))}</strong><p>${a.kind==='demo'?'模擬沙盒 · 不會連線至 LINE':escape(nice(a.status))}</p></div></div><div class="wizard-next-actions"><button class="button" id="wizard-another">${icon('plus')}綁定另一個帳號</button><button class="text-button" id="wizard-archive">搜尋訊息封存${icon('caret-right')}</button></div>${aiInstructionsCard('wizard-ai-prompt')}`,bottom('返回帳號選擇',null,'瀏覽聊天室'));
    renderAiInstructions(root,ctx.getState(),ctx.getSelected(),action);
    listen('#wizard-back',()=>{step=1;mode='stored';render();});
    listen('#wizard-another',()=>{step=1;mode='stored';waiting=true;awaitingNew=true;render();ctx.openAccount();});
    listen('#wizard-archive',()=>ctx.go('archive'));
    listen('#wizard-next',()=>ctx.go('accounts'));
  }
  return {
    render,
    cancelNewAccount(){awaitingNew=false;if(step===1)waiting=false;},
    accountAdded(){if(waiting){awaitingNew=false;mode='connect';if(account()?.status==='connected'){waiting=false;step=2;}render();}},
    sync(){
      if(waiting&&!awaitingNew&&account()?.status==='connected'){waiting=false;step=2;render();}
      else if(step===2){renderAiInstructions(root,ctx.getState(),ctx.getSelected(),action);}
      else if(step===1&&mode==='stored'){const next=JSON.stringify((ctx.getState()?.accounts ?? []).map(a=>[a.id,a.status,a.profile?.displayName]));if(next!==lastPicker)render();}
    },
    get step(){return step;}
  };
}
