import {accountName} from './names.js';
import {icon} from './icons.js';
import {formTimeRange} from './search-time.js';

export function createArchive({api,action,escape,when,short,getState,openChat}){
  const $=s=>document.querySelector(s),form=$('#archive-form');
  let signature,criteria,before=null,busy=false,results=[],generation=0,searchGeneration=0;
  // Marks every case-insensitive occurrence of the searched terms in escaped text.
  function highlight(text){
    const value=String(text??''),lower=value.toLocaleLowerCase();
    const terms=(criteria?.mode==='phrase'?[criteria.query]:String(criteria?.query??'').split(/\s+/)).map(t=>t.toLocaleLowerCase()).filter(Boolean);
    if(!terms.length||lower.length!==value.length)return escape(value);
    const ranges=[];
    for(const term of terms)for(let at=lower.indexOf(term);at>=0;at=lower.indexOf(term,at+term.length))ranges.push([at,at+term.length]);
    ranges.sort((a,b)=>a[0]-b[0]);
    let html='',cursor=0;
    for(const [start,end] of ranges){if(start<cursor)continue;html+=`${escape(value.slice(cursor,start))}<mark>${escape(value.slice(start,end))}</mark>`;cursor=end;}
    return html+escape(value.slice(cursor));
  }
  function render(){
    const state=getState();if(!state)return;
    $('#archive-count').textContent=`已封存 ${state.accounts.reduce((n,a)=>n+(a.monitor?.storedMessages||0),0).toLocaleString('zh-TW')} 則`;
    const next=JSON.stringify(state.accounts.map(a=>[a.id,accountName(a)]));if(next===signature)return;signature=next;
    const selected=form.elements.accountId.value;
    form.elements.accountId.innerHTML='<option value="">所有帳號</option>'+state.accounts.map(a=>`<option value="${escape(a.id)}">${escape(accountName(a))}${a.kind==='demo'?' · 沙盒':''}</option>`).join('');
    if(state.accounts.some(a=>a.id===selected))form.elements.accountId.value=selected;
  }
  async function chats(){
    const account=form.elements.accountId.value,version=++generation;
    form.elements.chatId.innerHTML='<option value="">所有聊天室</option>';form.elements.chatId.disabled=!account;
    if(!account)return;
    const rooms=await api(`/accounts/${encodeURIComponent(account)}/chats`);
    if(version!==generation)return;
    form.elements.chatId.innerHTML+=rooms.map(c=>`<option value="${escape(c.id)}">${escape(c.name)}${c.enabled?'':' · 未開放'}</option>`).join('');
  }
  async function search(more=false){
    if(busy)return;
    if(more&&(!criteria||before===null))return;
    if(!more){
      const f=form.elements;
      let timeRange;try{timeRange=formTimeRange(f.startTime.value,f.endTime.value,f.timeOffset.value);}catch(error){$('#archive-status').textContent=error.message;throw error;}
      criteria={query:f.query.value.trim(),mode:f.mode.value,limit:30,...timeRange,...(f.accountId.value?{accountId:f.accountId.value}:{}),...(f.chatId.value?{chatId:f.chatId.value}:{})};
      if(!criteria.query)return;before=null;results=[];$('#archive-results').replaceChildren();$('#archive-more').hidden=true;
    }
    const requestGeneration=++searchGeneration,shown=results.length;
    busy=true;$('#archive-submit').disabled=true;$('#archive-more').disabled=true;$('#archive-status').textContent='搜尋中…';
    try{
      const found=await api('/messages/search',{method:'POST',body:JSON.stringify({...criteria,...(more&&before?{before}:{})})});
      if(requestGeneration!==searchGeneration)return;
      results.push(...found.results);before=found.nextBefore;$('#archive-more').hidden=!found.hasMore;
      $('#archive-status').textContent=results.length?`找到 ${results.length} 則${found.hasMore?'，還有更早的訊息':''}`:found.hasMore?'這一頁沒有符合的訊息，可載入更早的訊息。':'';
      $('#archive-results').innerHTML=results.length?results.map((r,i)=>`<article class="result${i>=shown?' fresh':''}"><div class="result-head"><button class="result-chat" data-archive-open="${i}">${escape(r.chatName)}${icon('chevronRight')}</button><span>${escape(accountName(getState().accounts.find(a=>a.id===r.accountId)))}</span><time title="${escape(when(r.message.timestamp||r.receivedAt))}">${escape(short(r.message.timestamp||r.receivedAt))}</time></div><p class="result-sender">${escape(r.message.senderName||'未取得暱稱')}</p><div class="result-text" dir="auto">${highlight(r.message.text)}</div></article>`).join(''):found.hasMore?'':`<div class="empty compact"><span class="empty-icon">${icon('search')}</span><h3>沒有符合的訊息</h3><p>試試其他關鍵字，或改用「所有關鍵字」。</p></div>`;
      $('#archive-results').querySelectorAll('[data-archive-open]').forEach(button=>button.addEventListener('click',()=>action(()=>{const r=results[Number(button.dataset.archiveOpen)];return openChat(r.accountId,r.chatId);})));
    }catch(error){if(requestGeneration!==searchGeneration)return;$('#archive-status').textContent='搜尋未完成，請重試。';throw error;}
    finally{busy=false;$('#archive-submit').disabled=false;$('#archive-more').disabled=false;}
  }
  form.addEventListener('submit',event=>{event.preventDefault();return action(()=>search());});
  form.elements.accountId.addEventListener('change',()=>action(chats));
  function invalidate(){++searchGeneration;criteria=null;before=null;$('#archive-more').hidden=true;$('#archive-status').textContent='條件已變更，請重新搜尋。';}
  form.addEventListener('input',invalidate);
  form.addEventListener('change',invalidate);
  $('#archive-clear-time').addEventListener('click',()=>{form.elements.startTime.value='';form.elements.endTime.value='';invalidate();$('#archive-status').textContent='已清除時間範圍，請重新搜尋。';});
  $('#archive-more').addEventListener('click',()=>action(()=>search(true)));
  return {render,async open(accountId,chatId){
    ++searchGeneration;
    render();form.elements.accountId.value=accountId;await chats();
    if(form.elements.accountId.value!==accountId)return;
    form.elements.chatId.value=chatId;before=null;criteria=null;results=[];
    form.elements.startTime.value='';form.elements.endTime.value='';
    $('#archive-results').replaceChildren();$('#archive-more').hidden=true;
    $('#archive-status').textContent='輸入關鍵字，搜尋這個聊天室的封存。';
    form.elements.query.focus();
  }};
}
