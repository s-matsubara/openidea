//! Development identity is tied to the compiled worktree, never the launch cwd.

const LEGACY_BASE: &str = "ai.l0ng.openidea";

pub fn configure(mut context: tauri::Context<tauri::Wry>) -> tauri::Context<tauri::Wry> {
    // The launcher reads the same base file. Dev-only config overlays can change the URL.
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).expect("valid base Tauri configuration");
    let base = config["identifier"].as_str().expect("release identifier in Tauri configuration");
    context.config_mut().identifier = identifier(base, env!("OPENIDEA_WORKTREE_ROOT"));
    context
}

pub fn inherit_profile(id: &str) -> Result<(), String> {
    let legacy = identifier(LEGACY_BASE, env!("OPENIDEA_WORKTREE_ROOT"));
    if legacy != id {
        ide_host::data_dirs::inherit_dev_profile(&legacy, id)?;
    }
    Ok(())
}

fn identifier(base: &str, root: &str) -> String {
    // FNV-1a, shared with scripts/dev-session.ts.
    let hash =
        root.bytes().fold(0xcbf29ce484222325_u64, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3));
    format!("{base}.dev.w{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_matches_launcher_and_separates_worktrees() {
        let base = "cloud.matsubara.openidea";
        assert_eq!(identifier(base, "/repo/idea"), "cloud.matsubara.openidea.dev.w158e9c5954b7bf64");
        assert_eq!(identifier(LEGACY_BASE, "/repo/idea"), "ai.l0ng.openidea.dev.w158e9c5954b7bf64");
        assert_ne!(identifier(base, "/repo/idea"), identifier(base, "/repo/idea-other"));
    }
}
