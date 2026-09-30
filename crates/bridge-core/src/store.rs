use crate::error::{BridgeError, Result};
use rusqlite::{Connection, ToSql, types::ValueRef};
use serde_json::{Map, Value, json};
use std::{path::Path, sync::Mutex};

pub struct Store {
    db: Mutex<Connection>,
}
pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
impl Store {
    pub fn transaction<T>(
        &self,
        job: impl FnOnce(&rusqlite::Transaction<'_>) -> Result<T>,
    ) -> Result<T> {
        let mut db = self.db.lock().map_err(|_| BridgeError::storage())?;
        let tx = db.transaction()?;
        let result = job(&tx)?;
        tx.commit()?;
        Ok(result)
    }
    pub fn open(path: &Path) -> Result<Self> {
        let db = Connection::open(path)?;
        db.busy_timeout(std::time::Duration::from_secs(5))?;
        db.execute_batch(include_str!("schema.sql"))?;
        Ok(Self { db: Mutex::new(db) })
    }
    pub fn exec(&self, sql: &str, args: &[&dyn ToSql]) -> Result<usize> {
        self.db
            .lock()
            .map_err(|_| BridgeError::storage())?
            .execute(sql, args)
            .map_err(Into::into)
    }
    pub fn rows(&self, sql: &str, args: &[&dyn ToSql]) -> Result<Vec<Value>> {
        let db = self.db.lock().map_err(|_| BridgeError::storage())?;
        let mut statement = db.prepare(sql)?;
        let names = statement
            .column_names()
            .iter()
            .map(|n| n.to_string())
            .collect::<Vec<_>>();
        let mut rows = statement.query(args)?;
        let mut result = Vec::new();
        while let Some(row) = rows.next()? {
            let mut object = Map::new();
            for (i, name) in names.iter().enumerate() {
                object.insert(
                    name.clone(),
                    match row.get_ref(i)? {
                        ValueRef::Null => Value::Null,
                        ValueRef::Integer(v) => json!(v),
                        ValueRef::Real(v) => json!(v),
                        ValueRef::Text(v) => json!(String::from_utf8_lossy(v)),
                        ValueRef::Blob(_) => return Err(BridgeError::storage()),
                    },
                );
            }
            result.push(Value::Object(object));
        }
        Ok(result)
    }
    pub fn one(&self, sql: &str, args: &[&dyn ToSql]) -> Result<Option<Value>> {
        Ok(self.rows(sql, args)?.into_iter().next())
    }
    pub fn setting(&self, key: &str, default: Value) -> Value {
        self.one("SELECT value FROM settings WHERE key=?", &[&key])
            .ok()
            .flatten()
            .and_then(|v| {
                v["value"]
                    .as_str()
                    .and_then(|s| serde_json::from_str(s).ok())
            })
            .unwrap_or(default)
    }
    pub fn set(&self, key: &str, value: &Value) -> Result<()> {
        self.exec(
            "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            &[&key, &value.to_string()],
        )?;
        Ok(())
    }
    pub fn accounts(&self) -> Result<Vec<Value>> {
        self.rows("SELECT * FROM accounts ORDER BY created_at", &[])
    }
    pub fn account(&self, id: &str) -> Result<Value> {
        self.one("SELECT * FROM accounts WHERE id=?", &[&id])?
            .ok_or_else(|| BridgeError::new(404, "account_not_found", "Account not found."))
    }
    pub fn chats(&self, id: &str) -> Result<Vec<Value>> {
        self.rows(
            "SELECT id,name,kind,enabled FROM chats WHERE account_id=? ORDER BY name",
            &[&id],
        )
    }
    pub fn audit(
        &self,
        actor: &str,
        action: &str,
        account: Option<&str>,
        chat: Option<&str>,
        outcome: &str,
    ) -> Result<()> {
        self.exec(
            "INSERT INTO audit VALUES(?,?,?,?,?,?,?)",
            &[
                &uuid::Uuid::new_v4().to_string(),
                &now(),
                &actor,
                &action,
                &account,
                &chat,
                &outcome,
            ],
        )?;
        self.exec("DELETE FROM audit WHERE id IN (SELECT id FROM audit ORDER BY at DESC LIMIT -1 OFFSET 2000)",&[])?;
        Ok(())
    }
    pub fn backup(&self, path: &Path) -> Result<()> {
        self.exec("VACUUM INTO ?", &[&path.to_string_lossy().as_ref()])?;
        Ok(())
    }
}
