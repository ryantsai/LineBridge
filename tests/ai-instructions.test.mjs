import test from 'node:test';
import assert from 'node:assert/strict';
import {localCliInstructions,cloudCliInstructions} from '../public/ai-instructions.js';
const account={id:'synthetic-account',localSetup:{profile:'linebridge-synthetic',url:'http://127.0.0.1:54321',chatIds:['synthetic-chat','second-chat']}};
function assertPolicies(text){
  for(const required of ['目前未建立任何 AI 監控排程','請先取得我的明確排程指示','每個','monitor.streams','lastSuccessAt','180 秒','60 秒','等待不會更新 lastSuccessAt','pollDeadlineAt','lastFailure','訊息與游標成功寫入持久儲存並收到確認','明確同意收件對象與訊息內容','--key','delivery_unknown','不要自動重試','不要另建金鑰繞過','不可信任的資料','避免揭露憑證'])assert.ok(text.includes(required),required);
  for(const unhealthy of ['sandbox','waiting','stale','retrying','initializing','disconnected','off','no_chats'])assert.ok(text.includes(unhealthy),unhealthy);
  for(const untranslated of ['Help me use','Use the existing','Gateway URL:','Credentials are already','No AI monitoring schedule'])assert.ok(!text.includes(untranslated),untranslated);
  assert.ok(!text.includes('auth enroll'));
}
test('zh-TW local instructions preserve platform quoting, scope, protected credentials and consent rules',()=>{
  const posix=localCliInstructions(account,{node:"/tmp/app's folder/node",script:'/tmp/app with spaces/bin/linebridge.mjs',platform:'darwin'});
  assert.ok(posix.includes("'/tmp/app'\\''s folder/node' '/tmp/app with spaces/bin/linebridge.mjs' accounts --profile linebridge-synthetic"));
  const windows=localCliInstructions(account,{node:"C:\\app's folder\\node.exe",script:'C:\\app with spaces\\bin\\linebridge.mjs',platform:'win32'});
  assert.ok(windows.includes("& 'C:\\app''s folder\\node.exe' 'C:\\app with spaces\\bin\\linebridge.mjs' accounts --profile linebridge-synthetic"));
  const fallback=localCliInstructions(account);
  assert.ok(fallback.includes('CLI 執行方式（POSIX shell）：linebridge'));
  assert.ok(fallback.includes('linebridge accounts --profile linebridge-synthetic'));
  assert.ok(fallback.includes('linebridge chats --profile linebridge-synthetic --account synthetic-account'));
  for(const text of [posix,windows,fallback]){
    assertPolicies(text);
    for(const required of ['請在這台電腦上','受保護設定檔 linebridge-synthetic','閘道：http://127.0.0.1:54321','帳號：synthetic-account','已確認的聊天室：synthetic-chat, second-chat','不要輸出、複製、覆寫或重新登錄這些憑證','每個資料指令都必須帶上 --profile linebridge-synthetic','不要另行安裝或啟動其他服務','不要自行設定通道或重新登入 LINE','權限只適用於已確認的聊天室'])assert.ok(text.includes(required),required);
  }
});
test('local instructions explain explicitly confirmed automatic room scope without relaxing send consent',()=>{
  const automatic=localCliInstructions({...account,localSetup:{...account.localSetup,autoMonitorNewChats:true}});
  assert.ok(automatic.includes('已確認自動監控之後新發現的一對一、群組與 OpenChat'));
  assert.ok(automatic.includes('請使用 chats 查詢最新授權範圍'));assertPolicies(automatic);
  assert.ok(!localCliInstructions(account).includes('已確認自動監控'));
});

test('zh-TW cloud instructions preserve executable commands, pagination, install guidance and secret separation',()=>{
  const state={version:'0.6.3',tunnel:{connected:true,provider:'ngrok',url:'https://synthetic.example',token:'SYNTHETIC_PRIVATE_TOKEN'}};
  const text=cloudCliInstructions(state,"account's id");assertPolicies(text);
  const quoted="'account'\\''s id'";
  assert.deepEqual(text.split('\n').map(line=>line.trim()).filter(line=>line.startsWith('linebridge ')),[
    'linebridge accounts',`linebridge chats --account ${quoted}`,`linebridge read --account ${quoted} --chat CHAT_ID --limit 30`,
    `linebridge search --account ${quoted} --query "SEARCH_TEXT" --mode all --limit 30`,`linebridge events --account ${quoted} --after 0 --limit 100`
  ]);
  for(const required of ['請在這台雲端 AI 主機上','閘道網址：https://synthetic.example','LineBridge 0.6.3 可攜式壓縮檔','Windows x64（.zip）','macOS x64/arm64（.tar.gz）','不再支援 Linux','runtime 與 app','--version 與 accounts --help','./linebridge','.\\linebridge.cmd','npm install -g ./line-bridge-0.6.3.tgz','node bin/linebridge.mjs COMMAND','不要猜測發行檔網址','LINE_BRIDGE_TOKEN','LINE_BRIDGE_URL','不要輸出秘密','指令參數','明文檔案','--credential-stdin','不要在這裡執行 serve、設定通道或嘗試登入 LINE','hasMore 為 true','nextBefore 作為 --before','即使上一頁是空的','cursor','--after','CLI 不會因此啟動背景監看','結束代碼 8'])assert.ok(text.includes(required),required);
  assert.ok(!text.includes('SYNTHETIC_PRIVATE_TOKEN'));
});
test('every cloud provider/readiness branch is zh-TW with unchanged public URLs, IDs and placeholders',()=>{
  for(const state of [undefined,{version:'bad-version'},{tunnel:{provider:'cloudflare',connected:false,url:'https://unready.example'}},{tunnel:{provider:'local',connected:true,url:'http://127.0.0.1:4511'}}]){
    const text=cloudCliInstructions(state);assertPolicies(text);
    assert.ok(text.includes('閘道網址：https://YOUR-LINEBRIDGE-GATEWAY'));
    assert.ok(text.includes('雲端連線尚未設定'));
    assert.ok(text.includes('不要用雲端主機的 localhost 連線到我的電腦'));
    assert.ok(text.includes("linebridge chats --account 'ACCOUNT_ID'"));
    assert.ok(text.includes('LineBridge VERSION 可攜式壓縮檔'));assert.ok(!text.includes('bad-version'));
    assert.ok(!text.includes('https://unready.example'));assert.ok(!text.includes('http://127.0.0.1:4511'));
  }
  for(const provider of ['cloudflare','tailscale']){
    const text=cloudCliInstructions({version:'0.6.3',tunnel:{connected:true,provider,url:'https://synthetic.example'}},'synthetic-account');assertPolicies(text);
    assert.ok(text.includes('請使用這個連線網址'));assert.ok(text.includes("linebridge chats --account 'synthetic-account'"));
    if(provider==='cloudflare')assert.ok(text.includes('由我的秘密管理工具提供 CF_ACCESS_CLIENT_ID 與 CF_ACCESS_CLIENT_SECRET'));
    else assert.ok(text.includes('必須先加入同一個 Tailscale tailnet'));
  }
});
