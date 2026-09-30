use crate::{
    error::{BridgeError, Result, text},
    store::{Store, now},
    vault::Vault,
};
use rusqlite::params;
use serde_json::{Value, json};

// Policy and insert share a SQLite transaction. A designation revoked during a
// poll cannot race into durable storage. Only message bodies are vault-encrypted.
pub fn capture(
    store: &Store,
    vault: &Vault,
    account: &str,
    chat: &str,
    message: &Value,
) -> Result<Option<i64>> {
    let message_id = text(message, "id");
    if message_id.is_empty() || message_id.len() > 150 || message.to_string().len() > 100_000 {
        return Err(BridgeError::new(
            502,
            "invalid_message",
            "Invalid incoming message.",
        ));
    }
    let event_id = uuid::Uuid::new_v4().to_string();
    let cipher = vault.seal(message, &format!("message:{event_id}"))?;
    store.transaction(|tx|{
        let enabled:bool=tx.query_row("SELECT COALESCE((SELECT value='true' FROM settings WHERE key=?),0) AND EXISTS(SELECT 1 FROM chats WHERE account_id=? AND id=? AND enabled=1)",params![format!("monitor:{account}"),account,chat],|r|r.get(0))?;
        if !enabled{return Ok(None);}
        let inserted=tx.execute("INSERT OR IGNORE INTO messages(event_id,account_id,chat_id,message_id,cipher,at) VALUES(?,?,?,?,?,?)",params![event_id,account,chat,message_id,cipher,now()])?;
        if inserted==0{return Ok(None);}
        let sequence=tx.last_insert_rowid();
        tx.execute("DELETE FROM messages WHERE account_id=? AND seq NOT IN (SELECT seq FROM messages WHERE account_id=? ORDER BY seq DESC LIMIT 1000)",params![account,account])?;
        Ok(Some(sequence))
    })
}
pub fn messages(
    store: &Store,
    vault: &Vault,
    account: &str,
    chat: &str,
    limit: u64,
) -> Result<Vec<Value>> {
    let rows=store.rows("SELECT event_id,cipher FROM messages WHERE account_id=? AND chat_id=? ORDER BY seq DESC LIMIT ?",&[&account,&chat,&(limit as i64)])?;
    rows.iter()
        .rev()
        .map(|r| {
            vault.unseal(
                text(r, "cipher"),
                &format!("message:{}", text(r, "event_id")),
            )
        })
        .collect()
}
pub fn status(store: &Store, account: &str, streams: Value) -> Value {
    let enabled = store.setting(&format!("monitor:{account}"), json!(false)) == true;
    let counts=store.one("SELECT COUNT(*) AS count,COALESCE(MAX(seq),0) AS lastSequence,MAX(at) AS lastMessage FROM messages WHERE account_id=?",&[&account]).ok().flatten().unwrap_or(json!({}));
    let values = streams
        .as_object()
        .map(|s| s.values().collect::<Vec<_>>())
        .unwrap_or_default();
    let status = if !enabled {
        "off"
    } else if values.iter().any(|s| s["status"] == "retrying") {
        "retrying"
    } else if values
        .iter()
        .any(|s| s["status"] == "running" || s["status"] == "polling")
    {
        "running"
    } else {
        "waiting"
    };
    json!({"enabled":enabled,"status":status,"streams":streams,"storedMessages":counts["count"],"lastSequence":counts["lastSequence"],"lastMessage":counts["lastMessage"],"retention":1000})
}
