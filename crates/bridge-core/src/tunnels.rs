use crate::{
    error::{BridgeError, Result, strict, text},
    store::{Store, now},
    vault::Vault,
};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header, jwk::JwkSet};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    process::{Child, Command},
    sync::Mutex as AsyncMutex,
};

pub struct Tunnels {
    store: Arc<Store>,
    vault: Arc<Vault>,
    root: PathBuf,
    port: u16,
    child: Mutex<Option<Child>>,
    state: Mutex<String>,
    operation: AsyncMutex<()>,
    client: reqwest::Client,
    keys: AsyncMutex<Option<(String, Instant, JwkSet)>>,
    access: Mutex<Option<String>>,
}
impl Tunnels {
    pub fn new(store: Arc<Store>, vault: Arc<Vault>, root: PathBuf, port: u16) -> Self {
        Self {
            store,
            vault,
            root,
            port,
            child: Mutex::new(None),
            state: Mutex::new("not_started".into()),
            operation: AsyncMutex::new(()),
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(5))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("TLS client"),
            keys: AsyncMutex::new(None),
            access: Mutex::new(None),
        }
    }
    pub fn config(&self) -> Value {
        self.store.setting(
            "tunnel",
            json!({"provider":"cloudflare","hostname":"","teamDomain":"","audience":""}),
        )
    }
    fn tailscale() -> PathBuf {
        if cfg!(windows) {
            r"C:\Program Files\Tailscale\tailscale.exe".into()
        } else if cfg!(target_os = "macos") {
            [
                "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
                "/opt/homebrew/bin/tailscale",
                "/usr/local/bin/tailscale",
            ]
            .into_iter()
            .map(PathBuf::from)
            .find(|p| p.is_file())
            .unwrap_or_else(|| "/Applications/Tailscale.app/Contents/MacOS/Tailscale".into())
        } else {
            "/usr/bin/tailscale".into()
        }
    }
    fn cloudflared(&self) -> PathBuf {
        let local = self.root.join(if cfg!(windows) {
            "tools/cloudflared.exe"
        } else {
            "tools/cloudflared"
        });
        if !local.exists()
            && cfg!(target_os = "macos")
            && self.root.join("../MacOS/cloudflared").exists()
        {
            self.root.join("../MacOS/cloudflared")
        } else {
            local
        }
    }
    pub fn configure(&self, v: &Value) -> Result<Value> {
        strict(v, &["provider", "hostname", "teamDomain", "audience"])?;
        if self.child.lock().unwrap().is_some()
            || self.config()["provider"] == "tailscale" && *self.state.lock().unwrap() == "running"
        {
            return Err(BridgeError::new(
                409,
                "tunnel_running",
                "Stop the tunnel before changing its configuration.",
            ));
        }
        let provider = text(v, "provider");
        if !["cloudflare", "tailscale"].contains(&provider) {
            return Err(BridgeError::new(
                400,
                "invalid_input",
                "Invalid tunnel provider.",
            ));
        }
        let host = text(v, "hostname").trim().to_lowercase();
        let team = text(v, "teamDomain").trim().to_lowercase();
        let audience = text(v, "audience").trim();
        for s in [&host, &team] {
            if !s.is_empty()
                && (s.len() > 253
                    || s.contains("..")
                    || !s
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b".-".contains(&b))
                    || !s.as_bytes()[0].is_ascii_alphanumeric()
                    || !s.as_bytes()[s.len() - 1].is_ascii_alphanumeric())
            {
                return Err(BridgeError::new(
                    400,
                    "invalid_hostname",
                    "Enter a DNS hostname without a URL scheme, path or spaces.",
                ));
            }
        }
        if !team.is_empty()
            && (!team.ends_with(".cloudflareaccess.com")
                || team.trim_end_matches(".cloudflareaccess.com").contains('.')
                || team.starts_with('.'))
        {
            return Err(BridgeError::new(
                400,
                "invalid_team_domain",
                "Use your-team.cloudflareaccess.com as the Access team domain.",
            ));
        }
        if audience.len() > 512 {
            return Err(BridgeError::new(
                400,
                "invalid_input",
                "Invalid Access audience.",
            ));
        }
        let value =
            json!({"provider":provider,"hostname":host,"teamDomain":team,"audience":audience});
        self.store.set("tunnel", &value)?;
        *self.state.lock().unwrap() = "configured".into();
        Ok(value)
    }
    async fn command(args: &[&str]) -> Result<Value> {
        let mut cmd = Command::new(Self::tailscale());
        cmd.args(args).kill_on_drop(true);
        #[cfg(target_os = "macos")]
        cmd.env("TAILSCALE_BE_CLI", "1");
        #[cfg(windows)]
        cmd.creation_flags(0x08000000);
        let output = tokio::time::timeout(Duration::from_secs(15), cmd.output())
            .await
            .map_err(|_| {
                BridgeError::new(502, "tailscale_unavailable", "Tailscale did not respond.")
            })?
            .map_err(|_| {
                BridgeError::new(502, "tailscale_unavailable", "Tailscale is unavailable.")
            })?;
        if !output.status.success() {
            return Err(BridgeError::new(
                502,
                "tailscale_unavailable",
                "Tailscale could not complete the operation.",
            ));
        }
        if !args.contains(&"--json") || output.stdout.is_empty() {
            Ok(json!({}))
        } else {
            serde_json::from_slice(&output.stdout).map_err(|_| {
                BridgeError::new(
                    502,
                    "tailscale_unavailable",
                    "Tailscale returned an unexpected response.",
                )
            })
        }
    }
    pub async fn status(&self) -> Result<Value> {
        let mut value = self.config();
        let mut connected = false;
        {
            let mut child = self.child.lock().unwrap();
            if child
                .as_mut()
                .is_some_and(|c| c.try_wait().ok().flatten().is_some())
            {
                *child = None;
                *self.state.lock().unwrap() = "stopped".into();
            }
        }
        if self.child.lock().unwrap().is_some() {
            connected = self
                .client
                .get(format!("http://127.0.0.1:{}/ready", self.port + 1))
                .timeout(Duration::from_millis(1200))
                .send()
                .await
                .is_ok_and(|r| r.status().is_success());
            if connected {
                *self.state.lock().unwrap() = "running".into();
            }
        }
        let mut tailscale = json!({"installed":Self::tailscale().exists(),"state":"unknown"});
        if value["provider"] == "tailscale" && Self::tailscale().exists() {
            match Self::command(&["status", "--json"]).await {
                Ok(s) => {
                    tailscale["state"] = s["BackendState"].clone();
                    if let Ok(serve) = Self::command(&["serve", "status", "--json"]).await {
                        let host = text(&value, "hostname");
                        connected = s["BackendState"] == "Running"
                            && serve["AllowFunnel"][host] != true
                            && serve["Web"][host]["Handlers"]["/"]["Proxy"]
                                == format!("http://127.0.0.1:{}", self.port);
                    }
                }
                Err(_) => tailscale["state"] = json!("unavailable"),
            }
        }
        value["status"] = json!(*self.state.lock().unwrap());
        value["connected"] = json!(connected);
        value["cloudflaredInstalled"] = json!(self.cloudflared().exists());
        value["hasConnectorToken"] = json!(
            !self
                .store
                .setting("cloudflareConnector", Value::Null)
                .is_null()
        );
        value["tailscale"] = tailscale;
        value["url"] = if text(&value, "hostname").is_empty() {
            Value::Null
        } else {
            json!(format!("https://{}", text(&value, "hostname")))
        };
        value["accessConfigured"] = json!(
            value["provider"] == "cloudflare"
                && !text(&value, "hostname").is_empty()
                && !text(&value, "teamDomain").is_empty()
                && !text(&value, "audience").is_empty()
        );
        value["accessLastValidated"] = json!(*self.access.lock().unwrap());
        Ok(value)
    }
    pub async fn start(&self, token: Option<&str>) -> Result<Value> {
        let _guard = self.operation.lock().await;
        let c = self.config();
        if c["provider"] == "tailscale" {
            if !Self::tailscale().exists() {
                return Err(BridgeError::new(
                    409,
                    "tailscale_missing",
                    "Install Tailscale first.",
                ));
            }
            let state = Self::command(&["status", "--json"]).await?;
            if state["BackendState"] != "Running" {
                return Err(BridgeError::new(
                    409,
                    "tailscale_stopped",
                    "Connect Tailscale on this PC first.",
                ));
            }
            let dns = text(&state["Self"], "DNSName").trim_end_matches('.');
            if dns.is_empty() {
                return Err(BridgeError::new(
                    502,
                    "tailscale_unavailable",
                    "Tailscale did not return a DNS name.",
                ));
            }
            let host = format!("{dns}:8443");
            let existing = Self::command(&["serve", "status", "--json"]).await?;
            if existing["AllowFunnel"][&host] == true {
                return Err(BridgeError::new(
                    409,
                    "public_route_exists",
                    "Port 8443 has a public Funnel route.",
                ));
            }
            let proxy = format!("http://127.0.0.1:{}", self.port);
            let handler = &existing["Web"][&host]["Handlers"]["/"];
            if !handler.is_null() && handler["Proxy"] != proxy {
                return Err(BridgeError::new(
                    409,
                    "serve_conflict",
                    "Tailscale port 8443 already serves another application.",
                ));
            }
            Self::command(&["serve", "--bg", "--https=8443", &proxy]).await?;
            self.store.set(
                "tunnel",
                &json!({"provider":"tailscale","hostname":host,"teamDomain":"","audience":""}),
            )?;
            *self.state.lock().unwrap() = "running".into();
            return Ok(json!({"status":"running","url":format!("https://{host}")}));
        }
        let binary = self.cloudflared();
        if !binary.exists() {
            return Err(BridgeError::new(
                409,
                "cloudflared_missing",
                "The bundled cloudflared connector is missing. Reinstall LineBridge or prepare its runtime.",
            ));
        }
        if text(&c, "hostname").is_empty()
            || text(&c, "teamDomain").is_empty()
            || text(&c, "audience").is_empty()
        {
            return Err(BridgeError::new(
                409,
                "access_setup_required",
                "Configure the hostname, Access team domain and application AUD before starting the tunnel.",
            ));
        }
        if self.child.lock().unwrap().is_some() {
            return Err(BridgeError::new(
                409,
                "tunnel_running",
                "The connector is already running.",
            ));
        }
        if let Some(token) = token.filter(|t| !t.is_empty()) {
            if !(30..=16000).contains(&token.len()) || token.chars().any(char::is_whitespace) {
                return Err(BridgeError::new(
                    400,
                    "invalid_connector_token",
                    "Paste a valid Cloudflare tunnel connector token.",
                ));
            }
            self.store.set(
                "cloudflareConnector",
                &json!(self.vault.seal(&json!(token), "cloudflare.connector")?),
            )?;
        }
        let cipher = self.store.setting("cloudflareConnector", Value::Null);
        let cipher = cipher.as_str().ok_or_else(|| {
            BridgeError::new(
                409,
                "connector_token_required",
                "A Cloudflare tunnel connector token is required.",
            )
        })?;
        let token = self.vault.unseal(cipher, "cloudflare.connector")?;
        let mut command = Command::new(binary);
        command
            .args([
                "tunnel",
                "--no-autoupdate",
                "--metrics",
                &format!("127.0.0.1:{}", self.port + 1),
                "run",
            ])
            .env(
                "TUNNEL_TOKEN",
                token.as_str().ok_or_else(BridgeError::storage)?,
            )
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let child = command.spawn().map_err(|_| {
            BridgeError::new(
                502,
                "connector_failed",
                "Cloudflare connector could not start.",
            )
        })?;
        *self.child.lock().unwrap() = Some(child);
        *self.state.lock().unwrap() = "starting".into();
        Ok(json!({"status":"starting"}))
    }
    pub async fn stop(&self) -> Result<Value> {
        let _guard = self.operation.lock().await;
        self.close();
        let c = self.config();
        if c["provider"] == "tailscale" {
            let current = Self::command(&["serve", "status", "--json"]).await?;
            let host = text(&c, "hostname");
            if current["Web"][host]["Handlers"]["/"]["Proxy"]
                == format!("http://127.0.0.1:{}", self.port)
            {
                Self::command(&["serve", "--https=8443", "off"]).await?;
            }
        }
        *self.state.lock().unwrap() = "stopped".into();
        Ok(json!({"status":"stopped","connected":false}))
    }
    pub fn close(&self) {
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.start_kill();
        }
    }
    pub async fn verify_access(&self, assertion: Option<&str>) -> Result<()> {
        let c = self.config();
        if c["provider"] != "cloudflare" || text(&c, "hostname").is_empty() {
            return Ok(());
        }
        if text(&c, "teamDomain").is_empty() || text(&c, "audience").is_empty() {
            return Err(BridgeError::new(
                503,
                "access_not_configured",
                "Cloudflare Access must be configured before remote access.",
            ));
        }
        let required = || {
            BridgeError::new(
                401,
                "cloudflare_access_required",
                "Cloudflare Access authentication is required in addition to a LineBridge Bearer token.",
            )
        };
        let invalid = || {
            BridgeError::new(
                401,
                "invalid_access_assertion",
                "Cloudflare Access authentication failed.",
            )
        };
        let jwt = assertion
            .filter(|a| a.len() <= 16000)
            .ok_or_else(required)?;
        let header = decode_header(jwt).map_err(|_| invalid())?;
        if header.alg != Algorithm::RS256 {
            return Err(invalid());
        }
        let kid = header.kid.ok_or_else(invalid)?;
        let issuer = format!("https://{}", text(&c, "teamDomain"));
        let mut cache = self.keys.lock().await;
        if cache
            .as_ref()
            .is_none_or(|(old, at, _)| old != &issuer || at.elapsed() > Duration::from_secs(600))
        {
            let keys = self
                .client
                .get(format!("{issuer}/cdn-cgi/access/certs"))
                .send()
                .await
                .map_err(|_| invalid())?
                .error_for_status()
                .map_err(|_| invalid())?
                .json::<JwkSet>()
                .await
                .map_err(|_| invalid())?;
            *cache = Some((issuer.clone(), Instant::now(), keys));
        }
        let jwk = cache.as_ref().unwrap().2.find(&kid).ok_or_else(invalid)?;
        let key = DecodingKey::from_jwk(jwk).map_err(|_| invalid())?;
        let mut validation = Validation::new(Algorithm::RS256);
        validation.set_issuer(&[issuer]);
        validation.set_audience(&[text(&c, "audience")]);
        validation.leeway = 30;
        decode::<Value>(jwt, &key, &validation).map_err(|_| invalid())?;
        *self.access.lock().unwrap() = Some(now());
        Ok(())
    }
}
