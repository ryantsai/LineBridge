use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use line_bridge_core::{core::Core, http::routers};
use serde_json::json;
use tower::ServiceExt;
#[tokio::test]
async fn local_dashboard_and_gateway_boundaries() {
    let dir = tempfile::tempdir().unwrap();
    let core = Core::open(dir.path().into(), dir.path().join("data"), 4410, 4411).unwrap();
    let (admin, gateway) = routers(core.clone());
    let req = |path: &str, host: &str| {
        Request::builder()
            .uri(path)
            .header("host", host)
            .body(Body::empty())
            .unwrap()
    };
    assert_eq!(
        admin
            .clone()
            .oneshot(req("/", "attacker.example"))
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    let page = admin
        .clone()
        .oneshot(req("/", "localhost:4410"))
        .await
        .unwrap();
    assert_eq!(page.status(), StatusCode::OK);
    assert!(
        page.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .contains("HttpOnly; SameSite=Strict")
    );
    assert_eq!(page.headers()["cache-control"], "no-store");
    assert_eq!(
        admin
            .clone()
            .oneshot(req("/admin/state", "localhost:4410"))
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let cookie = format!("lb_admin={}", core.session);
    let mutation = Request::builder()
        .method("POST")
        .uri("/admin/pause")
        .header("host", "localhost:4410")
        .header("cookie", &cookie)
        .body(Body::from("{}"))
        .unwrap();
    assert_eq!(
        admin.clone().oneshot(mutation).await.unwrap().status(),
        StatusCode::FORBIDDEN
    );
    let oversized = Request::builder()
        .method("POST")
        .uri("/admin/pause")
        .header("host", "localhost:4410")
        .header("cookie", &cookie)
        .header("origin", "http://localhost:4410")
        .header("x-line-bridge", "dashboard")
        .body(Body::from("x".repeat(32769)))
        .unwrap();
    assert_eq!(
        admin.clone().oneshot(oversized).await.unwrap().status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
    assert_eq!(
        gateway
            .clone()
            .oneshot(req("/health", "localhost:4411"))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        gateway
            .clone()
            .oneshot(req("/api/v1/accounts", "localhost:4411"))
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let a = core
        .add(&json!({"label":"sandbox","kind":"demo"}))
        .await
        .unwrap();
    let token = core
        .create_token(
            &json!({"name":"reader","grants":[{"accountId":a["id"],"read":true,"send":false}]}),
        )
        .unwrap();
    let auth = format!("Bearer {}", token["token"].as_str().unwrap());
    let request = Request::builder()
        .uri("/api/v1/accounts")
        .header("host", "localhost:4411")
        .header("authorization", &auth)
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        gateway.clone().oneshot(request).await.unwrap().status(),
        StatusCode::OK
    );
    let browser = Request::builder()
        .uri("/api/v1/accounts")
        .header("host", "localhost:4411")
        .header("authorization", &auth)
        .header("origin", "http://localhost:4410")
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        gateway.clone().oneshot(browser).await.unwrap().status(),
        StatusCode::FORBIDDEN
    );
    core.tunnels.configure(&json!({"provider":"cloudflare","hostname":"line.example.com","teamDomain":"test.cloudflareaccess.com","audience":"aud"})).unwrap();
    let bypass = Request::builder()
        .uri("/api/v1/accounts")
        .header("host", "localhost:4411")
        .header("authorization", &auth)
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        gateway.clone().oneshot(bypass).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    core.tunnels
        .configure(&json!({"provider":"cloudflare_quick"}))
        .unwrap();
    assert_eq!(
        gateway
            .clone()
            .oneshot(req("/api/v1/accounts", "localhost:4411"))
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let quick = Request::builder()
        .uri("/api/v1/accounts")
        .header("host", "localhost:4411")
        .header("authorization", &auth)
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        gateway.oneshot(quick).await.unwrap().status(),
        StatusCode::OK
    );
}

#[tokio::test]
async fn oauth_callback_is_the_only_cross_site_entry_and_never_issues_session() {
    let dir = tempfile::tempdir().unwrap();
    let core = Core::open(dir.path().into(), dir.path().join("data"), 4420, 4421).unwrap();
    core.cloudflare
        .configure(&json!({"clientId":"test-client"}))
        .unwrap();
    let login = core.cloudflare.begin().unwrap();
    let auth = url::Url::parse(login["authUrl"].as_str().unwrap()).unwrap();
    let state = auth
        .query_pairs()
        .find(|(k, _)| k == "state")
        .unwrap()
        .1
        .into_owned();
    let (admin, _) = routers(core.clone());
    let req = |path: &str, host: &str| {
        Request::builder()
            .uri(path)
            .header("host", host)
            .header("sec-fetch-site", "cross-site")
            .body(Body::empty())
            .unwrap()
    };
    assert_eq!(
        admin
            .clone()
            .oneshot(req("/", "localhost:4420"))
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        admin
            .clone()
            .oneshot(req("/admin/state", "localhost:4420"))
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    let callback = format!(
        "/oauth/cloudflare/callback?state={state}&error=access_denied&code=private-test-code"
    );
    assert_eq!(
        admin
            .clone()
            .oneshot(req(&callback, "evil.test"))
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    let response = admin
        .clone()
        .oneshot(req(&callback, "127.0.0.1:4420"))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert!(!response.headers().contains_key("set-cookie"));
    assert_eq!(response.headers()["referrer-policy"], "no-referrer");
    assert_eq!(response.headers()["cache-control"], "no-store");
    let body = axum::body::to_bytes(response.into_body(), 8192)
        .await
        .unwrap();
    let body = String::from_utf8(body.to_vec()).unwrap();
    assert!(!body.contains("private-test-code"));
    assert!(!body.contains(&state));
    assert_eq!(
        core.cloudflare.status().unwrap()["lastError"],
        "oauth_declined"
    );
    assert_eq!(
        admin
            .oneshot(req(&callback, "127.0.0.1:4420"))
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
}
