export function senderName(message,account,chat){
  if(message.senderId&&message.senderId===account?.profile?.mid)return '我';
  if(typeof message.senderName==='string'&&message.senderName.trim())return message.senderName;
  if(chat?.kind==='direct'&&message.senderId===chat.id&&chat.name&&chat.name!==chat.id)return chat.name;
  return message.senderId?'名稱暫時無法取得':'系統訊息';
}
export function accountName(account){return account?.profile?.displayName || account?.label || '帳號';}
export function chatName(chat){return chat?.name&&chat.name!==chat.id?chat.name:chat?.kind==='openchat'?'未命名的 OpenChat':chat?.kind==='group'?'未命名群組':'名稱暫時無法取得';}
