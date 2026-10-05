import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {CredentialStore} from '../client/credentials.mjs';
import {digest} from './hub.mjs';
import {fail} from './errors.mjs';

const input=z.object({chatIds:z.array(z.string().min(1).max(150)).min(1).max(1000),read:z.literal(true),send:z.literal(true),confirmed:z.literal(true),autoMonitorNewChats:z.boolean().default(false)}).strict();
const key=id=>`localSetup:${id}`;
const selection=chats=>JSON.stringify(chats.map(c=>[c.id,c.kind,!!c.enabled]).sort((a,b)=>a[0].localeCompare(b[0])));
const same=(a,b)=>JSON.stringify([...a].sort())===JSON.stringify([...b].sort());
const credentialFailure=()=>fail(503,'credential_store_unavailable','Protected credential storage is unavailable or locked. Unlock your OS credential store and retry. No plaintext fallback was used.');

// Only public ownership/scope metadata is persisted here. The bearer credential
// exists in private memory and the OS store; SQLite contains only its hash.
export class LocalSetup {
  constructor(hub,{credentials=new CredentialStore(),gatewayPort=3211}={}){
    Object.assign(this,{hub,credentials,gatewayPort});this.busy=new Map();this.generations=new Map();
    // A crash before final activation must never turn an enrollment into a grant.
    for(const a of hub.store.accounts()){
      const record=this.record(a.id);
      if(record&&['enrolling','starting'].includes(record.phase)){
        hub.store.transaction(()=>{hub.store.revoke(record.tokenId);this.restore(a.id,record);this.save(a.id,{...record,phase:'cleanup_required'});});
      }
    }
  }
  get url(){return `http://127.0.0.1:${this.gatewayPort}`;}
  record(id){return this.hub.store.setting(key(id),null);}
  save(id,record){this.hub.store.setSetting(key(id),record);}
  discover(){
    // Public setup metadata only: never enumerate or unlock credential stores.
    return this.hub.store.accounts().flatMap(account=>{
      const record=this.record(account.id);
      if(record?.phase!=='enabled'||record.url!==this.url)return [];
      const token=this.hub.store.token(record.tokenId);
      if(!token||token.revoked||!(Date.parse(token.expires_at)>Date.now())||!token.grants.some(g=>g.accountId===account.id&&g.localOnly&&g.read))return [];
      return [{profile:record.profile,url:record.url,accountId:account.id,accountLabel:account.label,expiresAt:token.expires_at}];
    });
  }
  usable(){if(this.hub.stopping)fail(503,'service_stopping','The service is stopping.');if(!this.hub.store.setting('aiEnabled',true))fail(409,'gateway_paused','Resume AI access before enabling setup.');}
  validate(id,data){
    this.hub.record(id);this.hub.driver(id);this.usable();
    if(new Set(data.chatIds).size!==data.chatIds.length)fail(400,'duplicate_chat','Choose each chat once.');
    for(const chatId of data.chatIds)if(!this.hub.store.chat(id,chatId))fail(409,'selection_changed','The chat selection changed. Review it again.');
  }
  async owns(record){
    const value=await this.credentials.get(record.profile),token=this.hub.store.token(record.tokenId);
    return value.url===record.url&&!!token&&digest(value.token)===token.hash&&!value.cfAccessClientId;
  }
  async status(id){
    let record=this.record(id);
    if(!record)return {phase:'not_enabled',ready:false,autoMonitorNewChats:false,permissions:{read:true,send:true},protection:this.credentials.protection};
    let token=this.hub.store.token(record.tokenId);const account=this.hub.store.account(id);
    let credentialStatus='unchecked';
    if(record.phase==='enabled'&&token&&!token.revoked){
      try{credentialStatus=await this.owns(record)?'protected':'profile_conflict';}catch{credentialStatus='unavailable';}
    }
    const current=this.record(id);if(current?.tokenId===record.tokenId)record=current;
    token=this.hub.store.token(record.tokenId);
    const monitor=account?this.hub.view(account,record.chatIds).monitor:null;
    const allSelected=same(this.hub.store.chats(id).filter(c=>c.enabled).map(c=>c.id),record.chatIds);
    const grantActive=record.phase==='enabled'&&current?.phase==='enabled'&&current.tokenId===record.tokenId&&!!token&&!token.revoked&&Date.parse(token.expires_at)>Date.now();
    const endpointMatches=record.url===this.url;
    const ready=grantActive&&credentialStatus==='protected'&&endpointMatches&&this.hub.store.setting('aiEnabled',true)&&allSelected&&monitor?.health==='healthy';
    return {phase:record.phase,ready,grantActive,profile:record.profile,url:record.url,permissions:{read:true,send:true},chatIds:record.chatIds,autoMonitorNewChats:record.autoMonitorNewChats===true,
      expiresAt:token?.expires_at??null,protection:this.credentials.protection,credentialStatus,monitor,selectionChanged:!allSelected,
      health:ready?'ready':!grantActive?'disabled':credentialStatus!=='protected'?credentialStatus:!endpointMatches?'endpoint_changed':!allSelected?'selection_changed':!this.hub.store.setting('aiEnabled',true)?'paused':account?.kind==='demo'?'sandbox':monitor?.health??'disconnected'};
  }
  enable(id,value){
    const data=input.parse(value),pending=this.busy.get(id);
    if(pending){if(pending.chatIds&&same(pending.chatIds,data.chatIds)&&pending.autoMonitorNewChats===data.autoMonitorNewChats)return pending.promise;fail(409,'setup_busy','Setup is in progress. Wait before changing the selection.');}
    const promise=this.enroll(id,data,this.generations.get(id)??0).finally(()=>{if(this.busy.get(id)?.promise===promise)this.busy.delete(id);});
    this.busy.set(id,{chatIds:data.chatIds,autoMonitorNewChats:data.autoMonitorNewChats,promise});return promise;
  }
  checkAttempt(id,generation){if((this.generations.get(id)??0)!==generation)fail(409,'setup_cancelled','Setup was cancelled. Its grant is revoked.');}
  updateSettings(id,value){
    const data=z.object({autoMonitorNewChats:z.boolean()}).strict().parse(value);
    this.hub.record(id);
    if(this.hub.stopping)fail(503,'service_stopping','The service is stopping.');
    if(this.busy.has(id))fail(409,'setup_busy','Setup is in progress. Wait before changing automatic monitoring.');
    const record=this.record(id),token=record&&this.hub.store.token(record.tokenId);
    if(record?.phase!=='enabled'||!token||token.revoked||Date.parse(token.expires_at)<=Date.now())fail(409,'setup_needs_reset','Enable local AI setup before changing automatic monitoring.');
    // A policy change affects future discoveries only. Keep the credential,
    // existing selections and other clients' grants intact.
    this.hub.store.transaction(()=>{
      this.save(id,{...record,...data});
      this.hub.store.audit('local-admin','local-setup.update',id,null,data.autoMonitorNewChats?'enabled':'disabled');
    });
    this.hub.scheduleDiscovery(id,true);
    return this.status(id);
  }
  async enroll(id,data,generation){
    this.validate(id,data);
    let existing=this.record(id);
    if(existing?.phase==='enabled'){
      if(!same(existing.chatIds,data.chatIds)||(existing.autoMonitorNewChats===true)!==data.autoMonitorNewChats)fail(409,'setup_scope_conflict','Disable the current setup before confirming a different chat scope or automatic monitoring policy.');
      const state=await this.status(id);
      this.checkAttempt(id,generation);
      if(!state.grantActive||state.credentialStatus!=='protected'||existing.url!==this.url)fail(409,'setup_needs_reset','Disable this setup, then explicitly enable it again. Existing profiles will not be overwritten.');
      return state;
    }
    if(existing&&existing.phase!=='revoked'){
      await this.cleanup(id,existing);existing=this.record(id);
      this.checkAttempt(id,generation);
      if(existing.phase!=='revoked')credentialFailure();
    }
    this.validate(id,data);
    const before=this.hub.store.chats(id),snapshot=selection(before),profile=`linebridge-${randomUUID()}`;
    let minted,record;
    this.hub.store.transaction(()=>{
      minted=this.hub.createToken({name:`Local AI · ${this.hub.record(id).label}`.slice(0,80),days:90,grants:[{accountId:id,read:true,send:true,chatIds:data.chatIds,localOnly:true}]});
      this.hub.store.revoke(minted.id);
      record={phase:'enrolling',profile,url:this.url,tokenId:minted.id,revocationRevision:this.hub.store.setting(`tokenRevocation:${minted.id}`,0),chatIds:data.chatIds,autoMonitorNewChats:data.autoMonitorNewChats,previousChats:before.filter(c=>c.enabled).map(c=>c.id),previousMonitor:this.hub.store.setting(`monitor:${id}`,false),previousMonitorRevision:this.hub.store.setting(`monitorRevision:${id}`,0)};
      this.save(id,record);
    });
    let storageAttempted=false;
    try{
      storageAttempted=true;await this.credentials.create(profile,this.url,{token:minted.token});
      if(!await this.owns(record))fail(409,'profile_conflict','Protected credential verification failed. Existing profiles were not replaced.');
      this.checkAttempt(id,generation);this.checkPending(id,record);this.validate(id,data);
      if(selection(this.hub.store.chats(id))!==snapshot)fail(409,'selection_changed','The chat selection changed during setup. Review it again.');
      if(this.hub.store.setting(`monitorRevision:${id}`,0)!==record.previousMonitorRevision)fail(409,'setup_cancelled','The monitoring choice changed during setup. Review it again.');
      this.hub.store.transaction(()=>{
        for(const chat of before)this.hub.store.designate(id,chat.id,data.chatIds.includes(chat.id));
        record={...record,phase:'starting',selectionApplied:true,monitorRevision:record.previousMonitorRevision+1};this.save(id,record);
      });
      await this.hub.monitor(id,true);
      this.checkAttempt(id,generation);this.checkPending(id,record);this.validate(id,data);
      if(this.hub.store.setting(`monitorRevision:${id}`,0)!==record.monitorRevision)fail(409,'setup_cancelled','The monitoring choice changed during setup. Review it again.');
      if(!same(this.hub.store.chats(id).filter(c=>c.enabled).map(c=>c.id),data.chatIds))fail(409,'selection_changed','The chat selection changed during setup. Review it again.');
      this.hub.store.transaction(()=>{
        this.hub.store.db.prepare('UPDATE tokens SET revoked=0 WHERE id=?').run(record.tokenId);
        record={...record,phase:'enabled'};delete record.previousChats;delete record.previousMonitor;this.save(id,record);
        this.hub.store.audit('local-admin','local-setup.enable',id,null,'ok');
      });
      this.hub.scheduleDiscovery(id,true);
    }catch(error){
      const monitorOwned=this.hub.store.transaction(()=>{this.hub.store.revoke(record.tokenId);const owned=this.restore(id,record);this.save(id,{...record,phase:'cleanup_required'});return owned;});
      // Stop/reconfigure a partially started receiver before reporting rollback.
      if(monitorOwned)try{await this.hub.monitor(id,record.previousMonitor===true,{expectedRevision:record.monitorRevision});}catch{}
      if(storageAttempted)await this.cleanup(id,record);else this.save(id,{...record,phase:'revoked'});
      this.hub.store.audit('local-admin','local-setup.enable',id,null,'failed');
      if(['selection_changed','profile_conflict','setup_cancelled','account_disconnected','gateway_paused','service_stopping'].includes(error.code))throw error;
      if(error.code==='credential_store_unavailable'||error.code==='credentials_required')credentialFailure();
      fail(503,'setup_failed','Setup did not complete; its grant was revoked. Check receiver and protected storage status before retrying.');
    }
    return this.status(id);
  }
  checkPending(id,record){if(this.record(id)?.tokenId!==record.tokenId||!['enrolling','starting'].includes(this.record(id)?.phase)||this.hub.store.setting(`tokenRevocation:${record.tokenId}`,0)!==record.revocationRevision)fail(409,'setup_cancelled','Setup was cancelled. Its grant is revoked.');}
  restore(id,record){
    if(record.selectionApplied&&record.previousChats&&same(this.hub.store.chats(id).filter(c=>c.enabled).map(c=>c.id),record.chatIds)){
      for(const chat of this.hub.store.chats(id))this.hub.store.designate(id,chat.id,record.previousChats.includes(chat.id));
    }
    const monitorOwned=record.selectionApplied&&record.previousMonitor!==undefined&&record.monitorRevision!==undefined&&this.hub.store.setting(`monitorRevision:${id}`,0)===record.monitorRevision;
    if(monitorOwned)this.hub.store.setSetting(`monitor:${id}`,record.previousMonitor);
    return monitorOwned;
  }
  async cleanup(id,record){
    // An unavailable read is not evidence of ownership: never delete an item
    // that may belong to another enrollment. Keep a retryable cleanup tombstone.
    try{
      if(await this.owns(record))await this.credentials.forget(record.profile);
      else {this.save(id,{...record,phase:'revoked',cleanup:'profile_conflict'});return;}
      this.save(id,{...record,phase:'revoked'});
    }catch(error){
      if(error.code==='credentials_required')this.save(id,{...record,phase:'revoked'});
      else this.save(id,{...record,phase:'cleanup_required'});
    }
  }
  revoke(id){
    const pending=this.busy.get(id);if(pending?.operation==='revoke')return pending.promise;
    // Cover the whole enable attempt, including cleanup before its new token
    // exists. A late cleanup response cannot start a cancelled enrollment.
    this.generations.set(id,(this.generations.get(id)??0)+1);
    const record=this.record(id);if(!record)return this.status(id);
    // Revoke synchronously, including during an in-flight keystore/worker call.
    this.hub.store.transaction(()=>{this.hub.store.revoke(record.tokenId);this.save(id,{...record,phase:'cleanup_required'});this.hub.store.audit('local-admin','local-setup.revoke',id,null,'ok');});
    this.hub.cancelDiscovery(this.hub.runtime.get(id));
    const promise=(async()=>{
      await pending?.promise.catch(()=>{});
      const current=this.record(id);
      this.hub.store.transaction(()=>{this.hub.store.revoke(current.tokenId);this.save(id,{...current,phase:'cleanup_required'});});
      await this.cleanup(id,this.record(id));return this.status(id);
    })().finally(()=>{if(this.busy.get(id)?.promise===promise)this.busy.delete(id);});
    this.busy.set(id,{operation:'revoke',promise});return promise;
  }
}
