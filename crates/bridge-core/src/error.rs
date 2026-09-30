use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeError {
    pub status: u16,
    pub code: String,
    pub message: String,
    #[serde(default)]
    pub rejected_send: bool,
}
pub type Result<T> = std::result::Result<T, BridgeError>;
impl BridgeError {
    pub fn new(status: u16, code: &str, message: &str) -> Self {
        Self {
            status,
            code: code.into(),
            message: message.into(),
            rejected_send: false,
        }
    }
    pub fn storage() -> Self {
        Self::new(
            500,
            "storage_error",
            "Local storage could not complete the operation.",
        )
    }
    pub fn upstream() -> Self {
        Self::new(
            502,
            "upstream_unavailable",
            "The LINE protocol worker is unavailable. Resume the account; do not automatically retry sends.",
        )
    }
    pub fn json(&self) -> serde_json::Value {
        json!({"error":self.code,"message":self.message})
    }
}
impl std::fmt::Display for BridgeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.code)
    }
}
impl std::error::Error for BridgeError {}
impl From<rusqlite::Error> for BridgeError {
    fn from(_: rusqlite::Error) -> Self {
        Self::storage()
    }
}
impl IntoResponse for BridgeError {
    fn into_response(self) -> Response {
        (
            StatusCode::from_u16(self.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            Json(self.json()),
        )
            .into_response()
    }
}
pub fn text<'a>(v: &'a serde_json::Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
pub fn require_text(v: &serde_json::Value, key: &str, max: usize) -> Result<String> {
    let s = v[key]
        .as_str()
        .ok_or_else(|| BridgeError::new(400, "invalid_input", "Required text field is missing."))?;
    if s.trim().is_empty() || s.chars().count() > max {
        return Err(BridgeError::new(
            400,
            "invalid_input",
            "A text field is empty or too long.",
        ));
    }
    Ok(s.into())
}
pub fn strict(v: &serde_json::Value, allowed: &[&str]) -> Result<()> {
    if v.as_object()
        .is_none_or(|o| o.keys().any(|k| !allowed.contains(&k.as_str())))
    {
        return Err(BridgeError::new(
            400,
            "invalid_input",
            "Invalid request fields.",
        ));
    }
    Ok(())
}
