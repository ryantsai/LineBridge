use crate::{store::Store, vault::Vault};
use serde_json::{Value, json};
use std::collections::HashMap;

pub fn cached(store: &Store, vault: &Vault, account: &str) -> HashMap<String, Value> {
    let key = "bridge.aliases.v1";
    let rows = store.one(
        "SELECT value FROM secrets WHERE account_id=? AND key=?",
        &[&account, &key],
    );
    let Ok(Some(row)) = rows else {
        return HashMap::new();
    };
    let Ok(value) = vault.unseal(
        row["value"].as_str().unwrap_or(""),
        &format!("{account}:{key}"),
    ) else {
        return HashMap::new();
    };
    let now = chrono::Utc::now().timestamp_millis();
    value
        .as_array()
        .into_iter()
        .flatten()
        .take(1000)
        .filter_map(|row| {
            let id = row[0].as_str()?;
            if row[1]["expires"].as_i64()? <= now || row[1]["name"].as_str()?.is_empty() {
                return None;
            }
            Some((id.to_string(), row[1].clone()))
        })
        .collect()
}

pub fn enrich(message: &mut Value, kind: &str, names: &HashMap<String, Value>) {
    let sender = message["senderId"].as_str().unwrap_or("");
    let namespace = if kind == "openchat" { "square" } else { "talk" };
    if let Some(alias) = names.get(&format!("{namespace}:{sender}")) {
        message["senderName"] = alias["name"].clone();
        message["senderNameSource"] = alias["source"].clone();
        if alias["profileName"]
            .as_str()
            .is_some_and(|name| !name.is_empty())
        {
            message["senderProfileName"] = alias["profileName"].clone();
        }
    }
    let resolved = message["senderName"]
        .as_str()
        .is_some_and(|name| !name.trim().is_empty());
    message["senderNameStatus"] = json!(if resolved {
        "resolved"
    } else if message["senderId"]
        .as_str()
        .is_some_and(|id| !id.is_empty())
    {
        "unavailable"
    } else {
        "system"
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn namespaces_preserve_square_identity_and_stable_ids() {
        let names = HashMap::from([
            (
                "talk:member".into(),
                json!({"name":"私人別名","source":"contact_alias","profileName":"公開名稱"}),
            ),
            (
                "square:member".into(),
                json!({"name":"社群暱稱","source":"openchat_profile"}),
            ),
        ]);
        let mut message = json!({"id":"message","senderId":"member","text":"hello"});
        enrich(&mut message, "openchat", &names);
        assert_eq!(message["senderName"], "社群暱稱");
        assert!(message["senderProfileName"].is_null());
        assert_eq!(message["senderId"], "member");
        enrich(&mut message, "group", &names);
        assert_eq!(message["senderName"], "私人別名");
        assert_eq!(message["senderProfileName"], "公開名稱");
    }
    #[test]
    fn unavailable_names_do_not_become_ids() {
        let mut message = json!({"senderId":"unresolved","text":"hello"});
        enrich(&mut message, "group", &HashMap::new());
        assert!(message["senderName"].is_null());
        assert_eq!(message["senderNameStatus"], "unavailable");
        assert_eq!(message["text"], "hello");
    }
}
