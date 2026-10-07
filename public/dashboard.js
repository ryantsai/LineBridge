import {icon} from './icons.js';
import {accountName} from './names.js';
import {label} from './locale.js';
import {providerName} from './connections.js';

const number=value=>value.toLocaleString('zh-TW');

export function dashboardSummary(state){
  const accounts=state.accounts;
  return {
    accounts:accounts.length,
    connected:accounts.filter(a=>a.status==='connected').length,
    chats:accounts.reduce((sum,a)=>sum+(state.chatCounts?.[a.id]??a.designatedChats),0),
    monitored:accounts.reduce((sum,a)=>sum+a.designatedChats,0),
    messages:accounts.reduce((sum,a)=>sum+(a.monitor?.storedMessages??0),0),
    listening:accounts.filter(a=>a.monitor?.enabled&&a.status==='connected').length
  };
}

export function dashboardMarkup(state,escape){
  const summary=dashboardSummary(state);
  const metric=(name,value,detail,glyph)=>`<div class="stat"><span class="stat-label">${icon(glyph)}${name}</span><strong>${number(value)}</strong><small>${detail}</small></div>`;
  const ring=(title,value,total,active,rest)=>{
    const percent=total?Math.round(value/total*100):0;
    return `<article class="panel section dashboard-chart"><div class="section-head"><h2>${title}</h2><span class="muted">${total?`${percent}%`:'尚無資料'}</span></div><div class="ring-chart"><svg viewBox="0 0 160 160" aria-hidden="true"><circle class="ring-track" cx="80" cy="80" r="64"/><circle class="ring-value" cx="80" cy="80" r="64" pathLength="100" stroke-dasharray="${percent} ${100-percent}" transform="rotate(-90 80 80)"/></svg><div class="ring-label"><strong>${number(value)}</strong><span>${active}</span></div></div><dl class="chart-legend"><div><dt><span class="dot good"></span>${active}</dt><dd>${number(value)}</dd></div><div><dt><span class="dot"></span>${rest}</dt><dd>${number(total-value)}</dd></div></dl></article>`;
  };
  const maxMessages=Math.max(1,...state.accounts.map(a=>a.monitor?.storedMessages??0));
  const tokens=state.tokens.filter(t=>!t.revoked&&Date.parse(t.expires_at)>Date.now()).length;
  const services=[
    ['AI 閘道',state.gateway.enabled?'可使用':'已暫停',state.gateway.enabled?'good':'warn','access','bolt'],
    ['AI 存取',state.gateway.authentication==='local'?'本機存取':`${tokens} 個有效權杖`,state.gateway.authentication==='local'||tokens?'good':'','access','key'],
    ['雲端連線',`${providerName(state.tunnel.provider)} · ${state.tunnel.connected?'已連線':'未連線'}`,state.tunnel.connected?'good':'','tunnel','cloud']
  ];
  return `<div class="stats dashboard-stats">
    ${metric('已連線帳號',summary.connected,`共 ${number(summary.accounts)} 個帳號`,'users')}
    ${metric('AI 監控聊天室',summary.monitored,`共 ${number(summary.chats)} 個聊天室`,'chats')}
    ${metric('已封存訊息',summary.messages,'加密保存在這台電腦','inbox')}
    ${metric('監聽中帳號',summary.listening,`每 ${state.refresh?.intervalSeconds??15} 秒更新`,'pulse')}
  </div>
  ${!summary.accounts?`<div class="panel dashboard-welcome"><span class="empty-icon">${icon('chats')}</span><div><h2>從第一個 LINE 帳號開始</h2><p class="muted">使用設定精靈連接帳號、選擇聊天室並啟用 AI。</p></div><button class="btn" data-go="setup">開始設定${icon('arrowRight')}</button></div>`:''}
  <div class="dashboard-charts">
    ${ring('帳號連線',summary.connected,summary.accounts,'已連線','未連線')}
    ${ring('AI 監控範圍',summary.monitored,summary.chats,'AI 監控','未由 AI 監控')}
    <article class="panel section dashboard-archive"><div class="section-head"><h2>各帳號封存量</h2><button class="link-btn" data-go="archive">搜尋${icon('chevronRight')}</button></div><p class="muted">累計已儲存的訊息</p><div class="archive-bars">${state.accounts.length?state.accounts.map(a=>`<div class="archive-bar"><div><span title="${escape(accountName(a))}">${escape(accountName(a))}${a.kind==='demo'?' · 沙盒':''}</span><strong>${number(a.monitor?.storedMessages??0)} <small>則</small></strong></div><progress max="${maxMessages}" value="${a.monitor?.storedMessages??0}" aria-label="${escape(accountName(a))}的封存訊息"></progress></div>`).join(''):'<div class="chart-empty">連接帳號後，封存量會顯示在這裡。</div>'}</div></article>
  </div>
  <div class="dashboard-services">${services.map(([name,value,tone,page,glyph])=>`<button class="panel dashboard-service" data-go="${page}"><span class="service-icon">${icon(glyph)}</span><span><strong>${name}</strong><small><span class="dot ${tone}"></span>${escape(value)}</small></span>${icon('chevronRight')}</button>`).join('')}</div>
  <div class="panel section dashboard-accounts"><div class="section-head"><h2>帳號狀態</h2><button class="link-btn" data-go="accounts">管理聊天室${icon('chevronRight')}</button></div>${state.accounts.length?state.accounts.map(a=>`<div class="dashboard-account"><span class="dot ${a.status==='connected'?'good':a.status==='error'?'danger':''}"></span><div><strong>${escape(accountName(a))}</strong><small>${escape(label(a.status))}${a.kind==='demo'?' · 沙盒':''}</small></div><span>${number(a.designatedChats)} 個 AI 聊天室</span><span class="badge ${a.monitor?.enabled?(a.status==='connected'?'good':'warn'):''}">${a.monitor?.enabled?(a.status==='connected'?label(a.monitor.health==='healthy'?'polling':a.monitor.health==='sandbox'?'running':a.monitor.status):'等待連線'):'監聽已關閉'}</span></div>`).join(''):'<p class="muted">尚無帳號</p>'}</div>`;
}

export function createDashboard({getState,escape}){
  const root=document.querySelector('#dashboard-content');
  let previous;
  return {render(){
    const state=getState();if(!state)return;
    const html=dashboardMarkup(state,escape);
    if(html!==previous){root.innerHTML=html;previous=html;}
  }};
}
