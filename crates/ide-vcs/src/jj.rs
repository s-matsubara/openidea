//! Executable configuration only. No Jujutsu working-copy operations run here.
use ide_core::{IdeError, IdeResult};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::RwLock;

static CONFIGURED: RwLock<Option<PathBuf>> = RwLock::new(None);

pub fn set_jj_executable(path: Option<&Path>) {
    *CONFIGURED.write().unwrap_or_else(|e| e.into_inner()) =
        path.filter(|p| !p.as_os_str().is_empty()).map(Path::to_path_buf);
}

pub fn detected_jj_executable() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("OPENIDEA_JJ").map(PathBuf::from).filter(|p| p.is_file()) {
        return Some(path);
    }
    which::which("jj").ok().or_else(|| {
        ["/opt/homebrew/bin/jj", "/usr/local/bin/jj", "/usr/bin/jj"]
            .into_iter()
            .map(PathBuf::from)
            .find(|p| p.is_file())
    })
}

pub fn jj_version(executable: Option<&Path>) -> IdeResult<String> {
    let exe = executable.filter(|p| !p.as_os_str().is_empty()).map(Path::to_path_buf)
        .or_else(|| CONFIGURED.read().unwrap_or_else(|e| e.into_inner()).clone())
        .or_else(detected_jj_executable)
        .ok_or_else(|| IdeError::unavailable("jj executable not found; install Jujutsu or set Settings > Version Control > Jujutsu > Path to jj executable"))?;
    let mut cmd = Command::new(&exe);
    cmd.arg("--version").stdin(Stdio::null()).env("LC_ALL", "C");
    ide_core::process::prepare(&mut cmd);
    let out = cmd.output().map_err(|e| {
        IdeError::unavailable(format!(
            "cannot run {}: {e}; check Settings > Version Control > Jujutsu > Path to jj executable",
            exe.display()
        ))
    })?;
    let version = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    if !out.status.success() || !version.starts_with("jj ") {
        return Err(IdeError::invalid(format!(
            "{} is not a usable jj executable; check Settings > Version Control > Jujutsu",
            exe.display()
        )));
    }
    Ok(version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_explicit_executable_has_settings_guidance() {
        let tmp = tempfile::tempdir().unwrap();
        let error = jj_version(Some(&tmp.path().join("missing-jj"))).unwrap_err().to_string();
        assert!(error.contains("cannot run"), "{error}");
        assert!(error.contains("Settings > Version Control > Jujutsu"), "{error}");
    }

    #[cfg(unix)]
    #[test]
    fn validates_version_and_rejects_unusable_cli() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let exe = tmp.path().join("jj");
        std::fs::write(&exe, "#!/bin/sh\n[ \"$1\" = --version ] || exit 1\nprintf 'jj 0.35.0\\n'\n").unwrap();
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(jj_version(Some(&exe)).unwrap(), "jj 0.35.0");
        std::fs::write(&exe, "#!/bin/sh\nprintf 'git version 2.0\\n'\n").unwrap();
        assert!(jj_version(Some(&exe)).unwrap_err().to_string().contains("not a usable jj executable"));
        std::fs::write(&exe, "#!/bin/sh\nprintf 'jj 0.35.0\\n'\nexit 1\n").unwrap();
        assert!(jj_version(Some(&exe)).is_err());
    }
}
