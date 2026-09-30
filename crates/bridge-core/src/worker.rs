use crate::{
    error::{BridgeError, Result},
    store::Store,
    vault::Vault,
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{Mutex as AsyncMutex, mpsc, oneshot},
};

type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value>>>>>;
pub struct Worker {
    stdin: Arc<AsyncMutex<ChildStdin>>,
    pending: Pending,
    child: Mutex<Child>,
}
impl Worker {
    pub fn stop(&self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.start_kill();
        }
    }
    pub async fn start(
        root: &Path,
        store: Arc<Store>,
        vault: Arc<Vault>,
        events: mpsc::UnboundedSender<Value>,
    ) -> Result<Self> {
        let node = std::env::var_os("LINE_BRIDGE_NODE")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| {
                let local = root.join(if cfg!(windows) {
                    "runtime/node.exe"
                } else {
                    "runtime/node"
                });
                if local.exists() {
                    local
                } else if cfg!(target_os = "macos") && root.join("../MacOS/node").exists() {
                    root.join("../MacOS/node")
                } else {
                    "node".into()
                }
            });
        let bundle = root.join("protocol/line-worker.cjs");
        let dev = root.join("protocol/worker.mjs");
        let mut command = Command::new(node);
        command
            .arg(if bundle.exists() { bundle } else { dev })
            .current_dir(root)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command.spawn().map_err(|_| BridgeError::upstream())?;
        let stdin = Arc::new(AsyncMutex::new(
            child.stdin.take().ok_or_else(BridgeError::upstream)?,
        ));
        let stdout = child.stdout.take().ok_or_else(BridgeError::upstream)?;
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let reader_pending = pending.clone();
        let writer = stdin.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.len() > 2_000_000 {
                    break;
                }
                let Ok(v) = serde_json::from_str::<Value>(&line) else {
                    break;
                };
                match v["type"].as_str().unwrap_or("") {
                    "result" => {
                        if let Some(tx) = reader_pending
                            .lock()
                            .unwrap()
                            .remove(v["id"].as_str().unwrap_or(""))
                        {
                            let result = if v.get("error").is_some() {
                                Err(serde_json::from_value(v["error"].clone())
                                    .unwrap_or_else(|_| BridgeError::upstream()))
                            } else {
                                Ok(v["result"].clone())
                            };
                            let _ = tx.send(result);
                        }
                    }
                    "storage" => {
                        let account = v["accountId"].as_str().unwrap_or("");
                        let key = v["key"].as_str().unwrap_or("");
                        let outcome = if account.is_empty() || key.len() > 256 {
                            Err(BridgeError::storage())
                        } else if v["operation"] == "delete" {
                            store
                                .exec(
                                    "DELETE FROM secrets WHERE account_id=? AND key=?",
                                    &[&account, &key],
                                )
                                .map(|_| ())
                        } else {
                            vault.seal(&v["value"],&format!("{account}:{key}")).and_then(|cipher|store.exec("INSERT INTO secrets VALUES(?,?,?) ON CONFLICT(account_id,key) DO UPDATE SET value=excluded.value",&[&account,&key,&cipher]).map(|_|()))
                        };
                        let ack = json!({"type":"storage_ack","id":v["id"],"ok":outcome.is_ok()})
                            .to_string()
                            + "\n";
                        if writer.lock().await.write_all(ack.as_bytes()).await.is_err() {
                            break;
                        }
                    }
                    "event" => {
                        let _ = events.send(v);
                    }
                    "capture" => {
                        let result = crate::monitor::capture(
                            &store,
                            &vault,
                            v["accountId"].as_str().unwrap_or(""),
                            v["chatId"].as_str().unwrap_or(""),
                            &v["message"],
                        );
                        let ack = json!({"type":"capture_ack","id":v["id"],"ok":result.is_ok()})
                            .to_string()
                            + "\n";
                        if writer.lock().await.write_all(ack.as_bytes()).await.is_err() {
                            break;
                        }
                    }
                    _ => break,
                }
            }
            for (_, tx) in reader_pending.lock().unwrap().drain() {
                let _ = tx.send(Err(BridgeError::upstream()));
            }
        });
        Ok(Self {
            stdin,
            pending,
            child: Mutex::new(child),
        })
    }
    pub async fn call(&self, method: &str, params: Value) -> Result<Value> {
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id.clone(), tx);
        let line = json!({"id":id,"method":method,"params":params}).to_string() + "\n";
        if self
            .stdin
            .lock()
            .await
            .write_all(line.as_bytes())
            .await
            .is_err()
        {
            self.pending.lock().unwrap().remove(&id);
            return Err(BridgeError::upstream());
        }
        let timeout = if method == "connect" {
            Duration::from_secs(600)
        } else {
            Duration::from_secs(60)
        };
        let response = tokio::time::timeout(timeout, rx).await;
        self.pending.lock().unwrap().remove(&id);
        response
            .map_err(|_| BridgeError::upstream())?
            .map_err(|_| BridgeError::upstream())?
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        if let Ok(child) = self.child.get_mut() {
            let _ = child.start_kill();
        }
    }
}
