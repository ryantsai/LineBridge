import {randomUUID} from 'node:crypto';
import {fail} from './errors.mjs';

export function capture(store,vault,account,chat,message){
  if(!message||typeof message.id!=='string'||!message.id||message.id.length>150||JSON.stringify(message).length>100000)fail(502,'invalid_message','Invalid incoming message.');
  return store.transaction(()=>{
    if(!store.setting(`monitor:${account}`,false)||!store.chat(account,chat)?.enabled)return null;
    const eventId=randomUUID(),cipher=vault.seal(message,`message:${eventId}`);
    const inserted=store.db.prepare('INSERT OR IGNORE INTO messages(event_id,account_id,chat_id,message_id,cipher,at) VALUES(?,?,?,?,?,?)').run(eventId,account,chat,message.id,cipher,new Date().toISOString());
    if(!inserted.changes)return null;
    store.db.prepare('DELETE FROM messages WHERE account_id=? AND seq NOT IN (SELECT seq FROM messages WHERE account_id=? ORDER BY seq DESC LIMIT 1000)').run(account,account);
    return Number(inserted.lastInsertRowid);
  });
}
export function cachedNames(store,vault,account){
  const cipher=store.secret(account,'bridge.aliases.v1');
  try{return new Map((cipher?vault.unseal(cipher,`${account}:bridge.aliases.v1`):[]).slice(0,1000).filter(([,entry])=>entry.expires>Date.now()&&entry.name));}catch{return new Map();}
}
export function enrich(message,kind,names){
  const entry=names.get(`${kind==='openchat'?'square':'talk'}:${message.senderId}`);
  if(entry){message.senderName=entry.name;message.senderNameSource=entry.source;if(entry.profileName)message.senderProfileName=entry.profileName;}
  message.senderNameStatus=message.senderName?.trim()?'resolved':message.senderId?'unavailable':'system';return message;
}
export function inboxMessages(store,vault,account,chat,limit){
  const names=cachedNames(store,vault,account),kind=store.chat(account,chat)?.kind;
  return store.db.prepare('SELECT event_id,cipher FROM messages WHERE account_id=? AND chat_id=? ORDER BY seq DESC LIMIT ?').all(account,chat,limit).reverse().map(row=>enrich(vault.unseal(row.cipher,`message:${row.event_id}`),kind,names));
}
export function monitorStatus(store,account,streams={}){
  const enabled=store.setting(`monitor:${account}`,false),values=Object.values(streams);
  const counts=store.db.prepare('SELECT COUNT(*) AS storedMessages,COALESCE(MAX(seq),0) AS lastSequence,MAX(at) AS lastMessage FROM messages WHERE account_id=?').get(account);
  return {enabled,status:!enabled?'off':values.some(v=>v.status==='retrying')?'retrying':values.some(v=>['running','polling'].includes(v.status))?'running':'waiting',streams,...counts,retention:1000};
}
