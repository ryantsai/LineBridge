// Account-local names. Square member identities remain separate from Talk users.
const STORAGE_KEY='bridge.aliases.v1',MAX_ENTRIES=1000,BATCH_SIZE=100;
const POSITIVE_TTL=60*60*1000,NEGATIVE_TTL=60*1000,LOOKUP_TIMEOUT=8000;
const clean=value=>typeof value==='string'?value.trim().slice(0,512):'';
export function contactName(contact){return clean(contact?.displayNameOverridden)||clean(contact?.displayName);}

export class AliasResolver{
  constructor(client,storage,{now=Date.now,timeout=LOOKUP_TIMEOUT}={}){
    this.client=client;this.storage=storage;this.now=now;this.timeout=timeout;this.cache=new Map();this.pending=new Map();this.dirty=false;
  }
  key(kind,id){return `${kind==='openchat'?'square':'talk'}:${id}`;}
  async load(){
    if(!this.loading)this.loading=(async()=>{try{const entries=await this.storage?.get(STORAGE_KEY);if(Array.isArray(entries))for(const row of entries.slice(-MAX_ENTRIES))if(Array.isArray(row)&&typeof row[0]==='string'&&row[0].length<=180&&row[1]?.expires>this.now())this.cache.set(row[0],{name:clean(row[1].name),profileName:clean(row[1].profileName),source:clean(row[1].source),expires:Number(row[1].expires)});}catch{/* Names must not prevent reading a message. */}})();
    await this.loading;
  }
  remember(kind,id,name,source,profileName=''){
    if(!id)return;const key=this.key(kind,String(id));
    this.cache.delete(key);this.cache.set(key,{name:clean(name),profileName:clean(profileName),source,expires:this.now()+(clean(name)?POSITIVE_TTL:NEGATIVE_TTL)});
    while(this.cache.size>MAX_ENTRIES)this.cache.delete(this.cache.keys().next().value);this.dirty=true;
  }
  async rememberContacts(contacts){
    await this.load();for(const [mid,entry] of Object.entries(contacts ?? {})){const c=entry.contact ?? entry;this.remember('talk',c.mid ?? mid,contactName(c),clean(c.displayNameOverridden)?'contact_alias':'contact_profile',c.displayName);}
    await this.save();
  }
  async save(){
    if(!this.dirty||!this.storage?.set)return;this.dirty=false;
    try{await this.storage.set(STORAGE_KEY,[...this.cache].filter(([,v])=>v.expires>this.now()));}catch{this.dirty=true;}
  }
  async bounded(job){
    let timer;try{return await Promise.race([Promise.resolve().then(job),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('alias_timeout')),this.timeout);})]);}finally{clearTimeout(timer);}
  }
  async lookup(kind,ids){
    if(kind==='openchat'){
      if(typeof this.client.square?.getSquareMembers==='function'){
        try{
          const response=await this.bounded(()=>this.client.square.getSquareMembers({request:{mids:ids}}));
          for(const [mid,member] of Object.entries(response.members ?? {}))if(ids.includes(mid)||ids.includes(member.squareMemberMid))this.remember(kind,member.squareMemberMid || mid,member.displayName,'openchat_profile');
          return;
        }catch(error){if(!['NOT_IMPLEMENTED',501].includes(error?.data?.errorCode ?? error?.data?.code ?? error?.code))throw error;}
      }
      if(typeof this.client.square?.getSquareMember==='function'){
        // Compatibility with clients that expose only the single-member wrapper.
        let next=0,accepting=true;
        try{await this.bounded(()=>Promise.allSettled(Array.from({length:Math.min(4,ids.length)},async()=>{
          while(accepting&&next<ids.length){const mid=ids[next++];try{const response=await this.client.square.getSquareMember({squareMemberMid:mid});const member=response.squareMember;if(accepting&&member?.squareMemberMid===mid)this.remember(kind,mid,member.displayName,'openchat_profile');}catch{/* An individual inaccessible member must not stop the batch. */}}
        })));}finally{accepting=false;}
      }
    }else if(typeof this.client.talk?.getContactsV2==='function'){
      const response=await this.bounded(()=>this.client.talk.getContactsV2({mids:ids}));
      for(const [mid,entry] of Object.entries(response.contacts ?? {})){const contact=entry.contact ?? entry,id=contact.mid ?? mid;if(ids.includes(id))this.remember(kind,id,contactName(contact),clean(contact.displayNameOverridden)?'contact_alias':'contact_profile',contact.displayName);}
    }
  }
  async resolveMessages(chat,messages){
    await this.load();const kind=chat.kind==='openchat'?'openchat':'talk',ids=[];
    for(const m of messages){
      if(!m.senderId)continue;
      // An event's name is scoped to Square. It is not a personal contact alias.
      if(kind==='openchat'&&clean(m.senderName))this.remember(kind,m.senderId,m.senderName,m.senderNameSource || 'openchat_event');
      if(kind==='talk'&&m.senderId===this.client.profile?.mid){this.remember(kind,m.senderId,this.client.profile.displayName,'account_profile');continue;}
      const entry=this.cache.get(this.key(kind,m.senderId));if(!entry||entry.expires<=this.now())ids.push(m.senderId);
    }
    const unique=[...new Set(ids)];
    for(let start=0;start<unique.length;start+=BATCH_SIZE){
      const batch=unique.slice(start,start+BATCH_SIZE),fresh=batch.filter(id=>!this.pending.has(this.key(kind,id)));
      if(fresh.length){
        const task=(async()=>{try{await this.lookup(kind,fresh);}catch{/* Missing/deleted members and RPC failure are nonfatal. */}finally{for(const id of fresh){const entry=this.cache.get(this.key(kind,id));if(!entry||entry.expires<=this.now())this.remember(kind,id,'','unavailable');this.pending.delete(this.key(kind,id));}}})();
        for(const id of fresh)this.pending.set(this.key(kind,id),task);
      }
      await Promise.all([...new Set(batch.map(id=>this.pending.get(this.key(kind,id))).filter(Boolean))]);
    }
    await this.save();
    return messages.map(m=>{const resolved=m.senderId?this.cache.get(this.key(kind,m.senderId)):null,name=resolved?.name || clean(m.senderName) || null;return {...m,senderName:name,senderNameSource:name?(resolved?.name?resolved.source:m.senderNameSource || 'event'):null,senderNameStatus:name?'resolved':m.senderId?'unavailable':'system',...(resolved?.profileName?{senderProfileName:resolved.profileName}:{})};});
  }
}
