import { BaseClient } from 'lineclientbot';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fail, SendRejectedError } from './errors.mjs';
import {AliasResolver,contactName} from './aliases.mjs';

export function discoveryErrorCode(error) {
  const code=error?.data?.errorCode ?? error?.data?.code ?? error?.code;
  return typeof code==='number' ? String(code) : typeof code==='string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'protocol_error';
}

export function joinedSquareRooms(response) {
  const rooms=new Map();
  for(const event of response.events ?? []) {
    const membership=event.payload?.notifiedCreateSquareChatMember;
    const chat=membership?.chat,state=membership?.chatMember?.membershipState;
    if(chat?.squareChatMid && (state==='JOINED' || state===1)) rooms.set(chat.squareChatMid,{id:chat.squareChatMid,name:chat.name || chat.squareChatMid,kind:'openchat'});
  }
  return [...rooms.values()];
}

export function normalizeMessage(raw, extra={}) {
  let timestamp = null;
  const numeric = Number(raw.createdTime ?? raw.timestamp);
  if (Number.isFinite(numeric) && numeric > 0 && numeric < 8640000000000000) timestamp = new Date(numeric).toISOString();
  return { id: String(raw.id ?? ''), senderId: String(raw.from ?? ''), text: String(raw.text ?? ''), timestamp,
    contentType: String(raw.contentType ?? 'NONE'), ...extra };
}

export function squareMessages(response) {
  const unique = new Map();
  for (const event of response.events ?? []) {
    const payload = event.payload?.receiveMessage ?? event.payload?.sendMessage ?? event.payload?.notificationMessage;
    const raw = payload?.squareMessage?.message;
    if (raw?.id && !unique.has(String(raw.id))) unique.set(String(raw.id), normalizeMessage(raw, { senderName: payload.senderDisplayName ?? null }));
  }
  return [...unique.values()].sort((a,b) => String(a.timestamp).localeCompare(String(b.timestamp)));
}

export class LineDriver {
  constructor(account, storage, events) {
    this.account = account;
    this.storage = storage;
    this.events = events;
    this.abort = new AbortController();
    this.requestSignal = new AsyncLocalStorage();
    this.client = new BaseClient({ device: account.device, storage, legy: { encrypted: 'auto' },
      fetch: request => fetch(new Request(request, { signal: AbortSignal.any([this.abort.signal, request.signal, this.requestSignal.getStore()].filter(Boolean)) })) });
    this.client.on('qrcall', url => events.qr(url));
    this.client.on('pincall', pin => events.pin(String(pin)));
    this.client.on('update:authtoken', token => {
      this.client.authToken = token;
      void storage.set('bridge.authToken', token).catch(() => events.fault('vault_write_failed'));
    });
    this.client.on('end', () => events.fault('session_expired'));
    // Do not attach the library's log event: it includes raw credentials and message bodies.
  }
  async login(qr=false) {
    const token = qr ? undefined : await this.storage.get('bridge.authToken');
    if (!qr && !token) fail(409,'login_required','Connect this account with QR login first.');
    // BaseClient avoids high-level login's catch-all E2EE key re-registration on token resume.
    try{await this.client.loginProcess.login(qr ? { qr: true } : { authToken: token });}
    catch(error){
      if(!qr&&error?.name==='RequestError'&&discoveryErrorCode(error)==='NOT_AUTHORIZED_DEVICE')fail(409,'login_required','LINE requires a new QR login to authorize this device.');
      throw error;
    }
    this.ready = true;
    return { displayName: this.client.profile.displayName, mid: this.client.profile.mid };
  }
  stop() { this.ready=false; this.client.disabled=true; this.abort.abort(); }
  // The SDK accepts a deadline, but no per-call signal. Scope cancellation to
  // this async request so stopping a receiver leaves concurrent account RPCs alone.
  monitorRequest(signal,operation) { signal.throwIfAborted();return this.requestSignal.run(signal,operation); }
  async check() { const p=await this.client.talk.getProfile(); this.client.profile=p;return { displayName:p.displayName,mid:p.mid }; }
  get aliases(){return this.aliasResolver ??= new AliasResolver(this.client,this.storage);}
  async resolveMessageNames(chat,messages){return this.aliases.resolveMessages(chat,messages);}
  async discover() {
    const result=[], warnings=[], stages={};
    try {
      const joined = await this.client.talk.getAllChatMids({ request:{withMemberChats:true} });
      const ids = joined.memberChatMids ?? [];
      for(let offset=0;offset<ids.length;offset+=100) {
        const response=await this.client.talk.getChats({ chatMids:ids.slice(offset,offset+100) });
        for(const chat of response.chats ?? []) result.push({ id:chat.chatMid,name:chat.chatName || chat.chatMid,kind:'group' });
      }
      stages.groups={status:'ok',count:result.filter(c=>c.kind==='group').length};
    } catch(error) {stages.groups={status:'failed',errorCode:discoveryErrorCode(error)};warnings.push(`Group discovery failed (${stages.groups.errorCode}).`);}
    try {
      const mids=await this.client.talk.getAllContactIds();
      const names={aliases:0,profiles:0,unavailable:0};
      for(let offset=0;offset<(mids?.length ?? 0);offset+=100) {
        const response=await this.client.talk.getContactsV2({ mids:mids.slice(offset,offset+100) });
        await this.aliases.rememberContacts(response.contacts);
        for(const [mid,entry] of Object.entries(response.contacts ?? {})) {
          const contact=entry.contact ?? entry;
          const id=contact.mid ?? mid;
          if(id){result.push({id,name:contactName(contact) || '名稱暫時無法取得',kind:'direct'});names[contact.displayNameOverridden?.trim()?'aliases':contact.displayName?.trim()?'profiles':'unavailable']++;}
        }
      }
      stages.direct={status:'ok',count:result.filter(c=>c.kind==='direct').length,names};
    } catch(error) {stages.direct={status:'failed',errorCode:discoveryErrorCode(error)};warnings.push(`Contact discovery failed (${stages.direct.errorCode}).`);}
    try {
      let continuationToken;
      const rooms=new Map();
      // Bounded pagination: avoids unbounded enumeration of account data.
      for(let page=0;page<20;page++) {
        // getJoinedSquareChats returns NOT_IMPLEMENTED. The initial event snapshot
        // contains memberships for joined rooms, unlike getJoinableSquareChats.
        const response=await this.client.square.fetchMyEvents({limit:200,continuationToken});
        for(const chat of joinedSquareRooms(response)) rooms.set(chat.id,chat);
        continuationToken=response.continuationToken;
        if(!continuationToken) break;
      }
      result.push(...rooms.values());
      stages.openchat={status:continuationToken?'partial':'ok',count:rooms.size,source:'membership_events'};
      if(continuationToken) warnings.push('OpenChat discovery reached its page limit; some rooms may be missing.');
    } catch(error) {stages.openchat={status:'failed',errorCode:discoveryErrorCode(error)};warnings.push(`OpenChat discovery failed (${stages.openchat.errorCode}).`);}
    return { chats:result.filter(c => c.id),warnings,stages };
  }
  async read(chat,limit,cursor) {
    if(chat.kind==='openchat') {
      const response=await this.client.square.fetchSquareChatEvents({squareChatMid:chat.id,limit,direction:'BACKWARD',...(cursor ? {syncToken:cursor} : {})});
      return {messages:await this.resolveMessageNames(chat,squareMessages(response).slice(-limit)),cursor:response.syncToken ?? null,coverage:'A bounded page of OpenChat events; media content is not downloaded.'};
    }
    if(cursor) fail(400,'cursor_unsupported','Personal chats support recent messages only in this version.');
    // v0.1.3 lacks the convenience wrapper. These field IDs match the LINE Talk RPC.
    const response=await this.client.request.request([[11,2,chat.id],[8,3,limit]],'getRecentMessagesV2',4,false,'/S4');
    if(!Array.isArray(response)) fail(502,'protocol_mismatch','LINE returned an unexpected history response.');
    const messages=[];
    for(const item of response) {
      const raw=this.client.thrift.rename_thrift('Message',item);
      try { messages.push(normalizeMessage(await this.client.e2ee.decryptE2EEMessage(raw))); }
      catch { messages.push(normalizeMessage({...raw,text:''},{unavailableReason:'E2EE decryption failed; this message was not exposed.'})); }
    }
    return {messages:await this.resolveMessageNames(chat,messages.sort((a,b)=>String(a.timestamp).localeCompare(String(b.timestamp)))),cursor:null,coverage:'Recent messages returned by LINE; full historical sync is not supported.'};
  }
  async send(chat,text) {
    let options,protection=chat.kind==='openchat'?'line_transport':'letter_sealing';
    if(chat.kind!=='openchat') {
      try {
        const chunks=await this.client.e2ee.encryptE2EEMessage(chat.id,text,'NONE');
        options={to:chat.id,chunks,e2ee:true,contentType:'NONE',contentMetadata:{e2eeVersion:'2',contentType:'0',e2eeMark:'2'}};
      } catch(error) {
        // This explicit LINE response means the chat expects standard messaging.
        // Missing keys, timeouts and other errors must not silently downgrade it.
        if(error?.name==='RequestError' && discoveryErrorCode(error)==='E2EE_RETRY_PLAIN') {
          options={to:chat.id,text,e2ee:false};protection='line_transport';
        } else {
          const code=discoveryErrorCode(error);
          throw new SendRejectedError(502,'send_preparation_failed',`Message preparation failed (${code}). No message was sent. Resume or reconnect the account if LINE requires identity verification.`);
        }
      }
    }
    let response;
    try {
      response=chat.kind==='openchat'
        ? await this.client.square.sendMessage({squareChatMid:chat.id,text})
        : await this.client.talk.sendMessage(options);
    } catch(error) {
      const code=discoveryErrorCode(error);
      if(error?.name==='RequestError' && code!=='protocol_error' && code!=='UNKNOWN') {
        throw new SendRejectedError(502,'line_send_rejected',`LINE rejected the message (${code}). Check the account and chat permissions before trying again.`);
      }
      throw error;
    }
    const message=response?.createdSquareMessage?.message ?? response?.squareMessage?.message ?? response;
    if(!message?.id) fail(502,'send_unconfirmed','LINE did not return a message ID. Delivery is unknown; inspect the chat before sending again.');
    return {messageId:String(message.id),timestamp:normalizeMessage(message).timestamp,delivery:'accepted_by_line',protection};
  }
}

export class DemoDriver {
  constructor() {
    this.ready=true;
    this.rooms=[{id:'demo-group',name:'Project room',kind:'group'},{id:'demo-openchat',name:'OpenChat sandbox',kind:'openchat'}];
    this.messages=new Map(this.rooms.map((room,i)=>[room.id,[
      {id:`sample-${i}-1`,senderId:'sample-person',senderName:'Sample member',text:i ? 'This is a synthetic OpenChat message for testing the gateway.' : 'The account bridge is ready for a scoped AI client.',timestamp:'2026-09-30T08:00:00.000Z',contentType:'NONE'},
      {id:`sample-${i}-2`,senderId:'sample-person-2',senderName:'Sample teammate',text:'Only designated chats can be read or sent to. No LINE account is connected in this sandbox.',timestamp:'2026-09-30T08:01:00.000Z',contentType:'NONE'}
    ]]));
  }
  async login() { this.ready=true; return this.check(); }
  async check() { return {displayName:'Sample account',mid:'synthetic'}; }
  async discover() { return {chats:this.rooms,warnings:[]}; }
  async read(chat,limit) { return {messages:(this.messages.get(chat.id) ?? []).slice(-limit),cursor:null,coverage:'Synthetic sandbox data. No LINE network calls.'}; }
  async send(chat,text) {
    const message={id:`demo-${randomUUID()}`,senderId:'synthetic',text,timestamp:new Date().toISOString(),contentType:'NONE'};
    const list=this.messages.get(chat.id) ?? []; list.push(message);this.messages.set(chat.id,list.slice(-100));
    return {messageId:message.id,timestamp:message.timestamp,delivery:'sandbox_only'};
  }
  stop() { this.ready=false; }
}
