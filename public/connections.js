import {label} from './locale.js';
export const providerName=value=>({local:'同一台主機 · 直接連線',cloudflare:'Cloudflare Tunnel + Access',cloudflare_quick:'Cloudflare Quick Tunnel',tailscale:'Tailscale · 私人 tailnet'}[value]||value);
export function createConnections({api,action,toast,refresh,escape,when,getState}) {
  const $=s=>document.querySelector(s), form=$('#tunnel-form');
  let signature,clientId,resourcesLoaded=false,resourcesAttempted=false,busy=false;
  const post=(path,body={})=>api(path,{method:'POST',body:JSON.stringify(body)});
  const run=job=>action(async()=>{if(busy)return;busy=true;$('#tunnel').classList.add('connection-busy');try{await job();}finally{busy=false;$('#tunnel').classList.remove('connection-busy');await refresh();}});
  async function openLogin(url,id){const link=$(id);link.href=url;link.hidden=false;window.open(url,'_blank','noopener,noreferrer');}
  function updateProvider(){const p=form.elements.provider.value;$('#local-connection-info').hidden=p!=='local';$('#cloudflare-fields').hidden=p!=='cloudflare';$('#cloudflare-oauth').hidden=p!=='cloudflare';$('#quick-tunnel-info').hidden=p!=='cloudflare_quick';$('#tailscale-connect').hidden=p!=='tailscale';$('#start-tunnel').hidden=p==='local';$('#stop-tunnel').hidden=p==='local';}
  async function save(){const cf=form.elements.provider.value==='cloudflare';return api('/tunnel',{method:'PUT',body:JSON.stringify({provider:form.elements.provider.value,hostname:cf?form.elements.hostname.value:'',teamDomain:cf?form.elements.teamDomain.value:'',audience:cf?form.elements.audience.value:''})});}
  form.elements.provider.addEventListener('change',()=>{if(form.elements.provider.value==='cloudflare'){const c=getState().tunnel.namedConfig||{};for(const key of ['hostname','teamDomain','audience'])form.elements[key].value=c[key]||'';}updateProvider();});
  form.addEventListener('submit',e=>{e.preventDefault();run(async()=>{await save();toast('已儲存連線設定');});});
  $('#start-tunnel').addEventListener('click',()=>run(async()=>{await save();const input=form.elements.connectorToken;try{const result=await post('/tunnel/start',{connectorToken:input.value||undefined});if(result.authUrl){await openLogin(result.authUrl,'#tailscale-login-link');toast('請在瀏覽器完成 Tailscale 登入，再啟動連線');}else if(result.state==='NeedsMachineAuth'){toast('請由 tailnet 管理者核准此裝置',true);}else toast('正在啟動連線');}finally{input.value='';}}));
  $('#stop-tunnel').addEventListener('click',()=>run(async()=>{await post('/tunnel/stop');toast('連線已停止');}));
  $('#connect-tailscale').addEventListener('click',()=>run(async()=>{const result=await post('/tunnel/tailscale/connect');if(result.authUrl)await openLogin(result.authUrl,'#tailscale-login-link');toast(result.connected?'已連接 Tailscale，可啟動私人連線':result.state==='NeedsMachineAuth'?'請由 tailnet 管理者核准此裝置':'請在瀏覽器完成登入');}));
  $('#cf-save-client').addEventListener('click',()=>run(async()=>{await api('/cloudflare/client',{method:'PUT',body:JSON.stringify({clientId:$('#cf-client-id').value.trim()})});toast('已儲存 OAuth 應用程式');}));
  $('#cf-login').addEventListener('click',()=>run(async()=>{const result=await post('/cloudflare/login');await openLogin(result.authUrl,'#cf-login-link');toast('請在瀏覽器完成 Cloudflare 授權');}));
  $('#cf-disconnect').addEventListener('click',()=>run(async()=>{await post('/cloudflare/disconnect');resourcesLoaded=false;resourcesAttempted=false;$('#cf-login-link').hidden=true;toast('已撤銷 Cloudflare OAuth 連線');}));
  async function loadResources(){const data=await api('/cloudflare/resources');$('#cf-account').innerHTML=data.accounts.map(a=>`<option value="${escape(a.id)}">${escape(a.name)}</option>`).join('');if(!data.accounts.length)throw new Error('Cloudflare 未提供可用帳戶。');await loadZones();resourcesLoaded=true;}
  async function loadZones(){const data=await api(`/cloudflare/resources?accountId=${encodeURIComponent($('#cf-account').value)}`);$('#cf-zone').innerHTML=data.zones.map(z=>`<option value="${escape(z.id)}">${escape(z.name)}</option>`).join('');$('#cf-provision').disabled=!data.zones.length;$('#cf-hostname').placeholder=data.zones.length?`line.${data.zones[0].name}`:'請先加入 Cloudflare 網域';}
  $('#cf-account').addEventListener('change',()=>run(loadZones));
  $('#cf-load-resources').addEventListener('click',()=>run(loadResources));
  $('#cf-provision').addEventListener('click',()=>run(async()=>{if(!$('#cf-hostname').value.trim()){$('#cf-hostname').focus();throw new Error('請先選擇新的完整主機名稱。');}await post('/cloudflare/setup',{accountId:$('#cf-account').value,zoneId:$('#cf-zone').value,hostname:$('#cf-hostname').value.trim()});toast('已建立 Tunnel、DNS 與 Access，可啟動連線');}));
  $('#cf-show-service').addEventListener('click',()=>run(async()=>{const data=await post('/cloudflare/service-token');$('#provider-secret').value=`CF-Access-Client-Id: ${data.clientId}\nCF-Access-Client-Secret: ${data.clientSecret}\n\n到期：${when(data.expiresAt)}\n另需 Authorization: Bearer <LineBridge AI 權杖>`;$('#provider-secret-dialog').showModal();}));
  $('#close-provider-secret').addEventListener('click',()=>{$('#provider-secret').value='';$('#provider-secret-dialog').close();});
  $('#provider-secret-dialog').addEventListener('close',()=>{$('#provider-secret').value='';});
  $('#copy-connection-url').addEventListener('click',()=>run(async()=>{await navigator.clipboard.writeText(getState().tunnel.url);toast('已複製連線網址');}));
  function render(){
    const {tunnel:t,cloudflare:cf}=getState(), next=JSON.stringify([t.provider,t.provider==='cloudflare'?t.hostname:'',t.teamDomain,t.audience]);
    $('#connection-auth').textContent=getState().gateway.authentication==='local'?'已明確啟用本機開發信任；直接連線可免權杖。所有通道連線仍要求 Bearer 權杖。':'雲端 AI 使用 Authorization: Bearer …，依權杖的帳號權限讀取、全文搜尋或傳送。Cloudflare Access 另需服務憑證。';
    if(signature!==next){form.elements.provider.value=t.provider;for(const key of ['hostname','teamDomain','audience'])form.elements[key].value=t.provider==='cloudflare'?t[key]||'':'';signature=next;updateProvider();}
    $('#tunnel-badge').className=`badge ${t.connected?'good':'warn'}`;$('#tunnel-badge').textContent=t.connected?'已連線':label(t.status);
    $('#connection-url').textContent=t.url||'啟動後會顯示連線網址';$('#copy-connection-url').disabled=!t.url;
    $('#tunnel-health').textContent=t.provider==='local'?'僅可從這台電腦連線。要連接雲端 AI，請啟動 Cloudflare 或 Tailscale 通道。':t.provider==='cloudflare'?`連接器：${t.cloudflaredInstalled?'已安裝':'尚未安裝'} · ${label(t.status)} · ${t.accessLastValidated?`Access 已驗證 ${when(t.accessLastValidated)}`:'Access 等待實際請求驗證'}`:t.provider==='cloudflare_quick'?`連接器：${t.cloudflaredInstalled?'已安裝':'尚未安裝'} · ${label(t.status)} · 每次啟動取得新的暫時網址`:`Tailscale ${label(t.tailscale.state)} · HTTPS 8443`;
    $('#tailscale-state').textContent=t.tailscale.installed?`已安裝 · ${label(t.tailscale.state)}`:'尚未安裝 Tailscale';$('#connect-tailscale').disabled=!t.tailscale.installed||t.tailscale.state==='Running';if(t.tailscale.state==='Running')$('#tailscale-login-link').hidden=true;
    if(clientId!==cf.clientId){$('#cf-client-id').value=cf.clientId||'';clientId=cf.clientId;}
    $('#cf-callback').textContent=cf.callback;$('#cf-login').disabled=!cf.clientId;$('#cf-disconnect').hidden=!cf.connected;$('#cf-setup').hidden=!cf.connected;
    $('#cf-oauth-status').textContent=cf.connected?`已連接 Cloudflare · 授權到期 ${when(cf.expiresAt)}`:cf.pending?'等待瀏覽器授權':cf.lastError?'授權未完成，請重新連接':cf.clientId?'OAuth 應用程式已設定':'先設定 OAuth 應用程式，或使用免帳號 Quick Tunnel';
    if(cf.connected){$('#cf-login-link').hidden=true;if($('#tunnel').classList.contains('active')&&!resourcesLoaded&&!resourcesAttempted&&!busy){resourcesAttempted=true;run(loadResources);}}
    if(!cf.connected){resourcesLoaded=false;resourcesAttempted=false;}
    const setup=cf.setup||{},phases={creating_access:'建立 Access 應用程式',creating_service_token:'建立服務權杖',creating_policy:'建立存取原則',creating_tunnel:'建立通道',configuring_tunnel:'設定通道',creating_dns:'建立 DNS 紀錄'};$('#cf-setup-summary').hidden=!setup.phase;$('#cf-setup-summary').textContent=setup.phase?`${setup.hostname} · ${setup.phase==='complete'?'設定完成':`設定停在「${phases[setup.phase]||'Cloudflare 設定'}」；請在 Cloudflare 檢查已建立的資源`}`:'';$('#cf-show-service').hidden=setup.phase!=='complete';$('#cf-provision').disabled=!!setup.phase||!$('#cf-zone').value;
  }
  return {render};
}
