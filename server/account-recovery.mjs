const DELAYS=[5000,30000,120000],HOUR=3600000;
const faultCodes=new Set(['protocol_error','session_expired','auth_invalid','login_required','vault_write_failed','storage_failed']);
export const safeFaultCode=code=>faultCodes.has(code)?code:'unknown';
export const terminalRecoveryCode=code=>code!=='protocol_error'&&code!=='line_login_failed';

// Only a lost private worker is recoverable here. Auth/session invalidation and
// receiver health have their own policies; neither can start a recovery episode.
// Episodes are process-local, but the rolling attempt budget survives restarts.
export class AccountRecovery {
  constructor(hub){this.hub=hub;this.entries=new Map();}
  view(id){const e=this.entries.get(id);return e?{status:e.status,attempts:e.attempts,nextRetryAt:e.nextRetryAt,code:e.code}:null;}
  owns(id,e){return this.entries.get(id)===e&&!this.hub.stopping;}
  cancel(id){const e=this.entries.get(id);if(e)clearTimeout(e.timer);this.entries.delete(id);}
  close(){for(const id of this.entries.keys())this.cancel(id);}
  audit(id,outcome,e){this.hub.store.audit('system','account.recovery',id,null,outcome,{code:e.code,attempt:e.attempts});}
  stop(id,e,status,code=e.code){
    clearTimeout(e.timer);e.timer=null;e.status=status;e.code=code;e.nextRetryAt=null;
    // Storage failure must stop automatic work, not escape a worker event callback.
    try{
      if(status==='exhausted')this.hub.store.transaction(()=>{
        // A service restart must not bypass an exhausted episode via initialize().
        this.hub.store.connect(id,false);this.audit(id,status,e);
      });else this.audit(id,status,e);
    }catch{e.status='stopped';e.code='recovery_storage_failed';}
  }
  budget(id){
    const saved=this.hub.store.setting(`accountRecoveryAttempts:${id}`,[]);
    if(!Array.isArray(saved)||saved.some(at=>!Number.isSafeInteger(at)||at<0))throw new Error('Invalid recovery budget');
    return saved.filter(at=>at>Date.now()-HOUR);
  }
  eligible(id,e){
    const {hub}=this,a=hub.store.account(id);
    return this.owns(id,e)&&hub.runtime.get(id)===e.runtime&&a?.kind==='line'&&!!a.connected&&!!hub.store.secret(id,'bridge.authToken');
  }
  fault(id,r,code,wasConnected){
    let e=this.entries.get(id);
    try{this.hub.store.audit('system','account.fault',id,null,'failed',{code});}
    catch{if(e)this.stop(id,e,'stopped','recovery_storage_failed');return;}
    if(code!=='protocol_error'){if(e)this.stop(id,e,'stopped',code);return;}
    if(e)return; // A running attempt will observe its faulted runtime on settlement.
    if(!wasConnected||this.hub.stopping)return;
    e={runtime:r,status:'waiting',code,attempts:0,nextRetryAt:null,timer:null};
    this.entries.set(id,e);
    if(!this.eligible(id,e)){this.cancel(id);return;}
    this.schedule(id,e);
  }
  schedule(id,e){
    if(!this.eligible(id,e)){this.cancel(id);return;}
    try{if(e.attempts>=DELAYS.length||this.budget(id).length>=3){this.stop(id,e,'exhausted');return;}}
    catch{this.stop(id,e,'stopped','recovery_storage_failed');return;}
    e.status='waiting';e.nextRetryAt=new Date(Date.now()+DELAYS[e.attempts]).toISOString();
    e.timer=setTimeout(()=>{e.timer=null;void this.attempt(id,e);},DELAYS[e.attempts]);e.timer.unref();
  }
  async attempt(id,e){
    if(!this.eligible(id,e)){this.cancel(id);return;}
    try{
      // Charge before dispatch, atomically with the audit. Success/manual login
      // never erases the budget, so repeated crash/login cycles remain bounded.
      const charged=this.hub.store.transaction(()=>{
        const recent=this.budget(id);if(recent.length>=3)return false;
        this.hub.store.setSetting(`accountRecoveryAttempts:${id}`,[...recent,Date.now()]);
        this.audit(id,'attempt',{...e,attempts:e.attempts+1});return true;
      });
      if(!charged){this.stop(id,e,'exhausted');return;}
      e.attempts++;e.status='connecting';e.nextRetryAt=null;
      await this.hub.connect(id,false,e);
      if(!this.owns(id,e)||this.hub.runtime.get(id)!==e.runtime||e.status==='stopped')return;
      if(e.runtime.status==='connected'&&e.runtime.driver?.ready){this.audit(id,'connected',e);this.cancel(id);return;}
      e.code=e.runtime.error??'line_login_failed';
      if(terminalRecoveryCode(e.code)){this.stop(id,e,'stopped');return;}
      this.audit(id,'failed',e);this.schedule(id,e);
    }catch{if(this.owns(id,e))this.stop(id,e,'stopped','recovery_storage_failed');}
  }
}
