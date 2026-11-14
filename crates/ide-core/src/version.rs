//! Public application identity, supplied by executable entrypoints rather than library versions.
use std::sync::OnceLock;

static APP_VERSION: OnceLock<&'static str> = OnceLock::new();

/// Set before starting services or worker threads. Embedded hosts may supply their own release version.
pub fn set_app_version(version: &'static str) {
    assert!(!version.is_empty(), "application version is empty");
    let _ = APP_VERSION.set(version);
    assert_eq!(APP_VERSION.get().copied(), Some(version), "application version already set");
}

/// Uninitialized library users get Cargo's omitted-version default, `0.0.0`.
/// Executables must initialize their real application release before starting services.
pub fn app_version() -> &'static str {
    APP_VERSION.get().copied().unwrap_or(env!("CARGO_PKG_VERSION"))
}

#[cfg(test)]
mod tests {
    #[test]
    fn executable_version_is_independent_of_the_component() {
        assert_eq!(super::app_version(), "0.0.0");
        super::set_app_version("2099.1.2");
        super::set_app_version("2099.1.2");
        assert_eq!(super::app_version(), "2099.1.2");
    }
}
