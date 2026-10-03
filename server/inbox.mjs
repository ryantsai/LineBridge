import {randomUUID} from 'node:crypto';
import {fail} from './errors.mjs';
import {indexMessage} from './search.mjs';

export function capture(store,vault,account,chat,message){
  if(!message||typeof message.id!=='string'||!message.id||message.id.length>150||JSON.stringify(message).length>100000)fail(502,'invalid_message','Invalid incoming message.');
  return store.transaction(()=>{
    if(!store.setting(`monitor:${account}`,false)||!store.chat(account,chat)?.enabled)return null;
    const eventId=randomUUID(),cipher=vault.seal(message,`message:${eventId}`);
    const inserted=store.db.prepare('INSERT OR IGNORE INTO messages(event_id,account_id,chat_id,message_id,cipher,at) VALUES(?,?,?,?,?,?)').run(eventId,account,chat,message.id,cipher,new Date().toISOString());
    if(!inserted.changes)return null;
    indexMessage(store,vault,Number(inserted.lastInsertRowid),message);
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
export function monitorStatus(store,account,streams={},connectionStatus='connected'){
  const enabled=store.setting(`monitor:${account}`,false),now=Date.now(),staleAfterMs=60000;
  const demo=store.account(account)?.kind==='demo',chats=store.chats(account).filter(c=>c.enabled);
  // Include every designated stream, even before its first event, so one active
  // room cannot hide another room that never started or stopped responding.
  const channels=demo?['demo']:[...new Set(chats.map(c=>c.kind==='openchat'?c.id:'talk'))];
  streams=Object.fromEntries(channels.map(channel=>{
    const stream=streams[channel]??{channel,status:'waiting'},lastSuccessAt=stream.lastSuccessAt??null;
    const age=lastSuccessAt?now-Date.parse(lastSuccessAt):null;
    const health=!enabled?'off':connectionStatus!=='connected'?'disconnected':demo?'sandbox':stream.status==='retrying'?'retrying':age===null||!['running','polling','initializing'].includes(stream.status)?'waiting':age>staleAfterMs?'stale':stream.ready===false||stream.status==='initializing'?'initializing':'healthy';
    return [channel,{...stream,channel,lastAttemptAt:stream.lastAttemptAt??null,lastSuccessAt,health}];
  }));
  const values=Object.values(streams);
  const health=!enabled?'off':connectionStatus!=='connected'?'disconnected':demo?'sandbox':!values.length?'no_chats':
    ['retrying','stale','waiting','initializing'].find(status=>values.some(s=>s.health===status))??'healthy';
  const counts=store.db.prepare('SELECT COUNT(*) AS storedMessages,COALESCE(MAX(seq),0) AS lastSequence,MAX(at) AS lastMessage FROM messages WHERE account_id=?').get(account);
  return {enabled,status:!enabled?'off':connectionStatus!=='connected'?'disconnected':values.some(v=>v.status==='retrying')?'retrying':values.some(v=>['running','polling'].includes(v.status))?'running':'waiting',health,checkedAt:new Date(now).toISOString(),staleAfterMs,streams,...counts,retention:null,retentionPolicy:'until_account_removed',searchable:true};
}
