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
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    sync::Mutex as AsyncMutex,
};

pub struct Tunnels {
    store: Arc<Store>,
    vault: Arc<Vault>,
    root: PathBuf,
    data: PathBuf,
    port: u16,
    child: Mutex<Option<Child>>,
    state: Mutex<String>,
    operation: AsyncMutex<()>,
    client: reqwest::Client,
    keys: AsyncMutex<Option<(String, Instant, JwkSet)>>,
    access: Mutex<Option<String>>,
    quick_host: Arc<Mutex<Option<String>>>,
    quick_log: Mutex<Option<tokio::task::JoinHandle<()>>>,
    login: AsyncMutex<()>,
}
impl Tunnels {
    pub fn new(
        store: Arc<Store>,
        vault: Arc<Vault>,
        root: PathBuf,
        data: PathBuf,
        port: u16,
    ) -> Self {
        Self {
            store,
            vault,
            root,
            data,
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
            quick_host: Arc::new(Mutex::new(None)),
            quick_log: Mutex::new(None),
            login: AsyncMutex::new(()),
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
        let _guard = self.operation.try_lock().map_err(|_| {
            BridgeError::new(
                409,
                "tunnel_running",
                "Wait for the current tunnel operation to finish.",
            )
        })?;
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
        if !["cloudflare", "cloudflare_quick", "tailscale"].contains(&provider) {
            return Err(BridgeError::new(
                400,
                "invalid_input",
                "Invalid tunnel provider.",
            ));
        }
        let host = if provider == "cloudflare" {
            text(v, "hostname").trim().to_lowercase()
        } else {
            String::new()
        };
        let team = if provider == "cloudflare" {
            text(v, "teamDomain").trim().to_lowercase()
        } else {
            String::new()
        };
        let audience = if provider == "cloudflare" {
            text(v, "audience").trim()
        } else {
            ""
        };
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
        let previous = self.config();
        if provider != "cloudflare" && previous["provider"] == "cloudflare" {
            self.store.set("cloudflareNamed", &previous)?;
        }
        self.store.set("tunnel", &value)?;
        if provider == "cloudflare" {
            self.store.set("cloudflareNamed", &value)?;
        }
        *self.quick_host.lock().unwrap() = None;
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
    pub async fn connect_tailscale(&self) -> Result<Value> {
        let _guard = self.login.lock().await;
        if !Self::tailscale().is_file() {
            return Err(BridgeError::new(
                409,
                "tailscale_missing",
                "Install Tailscale first.",
            ));
        }
        let before = Self::command(&["status", "--json"]).await?;
        if before["BackendState"] == "Running" {
            return Ok(json!({"connected":true,"state":"Running"}));
        }
        // Only output/wait flags: preserve all existing client preferences.
        let mut cmd = Command::new(Self::tailscale());
        cmd.args(["up", "--json", "--timeout=4s"])
            .kill_on_drop(true);
        #[cfg(target_os = "macos")]
        cmd.env("TAILSCALE_BE_CLI", "1");
        #[cfg(windows)]
        cmd.creation_flags(0x08000000);
        let output = tokio::time::timeout(Duration::from_secs(7), cmd.output())
            .await
            .map_err(|_| {
                BridgeError::new(502, "tailscale_unavailable", "Tailscale did not respond.")
            })?
            .map_err(|_| {
                BridgeError::new(502, "tailscale_unavailable", "Tailscale is unavailable.")
            })?;
        let after = Self::command(&["status", "--json"]).await?;
        if after["BackendState"] == "Running" {
            return Ok(json!({"connected":true,"state":"Running"}));
        }
        // The daemon retains the pending login after the bounded CLI command exits.
        let auth = valid_tailscale_auth(text(&after, "AuthURL")).or_else(|| {
            serde_json::Deserializer::from_slice(&output.stdout)
                .into_iter::<Value>()
                .filter_map(std::result::Result::ok)
                .find_map(|v| valid_tailscale_auth(text(&v, "AuthURL")))
        });
        if let Some(auth) = auth {
            return Ok(json!({"connected":false,"state":after["BackendState"],"authUrl":auth}));
        }
        if after["BackendState"] == "NeedsMachineAuth" {
            return Ok(json!({"connected":false,"state":"NeedsMachineAuth"}));
        }
        Err(BridgeError::new(
            502,
            "tailscale_unavailable",
            "Open the installed Tailscale client to complete sign-in.",
        ))
    }
    pub fn gateway_hostname(&self) -> String {
        if self.config()["provider"] == "cloudflare_quick" {
            self.quick_host.lock().unwrap().clone().unwrap_or_default()
        } else {
            text(&self.config(), "hostname").to_string()
        }
    }
    pub fn idle(&self) -> Result<()> {
        if self.child.lock().unwrap().is_some()
            || self.config()["provider"] == "tailscale" && *self.state.lock().unwrap() == "running"
        {
            return Err(BridgeError::new(
                409,
                "tunnel_running",
                "Stop the tunnel before changing its configuration.",
            ));
        }
        Ok(())
    }
    pub fn save_connector(&self, token: &str) -> Result<()> {
        if !(30..=16000).contains(&token.len()) || token.chars().any(char::is_whitespace) {
            return Err(BridgeError::new(
                400,
                "invalid_connector_token",
                "Invalid connector token.",
            ));
        }
        self.store.set(
            "cloudflareConnector",
            &json!(self.vault.seal(&json!(token), "cloudflare.connector")?),
        )
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
                *self.quick_host.lock().unwrap() = None;
                *self.state.lock().unwrap() = "failed".into();
            }
        }
        if value["provider"] == "cloudflare_quick" {
            value["hostname"] = json!(self.gateway_hostname());
        }
        if self.child.lock().unwrap().is_some() {
            connected = self
                .client
                .get(format!("http://127.0.0.1:{}/ready", self.port + 1))
                .timeout(Duration::from_millis(1200))
                .send()
                .await
                .is_ok_and(|r| r.status().is_success());
            if value["provider"] == "cloudflare_quick" {
                connected &= !text(&value, "hostname").is_empty();
            }
            if connected {
                *self.state.lock().unwrap() = "running".into();
            }
        }
        let mut tailscale = json!({"installed":Self::tailscale().exists(),"state":"unknown"});
        if Self::tailscale().exists() {
            match Self::command(&["status", "--json"]).await {
                Ok(s) => {
                    tailscale["state"] = s["BackendState"].clone();
                    if let Ok(serve) = Self::command(&["serve", "status", "--json"]).await {
                        let host = text(&value, "hostname");
                        if value["provider"] == "tailscale" {
                            connected = s["BackendState"] == "Running"
                                && serve["AllowFunnel"][host] != true
                                && serve["Web"][host]["Handlers"]["/"]["Proxy"]
                                    == format!("http://127.0.0.1:{}", self.port);
                        }
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
        value["namedConfig"] = self.store.setting(
            "cloudflareNamed",
            if value["provider"] == "cloudflare" {
                self.config()
            } else {
                json!({})
            },
        );
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
                let login = self.connect_tailscale().await?;
                if login["connected"] != true {
                    return Ok(login);
                }
            }
            let state = Self::command(&["status", "--json"]).await?;
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
        if c["provider"] == "cloudflare_quick" {
            self.idle()?;
            let binary = self.cloudflared();
            if !binary.is_file() {
                return Err(BridgeError::new(
                    409,
                    "cloudflared_missing",
                    "Install cloudflared first.",
                ));
            }
            // An explicit owned config avoids inheriting the user's named-tunnel config.
            let config = self.data.join("linebridge-quick.yml");
            std::fs::write(&config, "no-autoupdate: true\n").map_err(|_| BridgeError::storage())?;
            let mut command = Command::new(binary);
            command
                .args(["tunnel", "--config"])
                .arg(&config)
                .args([
                    "--no-autoupdate",
                    "--metrics",
                    &format!("127.0.0.1:{}", self.port + 1),
                    "--url",
                    &format!("http://127.0.0.1:{}", self.port),
                ])
                .env_remove("TUNNEL_TOKEN")
                .env_remove("TUNNEL_TOKEN_FILE")
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::piped())
                .kill_on_drop(true);
            #[cfg(windows)]
            command.creation_flags(0x08000000);
            let mut child = command.spawn().map_err(|_| {
                BridgeError::new(
                    502,
                    "connector_failed",
                    "Cloudflare connector could not start.",
                )
            })?;
            let stderr = child.stderr.take().ok_or_else(BridgeError::storage)?;
            let host = self.quick_host.clone();
            *host.lock().unwrap() = None;
            let log = tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if let Some(value) = quick_hostname(&line) {
                        *host.lock().unwrap() = Some(value);
                    }
                }
            });
            *self.quick_log.lock().unwrap() = Some(log);
            *self.child.lock().unwrap() = Some(child);
            *self.state.lock().unwrap() = "starting".into();
            return Ok(json!({"status":"starting"}));
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
        if let Some(log) = self.quick_log.lock().unwrap().take() {
            log.abort();
        }
        *self.quick_host.lock().unwrap() = None;
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

fn quick_hostname(line: &str) -> Option<String> {
    line.split_whitespace()
        .filter_map(|s| url::Url::parse(s.trim_matches('|')).ok())
        .find_map(|u| {
            let host = u.host_str()?;
            let prefix = host.strip_suffix(".trycloudflare.com")?;
            (u.scheme() == "https"
                && u.username().is_empty()
                && u.password().is_none()
                && u.port().is_none()
                && !prefix.is_empty()
                && prefix
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-'))
            .then(|| host.to_string())
        })
}
pub fn valid_tailscale_auth(value: &str) -> Option<String> {
    let url = url::Url::parse(value).ok()?;
    (url.scheme() == "https"
        && url.host_str() == Some("login.tailscale.com")
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.path().starts_with("/a/"))
    .then(|| url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_vendor_tunnel_and_login_urls() {
        assert_eq!(
            quick_hostname("INF | https://bright-blue-tree.trycloudflare.com |"),
            Some("bright-blue-tree.trycloudflare.com".into())
        );
        for bad in [
            "https://trycloudflare.com",
            "https://evil.trycloudflare.com.attacker.test",
            "http://abc.trycloudflare.com",
            "https://user@abc.trycloudflare.com",
            "https://a.b.trycloudflare.com",
        ] {
            assert!(quick_hostname(bad).is_none());
        }
        assert!(valid_tailscale_auth("https://login.tailscale.com/a/123").is_some());
        for bad in [
            "http://login.tailscale.com/a/123",
            "https://login.tailscale.com.evil/a/123",
            "https://login.tailscale.com:8443/a/123",
            "https://user@login.tailscale.com/a/123",
        ] {
            assert!(valid_tailscale_auth(bad).is_none());
        }
    }
}
