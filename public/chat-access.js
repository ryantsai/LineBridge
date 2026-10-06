// Only this permission flow has a deadline; unrelated dashboard requests retain
// their existing behavior. A lost PATCH response is reconciled, never retried.
export async function toggleChatAccess({accountId,chatId,enabled,confirm=message=>globalThis.confirm(message),fetcher=globalThis.fetch,timeoutMs=8000,onState=()=>{}}){
  const path=`/admin/accounts/${encodeURIComponent(accountId)}/chats/${encodeURIComponent(chatId)}`;
  async function request(url,body){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
    try{
      const response=await fetcher(url,{signal:controller.signal,...(body?{method:'PATCH',headers:{'Content-Type':'application/json','X-Line-Bridge':'dashboard'},body:JSON.stringify(body)}:{})});
      const value=await response.json();if(!response.ok)throw new Error(value.message||value.error||'授權狀態讀取失敗');return value;
    }finally{clearTimeout(timer);}
  }
  const preview=await request(`${path}/access`);onState(preview);
  if(enabled&&preview.setupRequired)throw new Error('請先到「連線」明確啟用或修復本機 AI 設定，再開啟此聊天。此操作不會建立憑證。');
  const scope=enabled?[...new Set([...preview.chatIds,chatId])]:preview.chatIds.filter(id=>id!==chatId);
  const effective=preview.managed&&preview.gatewayEnabled?scope.filter(id=>id===chatId?enabled:preview.selectedChatIds.includes(id)):[];
  const message=`${enabled?'開啟監控，並允許本機 AI 讀取／傳送':'關閉監控，並移除此聊天的本機 AI 讀取／傳送權限'}？\n\n聊天：${preview.chat.name}\nID：${chatId}\n類型：${preview.chat.kind}\nProfile：${preview.profile??'尚未設定'}\n\n變更後儲存的聊天室範圍（${scope.length}）：\n${scope.join('\n')||'無'}\n\n變更後可讀取／傳送的聊天室（${effective.length}）：\n${effective.join('\n')||'無（未授權或 AI 存取已暫停）'}\n\n開啟只更新既有本機 profile；關閉監控也會阻擋其他客戶端存取此聊天。已儲存授權不代表 LINE 正在接收訊息。`;
  if(!await confirm(message))return {cancelled:true,state:preview};
  try{
    const saved=await request(path,{enabled,confirmed:true,snapshot:preview.snapshot});onState(saved);return {saved:true,state:saved};
  }catch(error){
    // Even an explicit error may race another operator. Display authoritative
    // state if available; never claim that a failed request left scope unchanged.
    let current;try{current=await request(`${path}/access`);onState(current);}catch{}
    throw new Error(current?`${error.message}；已重新讀取儲存狀態，請確認後再操作。`:'操作結果未確認。請重新讀取授權狀態後再操作；不要假設權限未變更。');
  }
}
