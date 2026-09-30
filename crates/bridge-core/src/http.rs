use crate::{
    core::{Actor, Core},
    error::{BridgeError, Result, text},
    mcp::Mcp,
};
use axum::{
    Json, Router,
    body::to_bytes,
    extract::{DefaultBodyLimit, Request, State},
    http::{HeaderValue, Method, Uri, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::any,
};
use include_dir::{Dir, include_dir};
use rmcp::transport::streamable_http_server::{
    StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
};
use serde_json::{Value, json};
use std::{collections::HashMap, sync::Arc};
use tokio::sync::watch;
static PUBLIC: Dir<'static> = include_dir!("$CARGO_MANIFEST_DIR/../../public");

fn not_found() -> BridgeError {
    BridgeError::new(404, "not_found", "Route not found.")
}
fn query(uri: &Uri) -> HashMap<String, String> {
    url::form_urlencoded::parse(uri.query().unwrap_or("").as_bytes())
        .into_owned()
        .collect()
}
fn limit(params: &HashMap<String, String>) -> Result<u64> {
    params.get("limit").map_or(Ok(30), |n| {
        n.parse()
            .map_err(|_| BridgeError::new(400, "invalid_limit", "limit must be between 1 and 100."))
    })
}
async fn body(request: Request) -> Result<Value> {
    let bytes = to_bytes(request.into_body(), 32768)
        .await
        .map_err(|_| BridgeError::new(413, "body_too_large", "Request is too large."))?;
    if bytes.is_empty() {
        Ok(json!({}))
    } else {
        serde_json::from_slice(&bytes)
            .map_err(|_| BridgeError::new(400, "invalid_json", "Invalid JSON body."))
    }
}
pub async fn admin_request(core: &Arc<Core>, method: &str, path: &str, v: Value) -> Result<Value> {
    if v.to_string().len() > 32768 {
        return Err(BridgeError::new(
            413,
            "body_too_large",
            "Request is too large.",
        ));
    }
    if path.len() > 8192 || !path.starts_with("/admin/") {
        return Err(not_found());
    }
    let uri: path::Uri = path.parse().map_err(|_| not_found())?;
    let p = uri.path().trim_matches('/').split('/').collect::<Vec<_>>();
    let q = query(&uri);
    match (method, p.as_slice()) {
        ("GET", ["admin", "state"]) => core.state().await,
        ("POST", ["admin", "pause"]) => core.pause(&v["enabled"]),
        ("POST", ["admin", "accounts"]) => core.add(&v).await,
        ("GET", ["admin", "accounts", id, "login"]) => core.login_state(id),
        ("POST", ["admin", "accounts", id, "login"]) => core.begin_login(id),
        ("POST", ["admin", "accounts", id, "reconnect"]) => core.connect(id, false).await,
        ("POST", ["admin", "accounts", id, "disconnect"]) => {
            core.disconnect(id, v["forget"] == true).await
        }
        ("DELETE", ["admin", "accounts", id]) => core.remove(id).await,
        ("POST", ["admin", "accounts", id, "discover"]) => core.discover(id).await,
        ("GET", ["admin", "accounts", id, "chats"]) => core.chats(&Actor::admin(), id),
        ("POST", ["admin", "accounts", id, "chats"]) => core.add_chat(id, &v),
        ("PATCH", ["admin", "accounts", id, "chats", cid]) => {
            let result = core.designate(id, cid, &v["enabled"])?;
            core.update_monitor(id).await?;
            Ok(result)
        }
        ("POST", ["admin", "accounts", id, "monitor"]) => core.monitor(id, &v["enabled"]).await,
        ("GET", ["admin", "accounts", id, "events"]) => {
            core.events(&Actor::admin(), id, after(&q)?, limit(&q)?)
        }
        ("GET", ["admin", "accounts", id, "chats", cid, "messages"]) => {
            core.read(
                &Actor::admin(),
                id,
                cid,
                limit(&q)?,
                q.get("cursor").map(String::as_str),
            )
            .await
        }
        ("POST", ["admin", "accounts", id, "chats", cid, "messages"]) => {
            core.send(
                &Actor::admin(),
                id,
                cid,
                text(&v, "text"),
                text(&v, "idempotencyKey"),
            )
            .await
        }
        ("POST", ["admin", "tokens"]) => core.create_token(&v),
        ("DELETE", ["admin", "tokens", id]) => core.revoke(id),
        ("PUT", ["admin", "tunnel"]) => core.tunnels.configure(&v),
        ("POST", ["admin", "tunnel", "start"]) => {
            core.tunnels.start(v["connectorToken"].as_str()).await
        }
        ("POST", ["admin", "tunnel", "stop"]) => core.tunnels.stop().await,
        _ => Err(not_found()),
    }
}
mod path {
    pub type Uri = axum::http::Uri;
}
fn after(params: &HashMap<String, String>) -> Result<u64> {
    params.get("after").map_or(Ok(0), |n| {
        n.parse().map_err(|_| {
            BridgeError::new(
                400,
                "invalid_cursor",
                "after must be a nonnegative sequence.",
            )
        })
    })
}
async fn admin_handler(State(core): State<Arc<Core>>, request: Request) -> Result<Json<Value>> {
    let method = request.method().to_string();
    let path = request.uri().to_string();
    let v = body(request).await?;
    Ok(Json(admin_request(&core, &method, &path, v).await?))
}
async fn static_handler(request: Request) -> Response {
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return not_found().into_response();
    }
    let name = if request.uri().path() == "/" {
        "index.html"
    } else {
        request.uri().path().trim_start_matches('/')
    };
    let Some(file) = PUBLIC.get_file(name) else {
        return not_found().into_response();
    };
    let mime = if name.ends_with(".html") {
        "text/html; charset=utf-8"
    } else if name.ends_with(".js") {
        "text/javascript; charset=utf-8"
    } else if name.ends_with(".css") {
        "text/css; charset=utf-8"
    } else if name.ends_with(".svg") {
        "image/svg+xml"
    } else {
        "application/octet-stream"
    };
    ([(header::CONTENT_TYPE, mime)], file.contents().to_vec()).into_response()
}
async fn admin_guard(State(core): State<Arc<Core>>, request: Request, next: Next) -> Response {
    let h = request.headers();
    let host = h
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let allowed = [
        format!("localhost:{}", core.admin_port),
        format!("127.0.0.1:{}", core.admin_port),
    ];
    if !allowed.contains(&host.to_string()) {
        return BridgeError::new(403, "local_dashboard_only", "The dashboard is local only.")
            .into_response();
    }
    let origins = allowed.map(|s| format!("http://{s}"));
    if h.get(header::ORIGIN)
        .is_some_and(|v| !origins.iter().any(|s| v == s.as_str()))
        || h.get("sec-fetch-site").is_some_and(|v| v == "cross-site")
    {
        return BridgeError::new(
            403,
            "origin_denied",
            "Cross-site dashboard access is denied.",
        )
        .into_response();
    }
    let root = request.uri().path() == "/" && request.method() == Method::GET;
    if request.uri().path().starts_with("/admin") {
        let cookie = h
            .get(header::COOKIE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if !cookie
            .split(';')
            .any(|c| c.trim() == format!("lb_admin={}", core.session))
        {
            return BridgeError::new(
                401,
                "dashboard_session_required",
                "Open the local dashboard first.",
            )
            .into_response();
        }
        if request.method() != Method::GET
            && request.method() != Method::HEAD
            && (h.get("x-line-bridge").is_none_or(|v| v != "dashboard")
                || !h.contains_key(header::ORIGIN))
        {
            return BridgeError::new(
                403,
                "origin_required",
                "A local dashboard origin is required.",
            )
            .into_response();
        }
    }
    let mut response = next.run(request).await;
    if root {
        response.headers_mut().insert(
            header::SET_COOKIE,
            HeaderValue::from_str(&format!(
                "lb_admin={}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400",
                core.session
            ))
            .unwrap(),
        );
    }
    response
}
async fn harden(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    for (name, value) in [
        ("cache-control", "no-store"),
        ("x-content-type-options", "nosniff"),
        ("referrer-policy", "no-referrer"),
        ("x-frame-options", "DENY"),
        (
            "content-security-policy",
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        ),
    ] {
        response.headers_mut().insert(
            axum::http::HeaderName::from_static(name),
            HeaderValue::from_static(value),
        );
    }
    response
}
async fn gateway_guard(
    State(core): State<Arc<Core>>,
    mut request: Request,
    next: Next,
) -> Response {
    let config = core.tunnels.config();
    let h = request.headers();
    let host = h
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if ![
        format!("localhost:{}", core.gateway_port),
        format!("127.0.0.1:{}", core.gateway_port),
        text(&config, "hostname").to_string(),
    ]
    .contains(&host.to_string())
    {
        return BridgeError::new(403, "host_denied", "Gateway Host is not allowed.")
            .into_response();
    }
    if h.contains_key(header::ORIGIN) {
        return BridgeError::new(
            403,
            "browser_origin_denied",
            "Use a server-side AI client. The local dashboard has a separate port.",
        )
        .into_response();
    }
    if request.uri().path() == "/health" {
        return Json(json!({"service":"line-bridge","status":"running","backend":"rust","version":env!("CARGO_PKG_VERSION")})).into_response();
    }
    if let Err(e) = core
        .tunnels
        .verify_access(
            h.get("cf-access-jwt-assertion")
                .and_then(|v| v.to_str().ok()),
        )
        .await
    {
        return e.into_response();
    }
    let auth = h
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .unwrap_or("");
    match core.authenticate(auth) {
        Ok(actor) => {
            request.extensions_mut().insert(actor);
            next.run(request).await
        }
        Err(e) => e.into_response(),
    }
}
async fn gateway_handler(State(core): State<Arc<Core>>, request: Request) -> Result<Json<Value>> {
    let actor = request
        .extensions()
        .get::<Actor>()
        .cloned()
        .ok_or_else(|| BridgeError::new(401, "unauthorized", "A Bearer token is required."))?;
    let p = request
        .uri()
        .path()
        .trim_matches('/')
        .split('/')
        .map(String::from)
        .collect::<Vec<_>>();
    let p = p.iter().map(String::as_str).collect::<Vec<_>>();
    let q = query(request.uri());
    let method = request.method().clone();
    let key = request
        .headers()
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let v = body(request).await?;
    let result = match (&method, p.as_slice()) {
        (&Method::GET, ["api", "v1", "status"]) => {
            Ok(json!({"enabled":true,"accounts":core.accounts(&actor)?}))
        }
        (&Method::GET, ["api", "v1", "accounts"]) => core.accounts(&actor),
        (&Method::GET, ["api", "v1", "accounts", id, "chats"]) => core.chats(&actor, id),
        (&Method::GET, ["api", "v1", "accounts", id, "events"]) => {
            core.events(&actor, id, after(&q)?, limit(&q)?)
        }
        (&Method::GET, ["api", "v1", "accounts", id, "chats", cid, "messages"]) => {
            core.read(
                &actor,
                id,
                cid,
                limit(&q)?,
                q.get("cursor").map(String::as_str),
            )
            .await
        }
        (&Method::POST, ["api", "v1", "accounts", id, "chats", cid, "messages"]) => {
            core.send(&actor, id, cid, text(&v, "text"), &key).await
        }
        _ => Err(not_found()),
    };
    Ok(Json(result?))
}
async fn api_spec() -> Json<Value> {
    let mut spec: Value =
        serde_json::from_str(include_str!("../../../openapi.json")).expect("OpenAPI");
    spec["info"]["title"] = json!("LineBridge");
    spec["info"]["version"] = json!(env!("CARGO_PKG_VERSION"));
    Json(spec)
}
pub fn routers(core: Arc<Core>) -> (Router, Router) {
    let mcp_core = core.clone();
    let config = StreamableHttpServerConfig::default()
        .with_legacy_session_mode(false)
        .with_json_response(true);
    let mcp = StreamableHttpService::new(
        move || {
            Ok(Mcp {
                core: mcp_core.clone(),
            })
        },
        LocalSessionManager::default().into(),
        config,
    );
    let admin = Router::new()
        .route("/admin/{*path}", any(admin_handler))
        .fallback(static_handler)
        .layer(DefaultBodyLimit::max(32768))
        .layer(middleware::from_fn_with_state(core.clone(), admin_guard))
        .layer(middleware::from_fn(harden))
        .with_state(core.clone());
    let gateway = Router::new()
        .route("/openapi.json", axum::routing::get(api_spec))
        .nest_service("/mcp", mcp)
        .fallback(gateway_handler)
        .layer(DefaultBodyLimit::max(32768))
        .layer(middleware::from_fn_with_state(core.clone(), gateway_guard))
        .layer(middleware::from_fn(harden))
        .with_state(core);
    (admin, gateway)
}
pub struct Servers {
    stop: watch::Sender<bool>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}
impl Servers {
    pub fn shutdown(&self) {
        let _ = self.stop.send(true);
    }
    pub async fn wait(self) {
        for task in self.tasks {
            let _ = task.await;
        }
    }
}
pub async fn serve(core: Arc<Core>) -> Result<Servers> {
    let admin = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, core.admin_port))
        .await
        .map_err(|_| {
            BridgeError::new(409, "port_in_use", "The dashboard port is already in use.")
        })?;
    let gateway = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, core.gateway_port))
        .await
        .map_err(|_| BridgeError::new(409, "port_in_use", "The gateway port is already in use."))?;
    std::fs::write(core.data.join("server.pid"), std::process::id().to_string())
        .map_err(|_| BridgeError::storage())?;
    let (admin_app, gateway_app) = routers(core.clone());
    let (stop, rx) = watch::channel(false);
    let rx2 = rx.clone();
    let tasks = vec![
        tokio::spawn(async move {
            let _ = axum::serve(admin, admin_app)
                .with_graceful_shutdown(async move {
                    let mut rx = rx;
                    let _ = rx.changed().await;
                })
                .await;
        }),
        tokio::spawn(async move {
            let _ = axum::serve(gateway, gateway_app)
                .with_graceful_shutdown(async move {
                    let mut rx = rx2;
                    let _ = rx.changed().await;
                })
                .await;
        }),
    ];
    core.boot().await;
    Ok(Servers { stop, tasks })
}
