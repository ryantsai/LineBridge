export function sendIntent(previous,accountId,chatId,text,newKey=()=>crypto.randomUUID()) {
  if(previous?.accountId===accountId && previous.chatId===chatId && previous.text===text) return previous;
  return {accountId,chatId,text,key:newKey()};
}

export async function prepareSendIntent(previous,accountId,chatId,text,{capability,confirm,newKey}={}){
  // An uncertain attempt must keep both its key and its acknowledgment. Never
  // turn a repeated click into a new send because capability discovery changed.
  if(previous?.accountId===accountId&&previous.chatId===chatId&&previous.text===text)return previous;
  const info=await capability();
  if(info.officialAccount&&!await confirm())return null;
  const intent=sendIntent(null,accountId,chatId,text,newKey);
  if(info.officialAccount)intent.acknowledgeOaTransport=true;
  return intent;
}
