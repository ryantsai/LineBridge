pub mod core;
pub mod error;
pub mod http;
pub mod mcp;
pub mod monitor;
pub mod store;
pub mod tunnels;
pub mod vault;
pub mod worker;

pub fn project_root() -> std::path::PathBuf {
    std::env::var_os("LINE_BRIDGE_ROOT")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../..")
                .canonicalize()
                .expect("project root")
        })
}
pub fn data_path(root: &std::path::Path) -> std::path::PathBuf {
    std::env::var_os("LINE_BRIDGE_DATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| root.join("data"))
}
