export function sendIntent(previous,accountId,chatId,text,newKey=()=>crypto.randomUUID()) {
  if(previous?.accountId===accountId && previous.chatId===chatId && previous.text===text) return previous;
  return {accountId,chatId,text,key:newKey()};
}
