use line_bridge_core::{core::Core, data_path, error::Result, http, project_root};
#[tokio::main]
async fn main() {
    if let Err(e) = run().await {
        eprintln!("LineBridge: {}", e.code);
        std::process::exit(1);
    }
}
async fn run() -> Result<()> {
    let root = project_root();
    let data = data_path(&root);
    let port = |key: &str, default: u16| {
        std::env::var(key)
            .ok()
            .and_then(|s| s.parse::<u16>().ok())
            .unwrap_or(default)
    };
    let core = Core::open(
        root,
        data,
        port("LINE_BRIDGE_ADMIN_PORT", 3210),
        port("LINE_BRIDGE_GATEWAY_PORT", 3211),
    )?;
    let servers = http::serve(core.clone()).await?;
    println!(
        "LineBridge Rust service: http://localhost:{}",
        core.admin_port
    );
    let _ = tokio::signal::ctrl_c().await;
    core.stop();
    servers.shutdown();
    servers.wait().await;
    let _ = std::fs::remove_file(core.data.join("server.pid"));
    Ok(())
}
