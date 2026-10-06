import {createHmac} from 'node:crypto';
import {z} from 'zod';
import {instantMillis} from '../public/search-time.js';

export const searchTime=z.string().refine(value=>instantMillis(value)!==null,{message:'Use YYYY-MM-DDTHH:mm:ss[.SSS] with Z or an explicit UTC offset (maximum ±14:00).'});
export const searchInput=z.object({query:z.string().trim().min(1).max(200),mode:z.enum(['all','phrase']).default('all'),accountId:z.string().min(1).optional(),chatId:z.string().min(1).optional(),startTime:searchTime.optional(),endTime:searchTime.optional(),before:z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),limit:z.number().int().min(1).max(100).default(30)}).strict().refine(v=>!v.chatId||v.accountId,{message:'chatId requires accountId.'}).refine(v=>v.startTime===undefined||v.endTime===undefined||instantMillis(v.startTime)<instantMillis(v.endTime),{message:'startTime must be earlier than endTime (start inclusive, end exclusive).'});
export const normalizeText=text=>String(text??'').normalize('NFKC').toLowerCase().replace(/\s+/gu,' ').trim();
const hash=(vault,gram)=>'h'+createHmac('sha256',vault.key).update('LineBridge.search.v1\0').update(gram).digest('hex').slice(0,32);
function grams(text,size){const chars=Array.from(text),values=new Set();for(let i=0;i+size<=chars.length;i++)values.add(chars.slice(i,i+size).join(''));return values;}
export function indexMessage(store,vault,sequence,message){
  const text=normalizeText(message.text),tokens=new Set();
  for(const size of [1,2,3])for(const gram of grams(text,size))tokens.add(hash(vault,gram));
  store.db.prepare('INSERT OR REPLACE INTO message_search(rowid,terms) VALUES(?,?)').run(sequence,[...tokens].join(' '));
  store.db.prepare('UPDATE messages SET message_time=? WHERE seq=?').run(instantMillis(message.timestamp),sequence);
}
export function initializeSearch(store,vault){
  store.transaction(()=>{
    if(store.setting('messageSearchVersion',0)!==2)store.db.exec('DELETE FROM message_search');
    const missing=store.db.prepare('SELECT m.seq,m.event_id,m.cipher FROM messages m LEFT JOIN message_search s ON s.rowid=m.seq WHERE s.rowid IS NULL AND m.seq>? ORDER BY m.seq LIMIT 200');
    let after=0;
    for(;;){const rows=missing.all(after);if(!rows.length)break;for(const row of rows)indexMessage(store,vault,row.seq,vault.unseal(row.cipher,`message:${row.event_id}`));after=rows.at(-1).seq;}
    store.setSetting('messageSearchVersion',2);
  });
}
export function searchArchive(store,vault,input,accountIds,admin=false,grants=[]){
  const normalized=normalizeText(input.query),terms=input.mode==='phrase'?[normalized]:normalized.split(' ').filter(Boolean);
  if(!terms.length||!accountIds.length)return {results:[],hasMore:false,nextBefore:null,scanned:0};
  const tokens=new Set();for(const term of terms)for(const gram of grams(term,Math.min(3,Array.from(term).length)))tokens.add(hash(vault,gram));
  const filters=['message_search MATCH ?',`m.account_id IN (${accountIds.map(()=>'?').join(',')})`],args=[[...tokens].join(' AND '),...accountIds];
  if(!admin)filters.push('c.enabled=1');
  if(!admin&&grants.some(g=>g.chatIds)){
    filters.push(`(${accountIds.map(id=>{const scope=grants.find(g=>g.accountId===id)?.chatIds;args.push(id,...(scope??[]));return `(m.account_id=?${scope?` AND m.chat_id IN (${scope.map(()=>'?').join(',')})`:''})`;}).join(' OR ')})`);
  }
  if(input.chatId){filters.push('m.chat_id=?');args.push(input.chatId);}
  if(input.startTime!==undefined){filters.push('m.message_time>=?');args.push(instantMillis(input.startTime));}
  if(input.endTime!==undefined){filters.push('m.message_time<?');args.push(instantMillis(input.endTime));}
  if(input.before){filters.push('m.seq<?');args.push(input.before);}
  const candidates=store.db.prepare(`SELECT m.*,c.name,c.kind FROM message_search JOIN messages m ON m.seq=message_search.rowid JOIN chats c ON c.account_id=m.account_id AND c.id=m.chat_id WHERE ${filters.join(' AND ')} ORDER BY m.seq DESC LIMIT 501`).all(...args);
  const results=[];let scanned=0,last;
  for(const row of candidates.slice(0,500)){
    scanned++;last=row.seq;const message=vault.unseal(row.cipher,`message:${row.event_id}`),text=normalizeText(message.text);
    if(terms.every(term=>text.includes(term)))results.push({sequence:row.seq,accountId:row.account_id,chatId:row.chat_id,chatName:row.name,chatKind:row.kind,receivedAt:row.at,message});
    if(results.length===input.limit)break;
  }
  const hasMore=candidates.length>scanned;
  return {results,hasMore,nextBefore:hasMore?last:null,scanned};
}
