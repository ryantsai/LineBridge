import {accountName} from './names.js';
import {icon} from './icons.js';

export function createArchive({api,action,escape,when,getState,openChat}){
  const $=s=>document.querySelector(s),form=$('#archive-form');
  let signature,criteria,before=null,busy=false,results=[],generation=0,searchGeneration=0;
  function render(){
    const state=getState();if(!state)return;
    $('#archive-count').textContent=`已封存 ${state.accounts.reduce((n,a)=>n+(a.monitor?.storedMessages||0),0).toLocaleString('zh-TW')} 則訊息`;
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
    form.elements.chatId.innerHTML+='<option disabled>─────</option>'+rooms.map(c=>`<option value="${escape(c.id)}">${escape(c.name)}${c.enabled?'':' · 未指定'}</option>`).join('');
  }
  async function search(more=false){
    if(busy)return;
    if(!more){
      const f=form.elements;criteria={query:f.query.value.trim(),mode:f.mode.value,limit:30,...(f.accountId.value?{accountId:f.accountId.value}:{}),...(f.chatId.value?{chatId:f.chatId.value}:{})};
      if(!criteria.query)return;before=null;results=[];$('#archive-results').replaceChildren();
    }
    const requestGeneration=++searchGeneration;
    busy=true;$('#archive-submit').disabled=true;$('#archive-more').disabled=true;$('#archive-status').textContent='正在搜尋加密封存…';
    try{
      const found=await api('/messages/search',{method:'POST',body:JSON.stringify({...criteria,...(more&&before?{before}:{})})});
      if(requestGeneration!==searchGeneration)return;
      results.push(...found.results);before=found.nextBefore;$('#archive-more').hidden=!found.hasMore;
      $('#archive-status').textContent=results.length?`找到 ${results.length} 則訊息${found.hasMore?' · 可繼續載入較早的訊息':''}`:found.hasMore?'目前這一頁沒有符合的訊息，請繼續載入較早的訊息。':'沒有符合的已封存訊息。';
      $('#archive-results').innerHTML=results.map((r,i)=>`<article class="archive-result"><div class="archive-result-heading"><button class="text-button" data-archive-open="${i}">${escape(r.chatName)}${icon('caret-right')}</button><span>${escape(accountName(getState().accounts.find(a=>a.id===r.accountId)))}</span><time>${escape(when(r.message.timestamp||r.receivedAt))}</time></div><p class="archive-sender">${escape(r.message.senderName||'未取得暱稱')}</p><div class="archive-text" dir="auto">${escape(r.message.text)}</div></article>`).join('');
      $('#archive-results').querySelectorAll('[data-archive-open]').forEach(button=>button.addEventListener('click',()=>action(()=>{const r=results[Number(button.dataset.archiveOpen)];return openChat(r.accountId,r.chatId);})));
    }catch(error){if(requestGeneration!==searchGeneration)return;$('#archive-status').textContent='搜尋未完成。請重試。';throw error;}
    finally{busy=false;$('#archive-submit').disabled=false;$('#archive-more').disabled=false;}
  }
  form.addEventListener('submit',event=>{event.preventDefault();action(()=>search());});
  form.elements.accountId.addEventListener('change',()=>action(chats));
  form.addEventListener('input',()=>{$('#archive-more').hidden=true;});
  $('#archive-more').addEventListener('click',()=>action(()=>search(true)));
  return {render,async open(accountId,chatId){
    ++searchGeneration;
    render();form.elements.accountId.value=accountId;await chats();
    if(form.elements.accountId.value!==accountId)return;
    form.elements.chatId.value=chatId;before=null;criteria=null;results=[];
    $('#archive-results').replaceChildren();$('#archive-more').hidden=true;
    $('#archive-status').textContent='輸入關鍵字，搜尋這個聊天室的已封存訊息。';
    form.elements.query.focus();
  }};
}
