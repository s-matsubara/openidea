//! Included by binaries only: changing the app version must not rebuild ide-host's library.
pub fn init() {
    static VERSION: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    let version = VERSION.get_or_init(|| {
        let config: serde_json::Value =
            serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../src-tauri/tauri.conf.json")))
                .expect("application release configuration");
        config["version"].as_str().expect("application release version").to_owned()
    });
    ide_core::version::set_app_version(version);
}
