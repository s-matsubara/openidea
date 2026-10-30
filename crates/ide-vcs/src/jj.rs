//! Jujutsu executable configuration and read-only working-copy snapshots.
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

fn executable(executable: Option<&Path>) -> IdeResult<PathBuf> {
    executable.filter(|p| !p.as_os_str().is_empty()).map(Path::to_path_buf)
        .or_else(|| CONFIGURED.read().unwrap_or_else(|e| e.into_inner()).clone())
        .or_else(detected_jj_executable)
        .ok_or_else(|| IdeError::unavailable("jj executable not found; install Jujutsu or set Settings > Version Control > Jujutsu > Path to jj executable"))
}

pub fn jj_version(explicit: Option<&Path>) -> IdeResult<String> {
    let exe = executable(explicit)?;
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

/// A display snapshot of @. Files reuse the shared status model, without staging semantics.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JjWorkingCopy {
    pub change_id: String,
    pub commit_id: String,
    pub description: String,
    pub files: Vec<crate::FileStatus>,
}

// JSON escaping preserves multiline descriptions and paths including tabs/newlines.
// One log invocation snapshots disk and reads metadata/files from the same @ commit.
const SNAPSHOT_TEMPLATE: &str = r#""{\"changeId\":" ++ json(change_id) ++ ",\"commitId\":" ++ json(commit_id) ++ ",\"description\":" ++ json(description) ++ ",\"files\":[" ++ diff.files().map(|f| json({"path" => f.path(), "status" => f.status(), "source" => f.source().path(), "conflict" => f.target().conflict()})).join(",") ++ "],\"conflicts\":[" ++ conflicted_files.map(|f| json(f.path())).join(",") ++ "]}""#;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    change_id: String,
    commit_id: String,
    description: String,
    files: Vec<SnapshotFile>,
    conflicts: Vec<String>,
}

#[derive(serde::Deserialize)]
struct SnapshotFile {
    path: String,
    status: String,
    source: String,
    conflict: bool,
}

pub(crate) fn working_copy(repo: &crate::Repo) -> IdeResult<JjWorkingCopy> {
    snapshot(repo, &executable(None)?)
}

fn snapshot(repo: &crate::Repo, exe: &Path) -> IdeResult<JjWorkingCopy> {
    let mut cmd = Command::new(exe);
    cmd.current_dir(repo.root())
        .args(["--color=never", "--no-pager", "log", "--no-graph", "-r", "@", "-T", SNAPSHOT_TEMPLATE])
        .stdin(Stdio::null())
        .env("LC_ALL", "C");
    ide_core::process::prepare(&mut cmd);
    let out = cmd.output().map_err(|e| {
        IdeError::unavailable(format!("cannot run {}: {e}; check Settings > Version Control > Jujutsu", exe.display()))
    })?;
    if !out.status.success() {
        return Err(IdeError::unavailable(format!(
            "jj working-copy status in {}: {}",
            repo.root().display(),
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    let mut data: Snapshot = serde_json::from_slice(&out.stdout)
        .map_err(|e| IdeError::invalid(format!("invalid jj working-copy JSON in {}: {e}", repo.root().display())))?;
    // Inherited merge conflicts may have no diff against the auto-merged parents.
    for path in &data.conflicts {
        if let Some(file) = data.files.iter_mut().find(|f| &f.path == path) {
            file.conflict = true;
        } else {
            data.files.push(SnapshotFile {
                path: path.clone(),
                status: "modified".into(),
                source: path.clone(),
                conflict: true,
            });
        }
    }
    let ignored = repo.ignored.read().unwrap_or_else(|p| p.into_inner()).clone();
    let files = data
        .files
        .into_iter()
        .map(|f| {
            let kind = if f.conflict {
                crate::ChangeKind::Conflicted
            } else {
                match f.status.as_str() {
                    "added" | "copied" => crate::ChangeKind::Added,
                    "modified" => crate::ChangeKind::Modified,
                    "removed" => crate::ChangeKind::Deleted,
                    "renamed" => crate::ChangeKind::Renamed,
                    other => return Err(IdeError::invalid(format!("unknown jj file status: {other}"))),
                }
            };
            // Reject paths that could escape the owning workspace.
            if f.path.is_empty()
                || Path::new(&f.path).components().any(|c| !matches!(c, std::path::Component::Normal(_)))
            {
                return Err(IdeError::invalid("invalid jj repository-relative path"));
            }
            Ok(crate::FileStatus {
                path: repo.abs_path(&f.path).into(),
                rel_path: f.path,
                staged: None,
                unstaged: Some(kind),
                renamed_from: (f.status == "renamed").then_some(f.source),
            })
        })
        .collect::<IdeResult<Vec<_>>>()?
        .into_iter()
        .filter(|f| f.unstaged == Some(crate::ChangeKind::Conflicted) || !ignored.is_ignored_path(&f.rel_path))
        .collect();
    Ok(JjWorkingCopy { change_id: data.change_id, commit_id: data.commit_id, description: data.description, files })
}

#[cfg(test)]
mod snapshot_tests {
    use super::*;
    fn jj(exe: &Path, dir: &Path, args: &[&str]) {
        let out = Command::new(exe)
            .current_dir(dir)
            .args([
                "--config",
                "signing.behavior=drop",
                "--config",
                "user.name=Test",
                "--config",
                "user.email=test@example.com",
            ])
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "{args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    #[test]
    fn real_cli_snapshots_metadata_files_refresh_and_errors() {
        let Some(exe) = detected_jj_executable() else {
            eprintln!("skipping real CLI regression: optional jj executable is not installed");
            return;
        };
        let tmp = tempfile::tempdir().unwrap();
        jj(&exe, tmp.path(), &["git", "init", "--colocate"]);
        let repo = crate::Repo::discover(tmp.path()).unwrap().unwrap();
        let first = snapshot(&repo, &exe).unwrap();
        assert!(first.description.is_empty());
        assert!(first.files.is_empty());
        assert!(!first.change_id.is_empty());
        assert!(!first.commit_id.is_empty());
        for name in ["modified.txt", "deleted.txt", "old name.txt"] {
            std::fs::write(tmp.path().join(name), name).unwrap();
        }
        jj(
            &exe,
            tmp.path(),
            &[
                "new",
                "-m",
                "subject

日本語 body",
            ],
        );
        std::fs::write(tmp.path().join("modified.txt"), "changed").unwrap();
        std::fs::remove_file(tmp.path().join("deleted.txt")).unwrap();
        std::fs::rename(tmp.path().join("old name.txt"), tmp.path().join("renamed file.txt")).unwrap();
        for name in [
            "日本語 space.txt",
            "tab	and
newline.txt",
        ] {
            std::fs::write(tmp.path().join(name), "added").unwrap();
        }
        let data = snapshot(&repo, &exe).unwrap();
        assert_eq!(
            data.description,
            "subject

日本語 body
"
        );
        let file = |name: &str| data.files.iter().find(|f| f.rel_path == name).unwrap();
        assert_eq!(file("modified.txt").unstaged, Some(crate::ChangeKind::Modified));
        assert_eq!(file("deleted.txt").unstaged, Some(crate::ChangeKind::Deleted));
        assert_eq!(file("日本語 space.txt").unstaged, Some(crate::ChangeKind::Added));
        assert_eq!(
            file(
                "tab	and
newline.txt"
            )
            .unstaged,
            Some(crate::ChangeKind::Added)
        );
        assert!(data.files.iter().all(|f| f.staged.is_none()));
        assert_eq!(file("renamed file.txt").unstaged, Some(crate::ChangeKind::Renamed));
        assert_eq!(file("renamed file.txt").renamed_from.as_deref(), Some("old name.txt"));
        assert!(repo.stage(&[tmp.path().join("modified.txt")]).is_err());
        jj(&exe, tmp.path(), &["describe", "-m", "external update"]);
        assert_eq!(
            snapshot(&repo, &exe).unwrap().description,
            "external update
"
        );
        jj(&exe, tmp.path(), &["new"]);
        assert!(snapshot(&repo, &exe).unwrap().files.is_empty());
        assert!(snapshot(&repo, &tmp.path().join("missing")).unwrap_err().to_string().contains("cannot run"));
        std::fs::write(tmp.path().join("conflict.txt"), "base\n").unwrap();
        jj(&exe, tmp.path(), &["new"]);
        let base = snapshot(&repo, &exe).unwrap().commit_id;
        std::fs::write(tmp.path().join("conflict.txt"), "left\n").unwrap();
        let left = snapshot(&repo, &exe).unwrap().commit_id;
        jj(&exe, tmp.path(), &["new", &base]);
        std::fs::write(tmp.path().join("conflict.txt"), "right\n").unwrap();
        let right = snapshot(&repo, &exe).unwrap().commit_id;
        jj(&exe, tmp.path(), &["new", &left, &right]);
        let conflicted = snapshot(&repo, &exe).unwrap();
        assert_eq!(
            conflicted.files.iter().find(|f| f.rel_path == "conflict.txt").unwrap().unstaged,
            Some(crate::ChangeKind::Conflicted)
        );
        std::fs::remove_dir_all(tmp.path().join(".jj")).unwrap();
        assert!(snapshot(&repo, &exe).unwrap_err().to_string().contains("jj working-copy status"));
    }

    #[cfg(unix)]
    #[test]
    fn restricted_working_copy_does_not_spawn_configured_executable() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir_all(root.join(".jj")).unwrap();
        let marker = tmp.path().join("spawned");
        let exe = tmp.path().join("fake-jj");
        std::fs::write(&exe, format!("#!/bin/sh\ntouch '{}'\nprintf 'jj 0.35.0\\n'\n", marker.display())).unwrap();
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        let repo = crate::Repo::discover(&root).unwrap().unwrap();
        repo.set_execution_allowed(false);
        set_jj_executable(Some(&exe));
        let error = repo.jj_working_copy().unwrap_err().to_string();
        set_jj_executable(None);
        assert!(error.contains("Restricted Mode"), "{error}");
        assert!(!marker.exists(), "configured jj executable ran in Restricted Mode");
    }
}
