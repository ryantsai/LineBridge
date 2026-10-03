#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use serde_json::Value;
use std::{
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Mutex, mpsc},
    time::{Duration, Instant},
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

// The native shell owns only process/window lifetime. Policy, encryption, SQLite
// and LINE RPCs stay in the shared, tested service; there is no second backend.
struct Desktop(Mutex<Option<Child>>);
impl Desktop {
    fn stop(&self) {
        if let Ok(mut state) = self.0.lock()
            && let Some(mut child) = state.take()
        {
            if let Some(mut input) = child.stdin.take() {
                let _ = input.write_all(b"shutdown\n");
            }
            let deadline = Instant::now() + Duration::from_secs(10);
            while Instant::now() < deadline {
                if child.try_wait().ok().flatten().is_some() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
impl Drop for Desktop {
    fn drop(&mut self) {
        self.stop();
    }
}

fn hidden(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    #[cfg(not(windows))]
    let _ = command;
}
fn node_path(path: PathBuf) -> PathBuf {
    // Tauri canonicalizes Windows resources to verbatim paths. Node's main-module
    // resolver rejects that prefix; pass the equivalent ordinary path to Node.
    #[cfg(windows)]
    {
        let value = path.to_string_lossy();
        if let Some(tail) = value.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{tail}"));
        }
        if let Some(tail) = value.strip_prefix(r"\\?\") {
            return PathBuf::from(tail);
        }
    }
    path
}
fn open_browser(url: &tauri::Url) {
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return;
    }
    #[cfg(windows)]
    let mut command = {
        let mut c = Command::new("rundll32.exe");
        c.args(["url.dll,FileProtocolHandler", url.as_str()]);
        c
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut c = Command::new("open");
        c.arg(url.as_str());
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut c = Command::new("xdg-open");
        c.arg(url.as_str());
        c
    };
    hidden(&mut command);
    let _ = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
}
fn start_service(resources: &Path) -> Result<(Desktop, tauri::Url), Box<dyn std::error::Error>> {
    let resources = node_path(resources.to_path_buf());
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let packaged = resources.join("app/server/desktop.mjs").exists();
    let app = if packaged {
        resources.join("app")
    } else {
        source.join("runtime/app")
    };
    #[cfg(windows)]
    let node = if packaged {
        resources.join("runtime/node.exe")
    } else {
        source.join("runtime/node.exe")
    };
    #[cfg(windows)]
    let connector = if packaged {
        resources.join("tools/cloudflared.exe")
    } else {
        source.join("tools/cloudflared.exe")
    };
    #[cfg(not(windows))]
    let (node, connector) = if packaged {
        let bin = std::env::current_exe()?
            .parent()
            .ok_or("Missing application directory")?
            .to_path_buf();
        (bin.join("node"), bin.join("cloudflared"))
    } else {
        (
            source.join("runtime/node"),
            source.join("tools/cloudflared"),
        )
    };
    let mut command = Command::new(node);
    command
        .arg(app.join("server/desktop.mjs"))
        .env("LINE_BRIDGE_CLOUDFLARED", connector);
    let args: Vec<String> = std::env::args().collect();
    if let Some(index) = args.iter().position(|a| a == "--data-dir") {
        command.arg("--data-dir").arg(node_path(PathBuf::from(
            args.get(index + 1).ok_or("--data-dir needs a directory")?,
        )));
    }
    #[cfg(windows)]
    if packaged
        && !args.iter().any(|a| a == "--data-dir")
        && std::env::var_os("LINE_BRIDGE_DATA").is_none()
        && let Some(parent) = resources.parent()
    {
        // Reuse an installed app's existing data even when its launcher changes
        // LOCALAPPDATA (for example, a packaged development host on Windows).
        let data = parent.join("LineBridgeData");
        if data.join("bridge.sqlite").is_file() {
            command.arg("--data-dir").arg(data);
        }
    }
    hidden(&mut command);
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()?;
    let stdout = child.stdout.take().ok_or("Missing readiness pipe")?;
    let desktop = Desktop(Mutex::new(Some(child)));
    let (send, receive) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(value) = serde_json::from_str::<Value>(&line)
                && value.get("ready").is_some()
            {
                let _ = send.send(value);
            }
        }
    });
    let ready = receive.recv_timeout(Duration::from_secs(120))?;
    if ready["ready"] != true {
        return Err(ready["message"]
            .as_str()
            .unwrap_or("LineBridge could not start")
            .into());
    }
    let url: tauri::Url = ready["url"]
        .as_str()
        .ok_or("Invalid service URL")?
        .parse()?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Invalid service URL".into());
    }
    Ok((desktop, url))
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn node_arguments_use_ordinary_windows_paths() {
        assert_eq!(
            node_path(PathBuf::from(r"\\?\C:\繁體 路徑\desktop.mjs")),
            PathBuf::from(r"C:\繁體 路徑\desktop.mjs")
        );
        assert_eq!(
            node_path(PathBuf::from(r"\\?\UNC\server\share\desktop.mjs")),
            PathBuf::from(r"\\server\share\desktop.mjs")
        );
    }
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
            let service = start_service(&app.path().resource_dir()?);
            let (desktop, url) = match service {
                Ok((desktop, url)) => (Some(desktop), WebviewUrl::External(url)),
                Err(error) => {
                    eprintln!("LineBridge startup: {error}");
                    (None, WebviewUrl::App("index.html".into()))
                }
            };
            app.manage(desktop.unwrap_or_else(|| Desktop(Mutex::new(None))));
            let mut window = WebviewWindowBuilder::new(app, "main", url)
                .title("LineBridge")
                .inner_size(1280.0, 900.0)
                .min_inner_size(800.0, 600.0)
                .on_navigation(|url| {
                    url.scheme() == "tauri"
                        || url.host_str() == Some("tauri.localhost")
                        || url.scheme() == "http" && url.host_str() == Some("127.0.0.1")
                })
                .on_new_window(|url, _| {
                    open_browser(&url);
                    tauri::webview::NewWindowResponse::Deny
                });
            if std::env::var_os("LINE_BRIDGE_HIDE_WINDOW").is_some() {
                window = window.visible(false);
            }
            window.build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("LineBridge desktop initialization failed");
    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            app.state::<Desktop>().stop();
        }
    });
}
