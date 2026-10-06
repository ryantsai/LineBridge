import {createHash} from 'node:crypto';
import {z} from 'zod';
import {fail} from './errors.mjs';

const input=z.object({enabled:z.boolean(),confirmed:z.literal(true),snapshot:z.string().length(64)}).strict();
const equal=(a,b)=>JSON.stringify([...a].sort())===JSON.stringify([...b].sort());
const active=token=>token&&!token.revoked&&Date.parse(token.expires_at)>Date.now();

// Toggle an existing managed profile, never enroll or repair a credential here.
export class ChatAccess {
  constructor(setup,{authentication=()=> 'token',ownershipTimeoutMs=5000}={}){this.setup=setup;this.hub=setup.hub;this.store=this.hub.store;this.authentication=authentication;this.ownershipTimeoutMs=ownershipTimeoutMs;}
  state(id,chatId){
    this.hub.record(id);const chat=this.store.chat(id,chatId);if(!chat)fail(404,'chat_not_found','Refresh the chat list and try again.');
    const record=this.setup.record(id),token=record&&this.store.token(record.tokenId);
    const ownedShape=record?.phase==='enabled'&&record.url===this.setup.url&&Array.isArray(record.chatIds)&&token?.grants.length===1&&token.grants[0].accountId===id&&token.grants[0].localOnly===true&&token.grants[0].read===true&&token.grants[0].send===true&&Array.isArray(token.grants[0].chatIds)&&equal(record.chatIds,token.grants[0].chatIds);
    const grants=this.store.tokens().map(t=>({id:t.id,grants:t.grants,revoked:t.revoked,expires_at:t.expires_at,revision:this.store.setting(`tokenGrantRevision:${t.id}`,0),revocation:this.store.setting(`tokenRevocation:${t.id}`,0)}));
    const snapshot=createHash('sha256').update(JSON.stringify({chat,record,token:token&&{id:token.id,hash:token.hash,grants:token.grants,revoked:token.revoked,expires_at:token.expires_at},grants,
      revision:this.store.setting(`chatScopeRevision:${id}`,0),setupRevision:this.store.setting(`localSetupRevision:${id}`,0),grantRevision:token&&this.store.setting(`tokenGrantRevision:${token.id}`,0),revocation:token&&this.store.setting(`tokenRevocation:${token.id}`,0),generation:this.setup.generations.get(id)??0,
      authentication:this.authentication(),localAccess:this.hub.localAccess(id),aiEnabled:this.store.setting('aiEnabled',true)})).digest('hex');
    return {chat,record,token,ownedShape,snapshot};
  }
  preview(id,chatId){
    const s=this.state(id,chatId),managed=!!(s.ownedShape&&active(s.token));
    const gatewayEnabled=this.store.setting('aiEnabled',true),selectedChatIds=this.store.chats(id).filter(c=>c.enabled).map(c=>c.id);
    const effectiveChatIds=managed&&gatewayEnabled?s.record.chatIds.filter(value=>selectedChatIds.includes(value)):[];
    return {snapshot:s.snapshot,chat:{id:chatId,name:s.chat.name,kind:s.chat.kind,enabled:!!s.chat.enabled},profile:s.record?.profile??null,managed,
      permissions:{read:effectiveChatIds.includes(chatId),send:effectiveChatIds.includes(chatId)},chatIds:s.record?.chatIds??[],selectedChatIds,effectiveChatIds,gatewayEnabled,
      setupRequired:!managed,authorization:'saved',reception:'check_monitor_health_separately'};
  }
  check(id,chatId,data,signal){
    if(signal?.aborted)fail(409,'toggle_cancelled','The request was cancelled. Refresh the saved state.');
    if(this.hub.stopping)fail(503,'service_stopping','The service is stopping.');
    if(this.setup.busy.has(id))fail(409,'setup_busy','Local AI setup is changing. Wait, then review the chat again.');
    const s=this.state(id,chatId);
    if(s.snapshot!==data.snapshot)fail(409,'chat_access_changed','Permissions changed. Refresh and confirm the current scope again.');
    if(data.enabled){
      this.setup.usable();
      if(!s.ownedShape||!active(s.token))fail(409,'managed_setup_required','Open Connections and explicitly enable or repair Local AI setup before adding a chat. This toggle creates no credential.');
      if(!s.chat.enabled){
        if(this.authentication()==='local'&&(this.hub.localAccess(id).read||this.hub.localAccess(id).send))fail(409,'local_access_conflict','Token-free local access would also gain this chat. Use token authentication before adding it to the managed profile.');
        if(this.store.tokens().some(t=>t.id!==s.token.id&&active(t)&&t.grants.some(g=>g.accountId===id&&(g.read||g.send)&&(!g.chatIds||g.chatIds.includes(chatId)))))fail(409,'manual_grant_conflict','Another client would also gain access to this chat. Review its scope in Connections before trying again. No grants were changed.');
      }
    }
    return s;
  }
  async apply(id,chatId,value,{signal}={}){
    const data=input.parse(value),before=this.check(id,chatId,data,signal);
    // Reducing access must remain possible when the OS store is locked or the
    // existing profile expired. Increasing access requires bounded ownership proof.
    if(data.enabled){
      let timer;
      try{
        const owned=await Promise.race([this.setup.owns(before.record).catch(()=>false),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),this.ownershipTimeoutMs);})]);
        if(!owned)fail(503,'managed_profile_unavailable','Unlock or repair the existing Local AI profile in Connections, then review the chat again. No permissions were changed.');
      }finally{clearTimeout(timer);}
    }
    const result=this.store.transaction(()=>{
      const s=this.check(id,chatId,data,signal);
      this.store.designate(id,chatId,data.enabled);
      if(s.ownedShape){
        const chatIds=s.record.chatIds.filter(value=>value!==chatId);if(data.enabled)chatIds.push(chatId);
        // An empty list means no chats; omitting chatIds would grant all chats.
        this.store.setTokenGrants(s.token.id,[{...s.token.grants[0],chatIds}]);
        this.setup.save(id,{...s.record,chatIds});
      }
      this.store.audit('local-admin','chat.access',id,chatId,data.enabled?'monitor+local-read+send':'disabled');
      return this.preview(id,chatId);
    });
    // Persisted selection is enforced by authorization immediately and survives
    // restart. Upstream receiver updates cannot delay or undo a saved revocation.
    void Promise.resolve().then(()=>this.hub.updateMonitor(id)).catch(()=>{const runtime=this.hub.runtime.get(id);if(runtime)runtime.monitorStreams={worker:{status:'retrying'}};});
    return result;
  }
}
