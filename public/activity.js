import {label} from './locale.js';

const failures={timeout:'逾時',cancelled:'已取消',network:'網路異常',protocol:'LINE 回應異常',storage:'儲存異常',capture:'封存異常',auth:'授權失效',service:'服務異常',unknown:'未知錯誤'};
const stages={poll:'取得資料',process:'處理資料',capture:'封存訊息',checkpoint:'儲存游標'};

export function debugDescription(details,when){
  if(!details)return '';
  const parts=[];
  if(details.channel)parts.push(details.channel==='talk'?'一對一與群組':'OpenChat');
  if(details.status)parts.push(label(details.status));
  if(details.durationMs!==undefined)parts.push(`${details.durationMs.toLocaleString('zh-TW')} ms`);
  if(details.accounts!==undefined)parts.push(`帳號 ${details.connected} / ${details.accounts} 已連線`);
  if(details.monitoring!==undefined)parts.push(`${details.monitoring} 個帳號開啟監聽`);
  if(details.storedMessages!==undefined)parts.push(`封存 ${details.storedMessages.toLocaleString('zh-TW')} 則`);
  if(details.messages!==undefined)parts.push(`讀取 ${details.messages} 則`);
  if(details.gatewayEnabled!==undefined)parts.push(details.gatewayEnabled?'AI 閘道可使用':'AI 閘道已暫停');
  if(details.intervalSeconds!==undefined)parts.push(`更新間隔 ${details.intervalSeconds} 秒`);
  if(details.pollTimeoutMs!==undefined)parts.push(`逾時門檻 ${details.pollTimeoutMs/1000} 秒`);
  if(details.lastSuccessAt)parts.push(`上次成功 ${when(details.lastSuccessAt)}`);
  if(details.failureKind)parts.push(failures[details.failureKind]??'未知錯誤');
  if(details.stage)parts.push(stages[details.stage]??details.stage);
  if(details.retryInMs!==undefined)parts.push(`${details.retryInMs/1000} 秒後重試`);
  if(details.httpStatus!==undefined)parts.push(`HTTP ${details.httpStatus}`);
  return parts.join(' · ');
}

export function createActivity({getState,api,action,toast,refresh,escape,when,short}){
  const toggle=document.querySelector('#debug-logging'),status=document.querySelector('#debug-logging-status'),list=document.querySelector('#audit-list');
  let saving=false,previous;
  function render(){
    const state=getState();if(!state)return;
    toggle.setAttribute('aria-checked',String(state.debugLogging?.enabled===true));toggle.disabled=saving;
    status.textContent=state.debugLogging?.enabled?'已開啟：記錄每次畫面更新、LINE 輪詢與帳號驗證的狀態及耗時。':'開啟後，將記錄每次更新的狀態、耗時與錯誤類型。';
    const actorName=id=>id==='system'?'系統':id==='local-admin'?'本機管理介面':id==='local-agent'?'本機 AI':state.tokens.find(t=>t.id===id)?.name||'AI 用戶端';
    const html=state.audit.length?state.audit.map(row=>{
      const debug=row.action.startsWith('debug.')&&row.action!=='debug.toggle',kind=['ok','enabled'].includes(row.outcome)?'good':['failed','rejected','unknown'].includes(row.outcome)?'danger':'';
      return `<tr${debug?' class="debug-record"':''}><td><time title="${escape(when(row.at))}">${escape(debug?when(row.at):short(row.at))}</time></td><td>${debug?'<span class="tag debug-tag">DEBUG</span>':''}${escape(label(row.action))}${row.details?`<small class="debug-detail">${escape(debugDescription(row.details,when))}</small>`:''}</td><td>${escape(state.accounts.find(a=>a.id===row.account_id)?.label||'—')}${row.chat_id?`<small>${escape(row.chat_id.slice(0,20))}</small>`:''}</td><td>${escape(actorName(row.actor))}</td><td><span class="result-state"><span class="dot ${kind}"></span>${escape(label(row.outcome))}</span></td></tr>`;
    }).join(''):'<tr><td colspan="5" class="table-empty">尚無紀錄</td></tr>';
    if(html!==previous){list.innerHTML=html;previous=html;}
  }
  toggle.addEventListener('click',()=>action(async()=>{
    if(saving)return;saving=true;toggle.disabled=true;
    try{
      const settings=await api('/debug-settings',{method:'PUT',body:JSON.stringify({enabled:!getState()?.debugLogging?.enabled})});
      getState().debugLogging=settings;render();
      toast(settings.enabled?'已開啟除錯紀錄':'已關閉除錯紀錄');
      await refresh();
    }finally{saving=false;render();}
  }));
  return {render};
}
