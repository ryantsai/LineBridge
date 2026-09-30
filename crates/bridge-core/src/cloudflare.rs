use crate::{
    error::{BridgeError, Result, strict, text},
    store::Store,
    vault::{Vault, random},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::Mutex as AsyncMutex;
use zeroize::Zeroizing;

const AUTH: &str = "https://dash.cloudflare.com/oauth2/auth";
const TOKEN: &str = "https://dash.cloudflare.com/oauth2/token";
const REVOKE: &str = "https://dash.cloudflare.com/oauth2/revoke";
const API: &str = "https://api.cloudflare.com/client/v4";
// Cloudflare's canonical scope catalog: cloudflare/mcp src/auth/derived-oauth-scopes.json.
const SCOPES: &str = "account-settings.read teams-connectors.write access-app.write access-policy.write access-org.read access-service-token.write zone.read dns.write";
pub const CALLBACK: &str = "/oauth/cloudflare/callback";
struct Pending {
    state: String,
    verifier: Zeroizing<String>,
    client: String,
    at: Instant,
}
pub struct Cloudflare {
    store: Arc<Store>,
    vault: Arc<Vault>,
    port: u16,
    client: reqwest::Client,
    pending: Mutex<Option<Pending>>,
    operation: AsyncMutex<()>,
    fault: Mutex<Option<String>>,
    #[cfg(test)]
    test_origin: Option<String>,
}
fn upstream() -> BridgeError {
    BridgeError::new(
        502,
        "cloudflare_unavailable",
        "Cloudflare could not complete the request.",
    )
}
fn oauth_required() -> BridgeError {
    BridgeError::new(
        409,
        "cloudflare_login_required",
        "Connect your Cloudflare account first.",
    )
}
pub fn id(value: &str) -> Result<&str> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
    {
        Err(BridgeError::new(
            400,
            "invalid_input",
            "Invalid Cloudflare resource ID.",
        ))
    } else {
        Ok(value)
    }
}
fn pkce(value: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(value.as_bytes()))
}
impl Cloudflare {
    pub fn new(store: Arc<Store>, vault: Arc<Vault>, port: u16) -> Self {
        Self {
            store,
            vault,
            port,
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(20))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("TLS client"),
            pending: Mutex::new(None),
            operation: AsyncMutex::new(()),
            fault: Mutex::new(None),
            #[cfg(test)]
            test_origin: None,
        }
    }
    fn endpoint(&self, base: &str, path: &str) -> String {
        #[cfg(test)]
        if let Some(origin) = &self.test_origin {
            return format!("{origin}{}{path}", url::Url::parse(base).unwrap().path());
        }
        format!("{base}{path}")
    }
    fn available(&self) -> Result<tokio::sync::MutexGuard<'_, ()>> {
        self.operation.try_lock().map_err(|_| {
            BridgeError::new(
                409,
                "cloudflare_busy",
                "A Cloudflare operation is already in progress.",
            )
        })
    }
    pub fn callback(&self) -> String {
        format!("http://127.0.0.1:{}{CALLBACK}", self.port)
    }
    fn saved(&self) -> Result<Value> {
        let cipher = self.store.setting("cloudflareOAuthToken", Value::Null);
        cipher.as_str().map_or(Ok(Value::Null), |c| {
            self.vault.unseal(c, "cloudflare.oauth")
        })
    }
    pub fn status(&self) -> Result<Value> {
        let token = self.saved()?;
        let expires = token["expiresAt"].as_i64().unwrap_or(0);
        let pending = self
            .pending
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|p| p.at.elapsed() < Duration::from_secs(600));
        Ok(
            json!({"clientId":self.store.setting("cloudflareOAuthClient",json!("")),"callback":self.callback(),"connected":!text(&token,"accessToken").is_empty() && expires>chrono::Utc::now().timestamp()+30,"expiresAt":if expires>0 {json!(chrono::DateTime::from_timestamp(expires,0).map(|d|d.to_rfc3339()))} else {Value::Null},"pending":pending,"lastError":*self.fault.lock().unwrap(),"setup":self.store.setting("cloudflareSetup",json!({}))}),
        )
    }
    pub fn configure(&self, v: &Value) -> Result<Value> {
        let _guard = self.available()?;
        strict(v, &["clientId"])?;
        id(text(v, "clientId"))?;
        if self.store.setting("cloudflareOAuthClient", Value::Null) != v["clientId"] {
            self.store.set("cloudflareOAuthToken", &Value::Null)?;
            *self.pending.lock().unwrap() = None;
        }
        self.store.set("cloudflareOAuthClient", &v["clientId"])?;
        self.status()
    }
    pub fn begin(&self) -> Result<Value> {
        let _guard = self.available()?;
        let client = self.store.setting("cloudflareOAuthClient", json!(""));
        if client.as_str().is_none_or(str::is_empty) {
            return Err(BridgeError::new(
                409,
                "cloudflare_client_required",
                "Register a PKCE OAuth client first.",
            ));
        }
        let client = client
            .as_str()
            .ok_or_else(BridgeError::storage)?
            .to_string();
        let state = URL_SAFE_NO_PAD.encode(random::<32>()?);
        let verifier = Zeroizing::new(URL_SAFE_NO_PAD.encode(random::<32>()?));
        let mut url = url::Url::parse(AUTH).expect("OAuth endpoint");
        url.query_pairs_mut().extend_pairs([
            ("client_id", client.as_str()),
            ("response_type", "code"),
            ("redirect_uri", self.callback().as_str()),
            ("state", &state),
            ("code_challenge", &pkce(&verifier)),
            ("code_challenge_method", "S256"),
            ("scope", SCOPES),
        ]);
        *self.pending.lock().unwrap() = Some(Pending {
            state,
            verifier,
            client,
            at: Instant::now(),
        });
        *self.fault.lock().unwrap() = None;
        Ok(json!({"authUrl":url.as_str(),"expiresIn":600}))
    }
    fn consume(&self, state: &str) -> Result<Pending> {
        let mut pending = self.pending.lock().unwrap();
        if pending
            .as_ref()
            .is_none_or(|p| p.state != state || p.at.elapsed() >= Duration::from_secs(600))
        {
            return Err(BridgeError::new(
                400,
                "oauth_state_invalid",
                "The sign-in request is invalid or expired.",
            ));
        }
        Ok(pending.take().expect("validated pending state"))
    }
    pub async fn finish(&self, params: &HashMap<String, String>) -> Result<()> {
        let _guard = self.operation.lock().await;
        let pending = self.consume(params.get("state").map(String::as_str).unwrap_or(""))?;
        let result=async {
            if params.contains_key("error") {return Err(BridgeError::new(400,"oauth_declined","Cloudflare authorization was declined."));}
            let code=params.get("code").filter(|s|!s.is_empty()&&s.len()<=4096).ok_or_else(||BridgeError::new(400,"oauth_code_invalid","Missing OAuth code."))?;
            if self.store.setting("cloudflareOAuthClient",Value::Null)!=pending.client {return Err(oauth_required());}
            let encoded=url::form_urlencoded::Serializer::new(String::new()).extend_pairs([
                ("grant_type","authorization_code"),("client_id",pending.client.as_str()),("code",code),("redirect_uri",self.callback().as_str()),("code_verifier",pending.verifier.as_str())]).finish();
            let response=self.client.post(self.endpoint(TOKEN, "")).header("Content-Type","application/x-www-form-urlencoded").body(encoded).send().await.map_err(|_|upstream())?;
            let value=limited_json(response).await?;
            let token=text(&value,"access_token");
            let expires=value["expires_in"].as_i64().filter(|n|*n>0&&*n<=31536000).ok_or_else(upstream)?;
            if token.is_empty() || token.len()>16000 || !text(&value,"token_type").eq_ignore_ascii_case("bearer") {return Err(upstream());}
            self.store.set("cloudflareOAuthToken",&json!(self.vault.seal(&json!({"accessToken":token,"expiresAt":chrono::Utc::now().timestamp()+expires}),"cloudflare.oauth")?))?;
            Ok(())
        }.await;
        *self.fault.lock().unwrap() = result.as_ref().err().map(|e| e.code.clone());
        result
    }
    pub async fn disconnect(&self) -> Result<Value> {
        let _guard = self.operation.lock().await;
        *self.pending.lock().unwrap() = None;
        let token = self.saved()?;
        if !text(&token, "accessToken").is_empty() {
            let client = self.store.setting("cloudflareOAuthClient", json!(""));
            let encoded = url::form_urlencoded::Serializer::new(String::new())
                .extend_pairs([
                    ("client_id", client.as_str().unwrap_or("")),
                    ("token", text(&token, "accessToken")),
                    ("token_type_hint", "access_token"),
                ])
                .finish();
            self.client
                .post(self.endpoint(REVOKE, ""))
                .header("Content-Type", "application/x-www-form-urlencoded")
                .body(encoded)
                .send()
                .await
                .map_err(|_| upstream())?
                .error_for_status()
                .map_err(|_| upstream())?;
        }
        self.store.set("cloudflareOAuthToken", &Value::Null)?;
        self.status()
    }
    pub async fn api(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value> {
        let token = self.saved()?;
        if token["expiresAt"].as_i64().unwrap_or(0) <= chrono::Utc::now().timestamp() + 30 {
            return Err(oauth_required());
        }
        let mut request = self
            .client
            .request(method, self.endpoint(API, path))
            .bearer_auth(text(&token, "accessToken"));
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request.send().await.map_err(|_| upstream())?;
        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err(oauth_required());
        }
        let value = limited_json(response).await?;
        if value["success"] != true {
            return Err(upstream());
        }
        Ok(value["result"].clone())
    }
    pub async fn resources(&self, account: Option<&str>) -> Result<Value> {
        use reqwest::Method;
        let accounts = self.api(Method::GET, "/accounts?per_page=50", None).await?;
        let Some(account) = account else {
            return Ok(json!({"accounts":accounts}));
        };
        id(account)?;
        if !accounts
            .as_array()
            .is_some_and(|a| a.iter().any(|a| text(a, "id") == account))
        {
            return Err(BridgeError::new(
                403,
                "cloudflare_account_denied",
                "Select an authorized account.",
            ));
        }
        let zones = self
            .api(
                Method::GET,
                &format!("/zones?account.id={account}&per_page=50"),
                None,
            )
            .await?;
        Ok(json!({"accounts":accounts,"zones":zones}))
    }
    pub async fn provision(
        &self,
        tunnels: &crate::tunnels::Tunnels,
        port: u16,
        v: &Value,
    ) -> Result<Value> {
        use reqwest::Method;
        strict(v, &["accountId", "zoneId", "hostname"])?;
        let _guard = self.operation.lock().await;
        tunnels.idle()?;
        let account = id(text(v, "accountId"))?;
        let zone = id(text(v, "zoneId"))?;
        let host = text(v, "hostname").trim().to_lowercase();
        let resources = self.resources(Some(account)).await?;
        let zone_info = resources["zones"]
            .as_array()
            .and_then(|zones| zones.iter().find(|z| text(z, "id") == zone))
            .ok_or_else(|| {
                BridgeError::new(
                    403,
                    "cloudflare_zone_denied",
                    "Select a zone belonging to this account.",
                )
            })?;
        let domain = text(zone_info, "name");
        if host.len() > 253
            || !host.ends_with(&format!(".{domain}"))
            || host.split('.').any(|s| {
                s.is_empty()
                    || s.len() > 63
                    || !s.as_bytes()[0].is_ascii_alphanumeric()
                    || !s.as_bytes()[s.len() - 1].is_ascii_alphanumeric()
                    || !s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            })
        {
            return Err(BridgeError::new(
                400,
                "invalid_hostname",
                "Choose a new subdomain within the selected zone.",
            ));
        }
        let previous = self.store.setting("cloudflareSetup", json!({}));
        if !text(&previous, "phase").is_empty() {
            return Err(BridgeError::new(
                409,
                "cloudflare_setup_exists",
                "A setup already exists. Review its resources in Cloudflare before creating another.",
            ));
        }
        let records = self
            .api(
                Method::GET,
                &format!("/zones/{zone}/dns_records?name={host}"),
                None,
            )
            .await?;
        if !records.as_array().is_some_and(Vec::is_empty) {
            return Err(BridgeError::new(
                409,
                "cloudflare_dns_conflict",
                "This hostname already has DNS records.",
            ));
        }
        let org = self
            .api(
                Method::GET,
                &format!("/accounts/{account}/access/organizations"),
                None,
            )
            .await
            .map_err(|_| {
                BridgeError::new(
                    409,
                    "cloudflare_zero_trust_required",
                    "Finish Cloudflare Zero Trust organization setup first.",
                )
            })?;
        let team = text(&org, "auth_domain");
        if !team.ends_with(".cloudflareaccess.com")
            || team.trim_end_matches(".cloudflareaccess.com").contains('.')
            || team.starts_with('.')
        {
            return Err(upstream());
        }
        let apps = self
            .api(
                Method::GET,
                &format!("/accounts/{account}/access/apps?per_page=100"),
                None,
            )
            .await?;
        if apps
            .as_array()
            .is_none_or(|apps| apps.iter().any(|a| text(a, "domain") == host))
        {
            return Err(BridgeError::new(
                409,
                "cloudflare_access_conflict",
                "This hostname already has an Access application.",
            ));
        }
        let mut setup = json!({"accountId":account,"zoneId":zone,"hostname":host,"teamDomain":team,"phase":"creating_access"});
        self.store.set("cloudflareSetup", &setup)?;
        let result=async {
            // Access is created before DNS. An application without allow policies blocks access.
            let app=self.api(Method::POST,&format!("/accounts/{account}/access/apps"),Some(&json!({"name":format!("LineBridge · {host}"),"type":"self_hosted","domain":host,"session_duration":"24h","app_launcher_visible":false}))).await?;
            let app_id=id(text(&app,"id"))?; let audience=text(&app,"aud");
            if audience.is_empty()||audience.len()>512 {return Err(upstream());}
            setup["applicationId"]=json!(app_id);setup["audience"]=json!(audience);setup["phase"]=json!("creating_service_token");self.store.set("cloudflareSetup",&setup)?;
            let service=self.api(Method::POST,&format!("/accounts/{account}/access/service_tokens"),Some(&json!({"name":format!("LineBridge · {host}"),"duration":"720h"}))).await?;
            let service_id=id(text(&service,"id"))?;
            if text(&service,"client_id").is_empty() || text(&service,"client_secret").is_empty() {return Err(upstream());}
            self.store.set("cloudflareServiceToken",&json!(self.vault.seal(&json!({"clientId":service["client_id"],"clientSecret":service["client_secret"],"expiresAt":service["expires_at"]}),"cloudflare.service")?))?;
            setup["serviceTokenId"]=json!(service_id);setup["phase"]=json!("creating_policy");self.store.set("cloudflareSetup",&setup)?;
            let policy=self.api(Method::POST,&format!("/accounts/{account}/access/apps/{app_id}/policies"),Some(&json!({"name":"LineBridge AI service","decision":"non_identity","include":[{"service_token":{"token_id":service_id}}],"precedence":1}))).await?;
            setup["policyId"]=policy["id"].clone();setup["phase"]=json!("creating_tunnel");self.store.set("cloudflareSetup",&setup)?;
            let tunnel=self.api(Method::POST,&format!("/accounts/{account}/cfd_tunnel"),Some(&json!({"name":format!("LineBridge-{host}"),"config_src":"cloudflare"}))).await?;
            let tunnel_id=id(text(&tunnel,"id"))?;
            setup["tunnelId"]=json!(tunnel_id);setup["phase"]=json!("configuring_tunnel");self.store.set("cloudflareSetup",&setup)?;
            self.api(Method::PUT,&format!("/accounts/{account}/cfd_tunnel/{tunnel_id}/configurations"),Some(&json!({"config":{"ingress":[{"hostname":host,"service":format!("http://127.0.0.1:{port}")},{"service":"http_status:404"}]}}))).await?;
            let connector=self.api(Method::GET,&format!("/accounts/{account}/cfd_tunnel/{tunnel_id}/token"),None).await?;
            tunnels.idle()?;
            tunnels.save_connector(connector.as_str().ok_or_else(upstream)?)?;
            tunnels.configure(&json!({"provider":"cloudflare","hostname":host,"teamDomain":team,"audience":audience}))?;
            setup["phase"]=json!("creating_dns");self.store.set("cloudflareSetup",&setup)?;
            let record=self.api(Method::POST,&format!("/zones/{zone}/dns_records"),Some(&json!({"type":"CNAME","name":host,"content":format!("{tunnel_id}.cfargotunnel.com"),"proxied":true,"ttl":1}))).await?;
            setup["dnsRecordId"]=record["id"].clone();setup["phase"]=json!("complete");self.store.set("cloudflareSetup",&setup)?;
            Ok(json!({"configured":true,"hostname":host,"setup":setup}))
        }.await;
        if let Err(ref error) = result {
            setup["error"] = json!(error.code);
            self.store.set("cloudflareSetup", &setup)?;
        }
        result
    }
    pub fn service_token(&self) -> Result<Value> {
        let cipher = self.store.setting("cloudflareServiceToken", Value::Null);
        self.vault.unseal(
            cipher.as_str().ok_or_else(|| {
                BridgeError::new(
                    404,
                    "cloudflare_service_token_missing",
                    "No saved service token.",
                )
            })?,
            "cloudflare.service",
        )
    }
}
async fn limited_json(mut response: reqwest::Response) -> Result<Value> {
    if !response.status().is_success() || response.content_length().is_some_and(|n| n > 1024 * 1024)
    {
        return Err(upstream());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| upstream())? {
        if bytes.len() + chunk.len() > 1024 * 1024 {
            return Err(upstream());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| upstream())
}
pub fn external_url(value: &str) -> Result<url::Url> {
    let url = url::Url::parse(value)
        .map_err(|_| BridgeError::new(400, "invalid_input", "Invalid login URL."))?;
    if value.len() <= 8192
        && url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && (url.host_str() == Some("dash.cloudflare.com") && url.path() == "/oauth2/auth"
            || crate::tunnels::valid_tailscale_auth(value).is_some())
    {
        Ok(url)
    } else {
        Err(BridgeError::new(
            400,
            "invalid_input",
            "Only provider sign-in URLs can be opened.",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Clone)]
    struct Mock {
        mode: &'static str,
        calls: Arc<Mutex<Vec<(String, String, String)>>>,
    }
    async fn mock_request(
        axum::extract::State(mock): axum::extract::State<Mock>,
        request: axum::extract::Request,
    ) -> axum::response::Response {
        use axum::response::IntoResponse;
        let method = request.method().to_string();
        let path = request.uri().to_string();
        let authenticated = request
            .headers()
            .get("authorization")
            .is_some_and(|v| v == "Bearer fixture-oauth-token");
        let bytes = axum::body::to_bytes(request.into_body(), 32768)
            .await
            .unwrap();
        let body = String::from_utf8(bytes.to_vec()).unwrap();
        mock.calls
            .lock()
            .unwrap()
            .push((method.clone(), path.clone(), body));
        if path == "/oauth2/token" {
            return axum::Json(json!({"access_token":"fixture-oauth-token","token_type":"Bearer","expires_in":3600})).into_response();
        }
        if path == "/oauth2/revoke" {
            return axum::http::StatusCode::OK.into_response();
        }
        assert!(authenticated, "API must receive the granted token");
        if mock.mode == "service_failure" && method == "POST" && path.ends_with("/service_tokens") {
            return axum::http::StatusCode::BAD_GATEWAY.into_response();
        }
        let result = if path.starts_with("/client/v4/accounts?") {
            json!([{"id":"account","name":"Synthetic account"}])
        } else if path.starts_with("/client/v4/zones?") {
            json!([{"id":"zone","name":"example.test"}])
        } else if path.contains("/dns_records?") {
            if mock.mode == "dns_conflict" {
                json!([{"id":"existing"}])
            } else {
                json!([])
            }
        } else if path.ends_with("/access/organizations") {
            json!({"auth_domain":"synthetic.cloudflareaccess.com"})
        } else if path.contains("/access/apps?") {
            json!([])
        } else if path.ends_with("/access/apps") {
            json!({"id":"app","aud":"fixture-audience"})
        } else if path.ends_with("/service_tokens") {
            json!({"id":"service","client_id":"fixture-client","client_secret":"fixture-service-secret","expires_at":"2030-01-01T00:00:00Z"})
        } else if path.ends_with("/policies") {
            json!({"id":"policy"})
        } else if path.ends_with("/cfd_tunnel") {
            json!({"id":"tunnel"})
        } else if path.ends_with("/configurations") {
            json!({})
        } else if path.ends_with("/token") {
            json!("fixture-connector-token-with-adequate-length")
        } else if path.ends_with("/dns_records") {
            json!({"id":"record"})
        } else {
            panic!("Unexpected test request: {method} {path}")
        };
        axum::Json(json!({"success":true,"result":result})).into_response()
    }
    async fn mock_cloudflare(
        mode: &'static str,
    ) -> (
        tempfile::TempDir,
        Cloudflare,
        crate::tunnels::Tunnels,
        Mock,
        tokio::task::JoinHandle<()>,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let vault = Arc::new(Vault::open(dir.path()).unwrap());
        let store = Arc::new(Store::open(&dir.path().join("test.sqlite")).unwrap());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let mock = Mock {
            mode,
            calls: Arc::new(Mutex::new(Vec::new())),
        };
        let router = axum::Router::new()
            .fallback(mock_request)
            .with_state(mock.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let mut cf = Cloudflare::new(store.clone(), vault.clone(), 3210);
        cf.test_origin = Some(origin);
        cf.configure(&json!({"clientId":"fixture-client"})).unwrap();
        let start = cf.begin().unwrap();
        let url = url::Url::parse(text(&start, "authUrl")).unwrap();
        let mut params = url.query_pairs().into_owned().collect::<HashMap<_, _>>();
        params.insert("code".into(), "fixture-code".into());
        cf.finish(&params).await.unwrap();
        assert!(
            cf.finish(&params).await.is_err(),
            "Authorization code must not replay"
        );
        let calls = mock.calls.lock().unwrap();
        let exchanged = url::form_urlencoded::parse(calls[0].2.as_bytes())
            .into_owned()
            .collect::<HashMap<_, _>>();
        assert_eq!(exchanged["code"], "fixture-code");
        assert_eq!(pkce(&exchanged["code_verifier"]), params["code_challenge"]);
        assert_eq!(exchanged["redirect_uri"], cf.callback());
        assert!(!exchanged.contains_key("client_secret"));
        drop(calls);
        let tunnels =
            crate::tunnels::Tunnels::new(store, vault, dir.path().into(), dir.path().into(), 3211);
        (dir, cf, tunnels, mock, server)
    }
    #[tokio::test]
    async fn authorized_setup_protects_access_before_dns_and_encrypts_all_secrets() {
        let (_dir, cf, tunnels, mock, server) = mock_cloudflare("success").await;
        let guard = cf.operation.lock().await;
        assert_eq!(
            cf.configure(&json!({"clientId":"other"})).unwrap_err().code,
            "cloudflare_busy"
        );
        assert_eq!(cf.begin().unwrap_err().code, "cloudflare_busy");
        drop(guard);
        let result = cf
            .provision(
                &tunnels,
                3211,
                &json!({"accountId":"account","zoneId":"zone","hostname":"line.example.test"}),
            )
            .await
            .unwrap();
        assert_eq!(result["configured"], true);
        assert_eq!(cf.status().unwrap()["setup"]["phase"], "complete");
        assert_eq!(tunnels.config()["audience"], "fixture-audience");
        assert_eq!(
            cf.service_token().unwrap()["clientSecret"],
            "fixture-service-secret"
        );
        let calls = mock.calls.lock().unwrap().clone();
        let changes = calls
            .iter()
            .filter(|(m, _, _)| m == "POST" || m == "PUT")
            .skip(1)
            .collect::<Vec<_>>();
        let suffixes = [
            "/access/apps",
            "/service_tokens",
            "/policies",
            "/cfd_tunnel",
            "/configurations",
            "/dns_records",
        ];
        assert_eq!(changes.len(), suffixes.len());
        for (call, suffix) in changes.iter().zip(suffixes) {
            assert!(call.1.ends_with(suffix));
        }
        let policy: Value = serde_json::from_str(&changes[2].2).unwrap();
        assert_eq!(policy["decision"], "non_identity");
        assert_eq!(policy["include"][0]["service_token"]["token_id"], "service");
        let ingress: Value = serde_json::from_str(&changes[4].2).unwrap();
        assert_eq!(
            ingress["config"]["ingress"][0]["service"],
            "http://127.0.0.1:3211"
        );
        assert_eq!(
            ingress["config"]["ingress"][1]["service"],
            "http_status:404"
        );
        drop(calls);
        for key in [
            "cloudflareOAuthToken",
            "cloudflareServiceToken",
            "cloudflareConnector",
        ] {
            assert!(
                !cf.store
                    .setting(key, Value::Null)
                    .to_string()
                    .contains("fixture-")
            );
        }
        assert!(!cf.status().unwrap().to_string().contains("secret"));
        cf.disconnect().await.unwrap();
        assert_eq!(cf.status().unwrap()["connected"], false);
        server.abort();
    }
    #[tokio::test]
    async fn conflict_and_partial_failure_never_publish_dns_or_retry_blindly() {
        for mode in ["dns_conflict", "service_failure"] {
            let (_dir, cf, tunnels, mock, server) = mock_cloudflare(mode).await;
            let request =
                json!({"accountId":"account","zoneId":"zone","hostname":"line.example.test"});
            let err = cf.provision(&tunnels, 3211, &request).await.unwrap_err();
            assert_eq!(
                err.code,
                if mode == "dns_conflict" {
                    "cloudflare_dns_conflict"
                } else {
                    "cloudflare_unavailable"
                }
            );
            if mode == "service_failure" {
                assert_eq!(
                    cf.status().unwrap()["setup"]["phase"],
                    "creating_service_token"
                );
                assert_eq!(
                    cf.provision(&tunnels, 3211, &request)
                        .await
                        .unwrap_err()
                        .code,
                    "cloudflare_setup_exists"
                );
            }
            assert!(
                !mock
                    .calls
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|(m, p, _)| m == "POST" && p.ends_with("/dns_records"))
            );
            assert_eq!(tunnels.config()["hostname"], "");
            server.abort();
        }
    }
    #[test]
    fn pkce_rfc_vector_and_one_use_state() {
        assert_eq!(
            pkce("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        let dir = tempfile::tempdir().unwrap();
        let vault = Arc::new(Vault::open(dir.path()).unwrap());
        let store = Arc::new(Store::open(&dir.path().join("test.sqlite")).unwrap());
        let cf = Cloudflare::new(store.clone(), vault.clone(), 3210);
        cf.configure(&json!({"clientId":"client-123"})).unwrap();
        let start = cf.begin().unwrap();
        let url = url::Url::parse(text(&start, "authUrl")).unwrap();
        let params = url.query_pairs().into_owned().collect::<HashMap<_, _>>();
        assert_eq!(params["code_challenge_method"], "S256");
        assert_eq!(params["scope"], SCOPES);
        assert!(!params.contains_key("client_secret"));
        assert!(cf.consume("attacker").is_err());
        let pending = cf.consume(&params["state"]).unwrap();
        assert_eq!(pkce(&pending.verifier), params["code_challenge"]);
        assert!(cf.consume(&params["state"]).is_err());
        cf.begin().unwrap();
        let mut expired = cf.pending.lock().unwrap();
        expired.as_mut().unwrap().at = Instant::now() - Duration::from_secs(601);
        let stale = expired.as_ref().unwrap().state.clone();
        drop(expired);
        assert!(cf.consume(&stale).is_err());
        store.set("cloudflareOAuthToken",&json!(vault.seal(&json!({"accessToken":"private-secret","expiresAt":chrono::Utc::now().timestamp()+300}),"cloudflare.oauth").unwrap())).unwrap();
        assert_eq!(cf.status().unwrap()["connected"], true);
        assert!(!cf.status().unwrap().to_string().contains("private-secret"));
        assert!(
            !store
                .setting("cloudflareOAuthToken", Value::Null)
                .to_string()
                .contains("private-secret")
        );
        assert!(
            vault
                .unseal(
                    store
                        .setting("cloudflareOAuthToken", Value::Null)
                        .as_str()
                        .unwrap(),
                    "wrong-context"
                )
                .is_err()
        );
    }
    #[test]
    fn login_url_allowlist() {
        assert!(external_url("https://dash.cloudflare.com/oauth2/auth?client_id=123").is_ok());
        for url in [
            "https://dash.cloudflare.com.evil/oauth2/auth",
            "https://user@dash.cloudflare.com/oauth2/auth",
            "http://dash.cloudflare.com/oauth2/auth",
            "file:///C:/windows/system32/cmd.exe",
            "https://dash.cloudflare.com/anything",
        ] {
            assert!(external_url(url).is_err());
        }
    }
}
