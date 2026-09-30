#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use line_bridge_core::{
    core::Core,
    error::BridgeError,
    http::{self, Servers},
    project_root,
};
use serde_json::Value;
use std::sync::Arc;
use tauri::Manager;
struct Desktop {
    core: Arc<Core>,
    servers: Servers,
}
#[tauri::command]
async fn admin_request(
    state: tauri::State<'_, Desktop>,
    method: String,
    path: String,
    body: Value,
) -> Result<Value, BridgeError> {
    http::admin_request(&state.core, &method, &path, body).await
}
#[tauri::command]
async fn open_provider_login(url: String) -> Result<(), BridgeError> {
    let url = line_bridge_core::cloudflare::external_url(&url)?;
    #[cfg(windows)]
    let mut command = {
        let mut c = tokio::process::Command::new("rundll32.exe");
        c.args(["url.dll,FileProtocolHandler", url.as_str()]);
        c.creation_flags(0x08000000);
        c
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut c = tokio::process::Command::new("open");
        c.arg(url.as_str());
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut c = tokio::process::Command::new("xdg-open");
        c.arg(url.as_str());
        c
    };
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|_| {
            BridgeError::new(
                502,
                "browser_open_failed",
                "Open the provider sign-in link in your browser.",
            )
        })?;
    Ok(())
}
fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            let resources = app.path().resource_dir()?;
            let root = std::env::var_os("LINE_BRIDGE_ROOT")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| {
                    if resources.join("protocol/line-worker.cjs").exists() {
                        resources
                    } else {
                        project_root()
                    }
                });
            let data = std::env::var_os("LINE_BRIDGE_DATA")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| {
                    if root.join("data/bridge.sqlite").exists() {
                        root.join("data")
                    } else {
                        app.path().app_local_data_dir().expect("application data")
                    }
                });
            let desktop = tauri::async_runtime::block_on(async {
                let core = Core::open(root, data, 3210, 3211)?;
                let servers = http::serve(core.clone()).await?;
                Ok::<_, BridgeError>(Desktop { core, servers })
            })?;
            app.manage(desktop);
            if std::env::var_os("LINE_BRIDGE_HIDE_WINDOW").is_some()
                && let Some(window) = app.get_webview_window("main")
            {
                let _ = window.hide();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![admin_request, open_provider_login])
        .build(tauri::generate_context!())
        .expect("LineBridge could not start; check whether another service owns ports 3210/3211.");
    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            let state = app.state::<Desktop>();
            state.core.stop();
            state.servers.shutdown();
            let _ = std::fs::remove_file(state.core.data.join("server.pid"));
        }
    });
}
