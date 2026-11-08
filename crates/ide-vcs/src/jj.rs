//! Jujutsu executable configuration and read-only working-copy snapshots.
use ide_core::{IdeError, IdeResult};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::RwLock;

pub(crate) mod remote;

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

/// Read remotes through jj, including non-colocated and linked workspaces.
pub(crate) fn git_remotes(repo: &crate::Repo) -> IdeResult<Vec<crate::Remote>> {
    let bytes = read_command(repo, &executable(None)?, &["git", "remote", "list"])?;
    let text = String::from_utf8(bytes).map_err(|_| IdeError::invalid("Jujutsu remotes are not UTF-8"))?;
    text.lines()
        .map(|line| {
            let (name, url) = if line.starts_with('"') {
                let mut values = serde_json::Deserializer::from_str(line).into_iter::<String>();
                let name =
                    values.next().and_then(Result::ok).ok_or_else(|| IdeError::invalid("Invalid jj remote name"))?;
                (name, line[values.byte_offset()..].trim_start())
            } else {
                let (name, url) =
                    line.split_once(char::is_whitespace).ok_or_else(|| IdeError::invalid("Invalid jj remote"))?;
                (name.to_owned(), url.trim_start())
            };
            Ok(crate::Remote { name, url: url.to_owned() })
        })
        .collect()
}

pub(crate) fn working_copy(repo: &crate::Repo) -> IdeResult<JjWorkingCopy> {
    repo.require_execution_allowed()?;
    snapshot(repo, &executable(None)?)
}

fn snapshot(repo: &crate::Repo, exe: &Path) -> IdeResult<JjWorkingCopy> {
    repo.require_execution_allowed()?;
    snapshot_at(repo, exe, None)
}

fn snapshot_at(repo: &crate::Repo, exe: &Path, revision: Option<&str>) -> IdeResult<JjWorkingCopy> {
    repo.require_execution_allowed()?;
    if repo.kind() != crate::VcsKind::Jj {
        return Err(IdeError::invalid("Jujutsu history requires a Jujutsu repository"));
    }
    if revision.is_some_and(|id| id.len() != 40 || !id.bytes().all(|b| b.is_ascii_hexdigit())) {
        return Err(IdeError::invalid("Jujutsu history requires a full immutable commit ID"));
    }
    let mut cmd = Command::new(exe);
    if revision.is_some() {
        cmd.arg("--ignore-working-copy");
    }
    cmd.current_dir(repo.root())
        .args([
            "--color=never",
            "--no-pager",
            "log",
            "--no-graph",
            "-r",
            revision.unwrap_or("@"),
            "-T",
            SNAPSHOT_TEMPLATE,
        ])
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
    for path in data.conflicts.iter().filter(|_| revision.is_none()) {
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
    if revision.is_some_and(|id| id != data.commit_id) {
        return Err(IdeError::invalid("Jujutsu history commit identity mismatch"));
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
        .filter(|f| {
            revision.is_some()
                || f.unstaged == Some(crate::ChangeKind::Conflicted)
                || !ignored.is_ignored_path(&f.rel_path)
        })
        .collect();
    Ok(JjWorkingCopy { change_id: data.change_id, commit_id: data.commit_id, description: data.description, files })
}

/// Draft identity: an immutable anchor plus the description the user started editing.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JjDescriptionEdit {
    pub commit: String,
    pub change: String,
    pub original: String,
    pub description: String,
}

pub(crate) fn describe(repo: &crate::Repo, edit: &JjDescriptionEdit) -> IdeResult<()> {
    describe_with(repo, edit, &executable(None)?)
}

fn describe_with(repo: &crate::Repo, edit: &JjDescriptionEdit, exe: &Path) -> IdeResult<()> {
    use std::io::Write;
    repo.require_execution_allowed()?;
    if edit.commit.len() != 40 || !edit.commit.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(IdeError::invalid("Description requires a full commit identity"));
    }
    let copy = snapshot(repo, exe)?;
    if copy.change_id != edit.change || copy.description != edit.original {
        return Err(IdeError::invalid("Working copy or description changed; refresh and review the description"));
    }
    // File snapshots rewrite the commit while preserving change identity. Only
    // accept successors of the draft's immutable anchor, never a divergent version.
    if copy.commit_id != edit.commit {
        let evolution = read_command(
            repo,
            exe,
            &["evolog", "--no-graph", "-r", &copy.commit_id, "-T", "commit.commit_id() ++ \"\\n\""],
        )?;
        if !String::from_utf8_lossy(&evolution).lines().any(|id| id == edit.commit) {
            return Err(IdeError::invalid("Working-copy version diverged; review the description before saving"));
        }
    }
    // Ignore disk snapshotting here: the validated commit remains current through
    // ordinary file edits. exactly() rejects an empty intersection after an external
    // mutation/switch; describe alone treats empty selections as successful no-ops.
    let target = format!("exactly(({} & @), 1)", copy.commit_id);
    let mut cmd = Command::new(exe);
    cmd.current_dir(repo.root())
        .args(["--color=never", "--no-pager", "--ignore-working-copy", "describe", "-r", &target, "--stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("LC_ALL", "C");
    ide_core::process::prepare(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| IdeError::unavailable(format!("cannot run jj: {e}")))?;
    let written = child.stdin.take().unwrap().write_all(edit.description.as_bytes());
    let out = child.wait_with_output().map_err(|e| IdeError::unavailable(format!("jj describe: {e}")))?;
    if !out.status.success() {
        return Err(IdeError::unavailable(format!("jj describe: {}", String::from_utf8_lossy(&out.stderr).trim())));
    }
    written.map_err(|e| IdeError::unavailable(format!("jj description input: {e}")))?;
    Ok(())
}

/// Restore only listed changed entries from the single parent of the accepted @.
pub(crate) fn restore_files(repo: &crate::Repo, commit: &str, paths: &[PathBuf]) -> IdeResult<()> {
    restore_files_with(repo, commit, paths, &executable(None)?)
}

fn restore_files_with(repo: &crate::Repo, commit: &str, paths: &[PathBuf], exe: &Path) -> IdeResult<()> {
    repo.require_execution_allowed()?;
    let copy = snapshot(repo, exe)?;
    if copy.commit_id != commit || paths.is_empty() {
        return Err(IdeError::invalid("Working copy changed or no files checked; refresh and try again"));
    }
    let parents: Vec<String> = serde_json::from_slice(&read_command(
        repo,
        exe,
        &["log", "-G", "-r", commit, "-T", "json(parents.map(|p| p.commit_id()))"],
    )?)
    .map_err(|e| IdeError::invalid(format!("invalid jj parents: {e}")))?;
    if parents.len() != 1 {
        return Err(IdeError::unavailable("Rollback against auto-merged parents is not supported; use jj restore"));
    }
    let mut names = std::collections::BTreeSet::new();
    for path in paths {
        let file = copy
            .files
            .iter()
            .find(|f| f.path.as_ref() == path)
            .ok_or_else(|| IdeError::invalid("Rollback target is no longer a changed file"))?;
        if file.unstaged == Some(crate::ChangeKind::Conflicted) {
            return Err(IdeError::unavailable("Resolve Jujutsu conflicts before rollback"));
        }
        names.insert(file.rel_path.clone());
        if let Some(old) = &file.renamed_from {
            names.insert(old.clone());
        }
    }
    for name in &names {
        let rel = Path::new(name);
        if rel.as_os_str().is_empty() || rel.components().any(|c| !matches!(c, std::path::Component::Normal(_))) {
            return Err(IdeError::invalid("Invalid rollback path"));
        }
        // Never traverse an on-disk symlink directory, including deleted-file parents.
        let mut ancestor = repo.root().to_path_buf();
        for part in rel.parent().unwrap_or(Path::new("")).components() {
            ancestor.push(part);
            if ancestor.symlink_metadata().is_ok_and(|m| m.file_type().is_symlink()) {
                return Err(IdeError::invalid("Rollback path crosses a symlink directory"));
            }
        }
    }
    // @ intersection makes a CLI snapshot/external switch between validation and
    // mutation fail instead of rewriting a stale commit or a different working copy.
    let destination = format!("({commit} & @)");
    let mut cmd = Command::new(exe);
    cmd.current_dir(repo.root()).args([
        "--color=never",
        "--no-pager",
        "restore",
        "--from",
        &parents[0],
        "--into",
        &destination,
        "--",
    ]);
    for name in names {
        cmd.arg(format!("file:{}", serde_json::to_string(&name).unwrap()));
    }
    cmd.stdin(Stdio::null()).env("LC_ALL", "C");
    ide_core::process::prepare(&mut cmd);
    let out = cmd.output().map_err(|e| IdeError::unavailable(format!("cannot run jj: {e}")))?;
    if !out.status.success() {
        return Err(IdeError::unavailable(format!("jj rollback: {}", String::from_utf8_lossy(&out.stderr).trim())));
    }
    Ok(())
}

/// A file in an immutable Jujutsu revision.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JjBlameTarget {
    pub root: PathBuf,
    pub path: PathBuf,
    pub commit: String,
}

/// Immutable text pair for the shared diff viewer.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JjFileDiff {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before_blame: Option<JjBlameTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_blame: Option<JjBlameTarget>,
    pub before: String,
    pub after: String,
    pub before_label: String,
    pub after_label: String,
}

fn read_command(repo: &crate::Repo, exe: &Path, args: &[&str]) -> IdeResult<Vec<u8>> {
    repo.require_execution_allowed()?;
    let mut cmd = Command::new(exe);
    cmd.current_dir(repo.root())
        .args(["--color=never", "--no-pager", "--ignore-working-copy"])
        .args(args)
        .stdin(Stdio::null())
        .env("LC_ALL", "C");
    ide_core::process::prepare(&mut cmd);
    let out = cmd.output().map_err(|e| IdeError::unavailable(format!("cannot run jj: {e}")))?;
    if !out.status.success() {
        return Err(IdeError::unavailable(format!("jj read: {}", String::from_utf8_lossy(&out.stderr).trim())));
    }
    Ok(out.stdout)
}

pub(crate) fn annotate(repo: &crate::Repo, path: &Path, commit: &str, text: &str) -> IdeResult<Vec<crate::BlameLine>> {
    repo.require_execution_allowed()?;
    if repo.kind() != crate::VcsKind::Jj || commit.len() != 40 || !commit.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(IdeError::invalid("Invalid Jujutsu annotation revision"));
    }
    let rel = path.strip_prefix(repo.root()).map_err(|_| IdeError::invalid("path outside Jujutsu repository"))?;
    if rel.as_os_str().is_empty() || rel.components().any(|c| !matches!(c, std::path::Component::Normal(_))) {
        return Err(IdeError::invalid("invalid Jujutsu annotation path"));
    }
    let rel = rel.to_str().ok_or_else(|| IdeError::invalid("Non-UTF-8 Jujutsu annotation path"))?;
    let exe = executable(None)?;
    let template = r#""[" ++ json(commit.commit_id()) ++ "," ++ json(commit.author().name()) ++ "," ++ json(commit.author().timestamp().format("%s%3f")) ++ "," ++ json(commit.description().first_line()) ++ "]\n""#;
    let out = read_command(repo, &exe, &["file", "annotate", "-r", commit, "-T", template, "--", rel])?;
    let mut lines = Vec::new();
    for line in out.split(|&b| b == b'\n').filter(|line| !line.is_empty()) {
        let (commit, author, time, summary): (String, String, String, String) =
            serde_json::from_slice(line).map_err(|e| IdeError::invalid(format!("invalid jj annotation JSON: {e}")))?;
        lines.push(crate::BlameLine { commit, author, time_ms: time.parse().unwrap_or_default(), summary });
    }
    let fileset = format!("file:{}", serde_json::to_string(rel).unwrap());
    let base = read_command(repo, &exe, &["file", "show", "-r", commit, "-T", "", "--", &fileset])?;
    let base = String::from_utf8(base).map_err(|_| IdeError::unavailable("Non-UTF-8 Jujutsu annotation text"))?;
    for hunk in crate::diff::line_hunks(&base, text).into_iter().rev() {
        let start = (hunk.old_start as usize).min(lines.len());
        let end = (start + hunk.old_lines as usize).min(lines.len());
        lines.splice(start..end, crate::write::uncommitted_lines(hunk.lines as usize));
    }
    Ok(lines)
}

pub(crate) fn history_files(repo: &crate::Repo, commit: &str) -> IdeResult<Vec<crate::FileStatus>> {
    Ok(snapshot_at(repo, &executable(None)?, Some(commit))?.files)
}

// DiffStats.files() was added in jj 0.36. It uses the same merged-parent baseline as diff.files().
const HISTORY_LINE_STATS_TEMPLATE: &str = r#""[" ++ diff.stat().files().map(|f| json({"path" => f.path(), "added" => f.lines_added(), "removed" => f.lines_removed()})).join(",") ++ "]""#;

pub(crate) fn history_line_stats(repo: &crate::Repo, commit: &str) -> IdeResult<Vec<crate::FileLineStats>> {
    repo.require_execution_allowed()?;
    history_line_stats_with(repo, commit, &executable(None)?)
}

fn history_line_stats_with(repo: &crate::Repo, commit: &str, exe: &Path) -> IdeResult<Vec<crate::FileLineStats>> {
    if repo.kind() != crate::VcsKind::Jj || commit.len() != 40 || !commit.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(IdeError::invalid("Jujutsu history requires a full immutable commit ID"));
    }
    let bytes = read_command(repo, exe, &["log", "--no-graph", "-r", commit, "-T", HISTORY_LINE_STATS_TEMPLATE])?;
    serde_json::from_slice(&bytes)
        .map_err(|e| IdeError::invalid(format!("invalid jj history line statistics JSON: {e}")))
}

pub(crate) fn history_file_diff(repo: &crate::Repo, path: &Path, commit: &str) -> IdeResult<JjFileDiff> {
    let exe = executable(None)?;
    let copy = snapshot_at(repo, &exe, Some(commit))?;
    file_diff_snapshot(repo, path, Some(commit), &exe, copy, true)
}

pub(crate) fn file_diff(repo: &crate::Repo, path: &Path, commit: &str) -> IdeResult<JjFileDiff> {
    repo.require_execution_allowed()?;
    file_diff_with(repo, path, commit, &executable(None)?)
}

fn file_diff_with(repo: &crate::Repo, path: &Path, commit: &str, exe: &Path) -> IdeResult<JjFileDiff> {
    file_diff_read(repo, path, Some(commit), exe)
}

pub(crate) fn line_hunks(repo: &crate::Repo, path: &Path, text: &str) -> IdeResult<Vec<crate::LineHunk>> {
    repo.require_execution_allowed()?;
    if text.bytes().any(|b| b < 0x20 && !matches!(b, b'\t' | b'\n' | b'\r')) {
        return Err(IdeError::unavailable("Binary buffers are not supported in Jujutsu diffs"));
    }
    let diff = file_diff_read(repo, path, None, &executable(None)?)?;
    Ok(crate::diff_hunks(&diff.before, text))
}

fn file_diff_read(repo: &crate::Repo, path: &Path, expected: Option<&str>, exe: &Path) -> IdeResult<JjFileDiff> {
    if repo.kind() != crate::VcsKind::Jj {
        return Err(IdeError::invalid("Jujutsu diff requires a Jujutsu repository"));
    }
    let rel = path.strip_prefix(repo.root()).map_err(|_| IdeError::invalid("path outside Jujutsu repository"))?;
    if rel.as_os_str().is_empty() || rel.components().any(|c| !matches!(c, std::path::Component::Normal(_))) {
        return Err(IdeError::invalid("invalid Jujutsu repository-relative path"));
    }
    // Snapshot once, then pin every read to the accepted immutable commit. Never pair a
    // stale list's rename/kind with a newer @ (including an externally switched @).
    let copy = snapshot(repo, exe)?;
    if expected.is_some_and(|commit| copy.commit_id != commit) {
        return Err(IdeError::unavailable(
            "Working copy changed; refresh the Jujutsu changes list and reopen the diff",
        ));
    }
    file_diff_snapshot(repo, path, expected, exe, copy, false)
}

fn file_diff_snapshot(
    repo: &crate::Repo,
    path: &Path,
    expected: Option<&str>,
    exe: &Path,
    copy: JjWorkingCopy,
    historical: bool,
) -> IdeResult<JjFileDiff> {
    let rel = path.strip_prefix(repo.root()).map_err(|_| IdeError::invalid("path outside Jujutsu repository"))?;
    if rel.as_os_str().is_empty() || rel.components().any(|c| !matches!(c, std::path::Component::Normal(_))) {
        return Err(IdeError::invalid("invalid Jujutsu repository-relative path"));
    }
    let commit = &copy.commit_id;
    // An unchanged on-disk file can still have unsaved editor changes.
    let unchanged = crate::FileStatus {
        path: path.to_path_buf().into(),
        rel_path: rel.to_string_lossy().into_owned(),
        staged: None,
        unstaged: None,
        renamed_from: None,
    };
    let file = copy
        .files
        .iter()
        .find(|f| Path::new(&f.rel_path) == rel)
        .or_else(|| expected.is_none().then_some(&unchanged))
        .ok_or_else(|| IdeError::invalid("file is no longer in the Jujutsu changes list; refresh it"))?;
    if file.unstaged == Some(crate::ChangeKind::Conflicted) {
        let versions = conflict_versions_at(repo, path, commit, exe)?;
        return Ok(JjFileDiff {
            before_blame: None,
            after_blame: None,
            before: versions.base.unwrap_or_default(),
            after: versions.merged.unwrap_or_default(),
            before_label: "Conflict base (common text merged)".into(),
            after_label: format!("@ {} ({})", &commit[..8], file.rel_path),
        });
    }
    let parents: Vec<String> = serde_json::from_slice(&read_command(
        repo,
        exe,
        &["log", "-G", "-r", commit, "-T", "json(parents.map(|p| p.commit_id()))"],
    )?)
    .map_err(|e| IdeError::invalid(format!("invalid jj parents JSON: {e}")))?;
    if parents.len() != 1 {
        return Err(IdeError::unavailable(
            "Diffs against Jujutsu auto-merged parents are not supported yet; inspect the selected revision with jj diff",
        ));
    }
    let before_path = file.renamed_from.as_deref().unwrap_or(&file.rel_path);
    let read = |revision: &str, name: &str| -> IdeResult<String> {
        if name.is_empty() || Path::new(name).components().any(|c| !matches!(c, std::path::Component::Normal(_))) {
            return Err(IdeError::invalid("invalid Jujutsu diff source path"));
        }
        // Literal filesets handle glob/revset-looking names and never traverse disk
        // symlinks. Tree type checks reject symlinks, submodules and unresolved values.
        let fileset = format!("file:{}", serde_json::to_string(name).unwrap());
        let file_type: String = serde_json::from_slice(&read_command(
            repo,
            exe,
            &["file", "list", "-r", revision, "-T", "json(file_type) ++ \"\\n\"", "--", &fileset],
        )?)
        .map_err(|e| IdeError::invalid(format!("invalid jj file type JSON: {e}")))?;
        if file_type != "file" {
            return Err(IdeError::unavailable("Only regular UTF-8 text files are supported in Jujutsu diffs"));
        }
        let bytes = read_command(repo, exe, &["file", "show", "-r", revision, "-T", "", "--", &fileset])?;
        if bytes.iter().any(|b| *b < 0x20 && !matches!(b, b'\t' | b'\n' | b'\r')) {
            return Err(IdeError::unavailable("Binary files are not supported in Jujutsu diffs"));
        }
        String::from_utf8(bytes)
            .map_err(|_| IdeError::unavailable("Non-UTF-8 files are not supported in Jujutsu diffs"))
    };
    let added = file.unstaged == Some(crate::ChangeKind::Added);
    let deleted = file.unstaged == Some(crate::ChangeKind::Deleted);
    let blame = |name: &str, commit: &str| JjBlameTarget {
        root: repo.root().to_path_buf(),
        path: repo.root().join(name),
        commit: commit.to_owned(),
    };
    Ok(JjFileDiff {
        before_blame: (!added).then(|| blame(before_path, &parents[0])),
        after_blame: (!deleted).then(|| blame(&file.rel_path, commit)),
        before: if added { String::new() } else { read(&parents[0], before_path)? },
        after: if deleted { String::new() } else { read(commit, &file.rel_path)? },
        before_label: if added {
            "(does not exist)".into()
        } else {
            format!("Parent {} ({before_path})", if historical { &parents[0] } else { &parents[0][..8] })
        },
        after_label: if historical {
            format!("{} {} ({})", commit, if deleted { "(deleted)" } else { "" }, file.rel_path)
        } else if deleted {
            "@ (deleted)".into()
        } else {
            format!("@ {} ({})", &commit[..8], file.rel_path)
        },
    })
}

/// Ask jj to materialize its actual conflict as documented Git diff3 markers.
/// This reads an immutable tree; it never rewrites working files or repo config.
fn conflict_versions_at(repo: &crate::Repo, path: &Path, commit: &str, exe: &Path) -> IdeResult<crate::MergeVersions> {
    let rel = path.strip_prefix(repo.root()).map_err(|_| IdeError::invalid("path outside Jujutsu repository"))?;
    if rel.as_os_str().is_empty() || rel.components().any(|c| !matches!(c, std::path::Component::Normal(_))) {
        return Err(IdeError::invalid("invalid Jujutsu conflict path"));
    }
    let fileset = format!("file:{}", serde_json::to_string(&rel.to_string_lossy()).unwrap());
    let count: usize = serde_json::from_slice(&read_command(
        repo,
        exe,
        &["file", "list", "-r", commit, "-T", "json(conflict_side_count)", "--", &fileset],
    )?)
    .map_err(|_| IdeError::unavailable("Cannot read Jujutsu conflict sides"))?;
    if count != 2 {
        return Err(IdeError::unavailable("The merge editor supports two-sided text conflicts only"));
    }
    let bytes = read_command(
        repo,
        exe,
        &["--config", "ui.conflict-marker-style=git", "file", "show", "-r", commit, "-T", "", "--", &fileset],
    )?;
    if bytes.iter().any(|b| *b < 0x20 && !matches!(b, b'\t' | b'\n' | b'\r')) {
        return Err(IdeError::unavailable("Binary conflicts are not supported"));
    }
    let merged =
        String::from_utf8(bytes).map_err(|_| IdeError::unavailable("Non-UTF-8 conflicts are not supported"))?;
    let mut sides = [String::new(), String::new(), String::new()];
    let mut section = None;
    let mut width = 0;
    let mut blocks = 0;
    for line in merged.split_inclusive('\n') {
        let n = line.bytes().take_while(|b| *b == b'<').count();
        if section.is_none() && n >= 7 && line.as_bytes().get(n) == Some(&b' ') {
            width = n;
            section = Some(0);
            blocks += 1;
        } else if section == Some(0) && line.starts_with(&"|".repeat(width)) {
            section = Some(1);
        } else if section == Some(1) && line.trim_end() == "=".repeat(width) {
            section = Some(2);
        } else if section == Some(2) && line.starts_with(&">".repeat(width)) {
            if !line.ends_with('\n') {
                for side in &mut sides {
                    if side.ends_with('\n') {
                        side.pop();
                    }
                }
            }
            section = None;
        } else if let Some(i) = section {
            sides[i].push_str(line);
        } else {
            for side in &mut sides {
                side.push_str(line);
            }
        }
    }
    if blocks == 0 || section.is_some() {
        return Err(IdeError::unavailable("Only regular two-sided text conflicts can be opened in the merge editor"));
    }
    let [ours, base, theirs] = sides;
    Ok(crate::MergeVersions {
        base: Some(base),
        ours: Some(ours),
        theirs: Some(theirs),
        merged: Some(merged),
        sides: crate::MergeSides::default(),
    })
}

pub(crate) fn merge_versions(repo: &crate::Repo, path: &Path) -> IdeResult<crate::MergeVersions> {
    let exe = executable(None)?;
    let copy = snapshot(repo, &exe)?;
    conflict_versions_at(repo, path, &copy.commit_id, &exe)
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
    fn real_jj_partial_saves_preserve_the_remaining_logical_conflict() {
        let Some(exe) = detected_jj_executable() else { return };
        let tmp = tempfile::tempdir().unwrap();
        jj(&exe, tmp.path(), &["git", "init"]);
        let repo = crate::Repo::discover(tmp.path()).unwrap().unwrap();
        let root = repo.root();
        let path = root.join("conflict.txt");
        let text =
            |a: &str, b: &str| format!("{a}\n{}\n{b}\n", (0..20).map(|i| format!("common{i}\n")).collect::<String>());
        std::fs::write(&path, text("base1", "base2")).unwrap();
        let base = snapshot(&repo, &exe).unwrap().commit_id;
        jj(&exe, root, &["new"]);
        std::fs::write(&path, text("left1", "left2")).unwrap();
        let left = snapshot(&repo, &exe).unwrap().commit_id;
        jj(&exe, root, &["new", &base]);
        std::fs::write(&path, text("right1", "right2")).unwrap();
        let right = snapshot(&repo, &exe).unwrap().commit_id;
        jj(&exe, root, &["new", &left, &right]);
        let disk = std::fs::read_to_string(&path).unwrap();
        assert!(disk.contains("%%%%%%%"));
        assert_eq!(disk.matches("<<<<<<<").count(), 2);
        let versions = repo.merge_versions(&path, encoding_rs::UTF_8).unwrap();
        assert!(versions.ours.unwrap().contains("left1"));
        assert!(versions.theirs.unwrap().contains("right2"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), disk, "opening must not write");
        // Save the normal document with just its first conflict resolved.
        let end = disk.find("\n>>>>>>> ").unwrap();
        let after = disk[end + 1..].find('\n').unwrap() + end + 2;
        let partial = format!("left1\n{}", &disk[after..]);
        std::fs::write(&path, &partial).unwrap();
        let copy = snapshot(&repo, &exe).unwrap();
        assert_eq!(copy.files[0].unstaged, Some(crate::ChangeKind::Conflicted));
        let remaining = repo.merge_versions(&path, encoding_rs::UTF_8).unwrap();
        assert!(remaining.ours.unwrap().contains("left1"));
        assert_eq!(remaining.merged.unwrap().matches("<<<<<<<").count(), 1);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), partial);
        std::fs::write(&path, text("left1", "right2")).unwrap();
        assert!(snapshot(&repo, &exe).unwrap().files.iter().all(|f| f.unstaged != Some(crate::ChangeKind::Conflicted)));
    }

    #[test]
    fn historical_files_and_text_remain_exact_after_working_copy_rewrites() {
        let Some(exe) = detected_jj_executable() else { return };
        let tmp = tempfile::tempdir().unwrap();
        jj(&exe, tmp.path(), &["git", "init"]);
        let repo = crate::Repo::discover(tmp.path()).unwrap().unwrap();
        let root = repo.root();
        for (name, text) in [("unchanged", "same"), ("modified", "before"), ("deleted", "gone"), ("old", "rename")] {
            std::fs::write(root.join(name), text).unwrap();
        }
        jj(&exe, root, &["new"]);
        std::fs::write(root.join("modified"), "historical").unwrap();
        std::fs::remove_file(root.join("deleted")).unwrap();
        std::fs::rename(root.join("old"), root.join("renamed")).unwrap();
        std::fs::create_dir(root.join("nested")).unwrap();
        for name in ["nested/日本語", "glob*[x]", "file:foo", "-option", "tab\tand\nnewline"] {
            std::fs::write(root.join(name), "added").unwrap();
        }
        std::fs::write(root.join("binary"), b"a\0b").unwrap();
        std::fs::write(root.join("nonutf8"), [0xff]).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc/passwd", root.join("link")).unwrap();
        let accepted = snapshot(&repo, &exe).unwrap();
        jj(&exe, root, &["describe", "-m", "rewritten externally"]);
        jj(&exe, root, &["new"]);
        std::fs::write(root.join("modified"), "current disk").unwrap();
        let files = snapshot_at(&repo, &exe, Some(&accepted.commit_id)).unwrap().files;
        assert!(!files.iter().any(|f| f.rel_path == "unchanged"));
        assert!(files.iter().any(|f| f.rel_path == "nested/日本語"));
        let version = jj_version(Some(&exe)).unwrap();
        let mut parts = version.trim_start_matches("jj ").split('.');
        let supports_stats = match (parts.next(), parts.next()) {
            (Some("0"), Some(minor)) => minor.parse::<u32>().is_ok_and(|v| v >= 36),
            (Some(major), _) => major.parse::<u32>().is_ok_and(|v| v > 0),
            _ => false,
        };
        if supports_stats {
            let stats = history_line_stats_with(&repo, &accepted.commit_id, &exe).unwrap();
            let counts = |path: &str| {
                let stat = stats.iter().find(|f| f.path == path).unwrap();
                (stat.added, stat.removed)
            };
            assert_eq!(counts("modified"), (1, 1));
            assert_eq!(counts("deleted"), (0, 1));
            assert_eq!(counts("renamed"), (0, 0));
            assert_eq!(counts("tab\tand\nnewline"), (1, 0));
            assert!(history_line_stats_with(&repo, "@", &exe).is_err());
        }
        let get = |name: &str| {
            let copy = snapshot_at(&repo, &exe, Some(&accepted.commit_id))?;
            file_diff_snapshot(&repo, &root.join(name), Some(&accepted.commit_id), &exe, copy, true)
        };
        let modified = get("modified").unwrap();
        assert_eq!((modified.before.as_str(), modified.after.as_str()), ("before", "historical"));
        assert!(modified.after_label.contains(&accepted.commit_id));
        let deleted = get("deleted").unwrap();
        assert_eq!((deleted.before.as_str(), deleted.after.as_str()), ("gone", ""));
        let renamed = get("renamed").unwrap();
        assert_eq!((renamed.before.as_str(), renamed.after.as_str()), ("rename", "rename"));
        assert!(renamed.before_label.contains("old"));
        for name in ["nested/日本語", "glob*[x]", "file:foo", "-option", "tab\tand\nnewline"] {
            let pair = get(name).unwrap();
            assert_eq!((pair.before.as_str(), pair.after.as_str()), ("", "added"));
        }
        assert!(get("unchanged").is_err());
        assert!(get("../outside").is_err());
        assert!(get("binary").unwrap_err().to_string().contains("Binary"));
        assert!(get("nonutf8").unwrap_err().to_string().contains("Non-UTF-8"));
        #[cfg(unix)]
        assert!(get("link").unwrap_err().to_string().contains("regular UTF-8"));
        assert!(snapshot_at(&repo, &exe, Some("@")).is_err());
        assert!(snapshot_at(&repo, &exe, Some(&"f".repeat(40))).is_err());
        assert!(snapshot_at(&repo, &root.join("missing-jj"), Some(&accepted.commit_id)).is_err());
        assert!(snapshot_at(&repo, &exe, Some(&"0".repeat(40))).unwrap().files.is_empty());
        jj(&exe, root, &["new"]);
        let empty = snapshot(&repo, &exe).unwrap();
        assert!(snapshot_at(&repo, &exe, Some(&empty.commit_id)).unwrap().files.is_empty());
        // A merge's list uses the merged parents; inherited additions are unchanged.
        jj(&exe, root, &["new", &accepted.commit_id]);
        std::fs::write(root.join("left"), "left").unwrap();
        let left = snapshot(&repo, &exe).unwrap().commit_id;
        jj(&exe, root, &["new", &accepted.commit_id]);
        std::fs::write(root.join("right"), "right").unwrap();
        let right = snapshot(&repo, &exe).unwrap().commit_id;
        jj(&exe, root, &["new", &left, &right]);
        std::fs::write(root.join("merge-only"), "merge").unwrap();
        let merge = snapshot(&repo, &exe).unwrap();
        let list = snapshot_at(&repo, &exe, Some(&merge.commit_id)).unwrap();
        assert_eq!(list.files.iter().map(|f| f.rel_path.as_str()).collect::<Vec<_>>(), ["merge-only"]);
        if supports_stats {
            let stats = history_line_stats_with(&repo, &merge.commit_id, &exe).unwrap();
            assert_eq!(stats.len(), 1);
            assert_eq!(stats[0].path, "merge-only");
            assert_eq!((stats[0].added, stats[0].removed), (1, 0));
        }
        assert!(
            file_diff_snapshot(&repo, &root.join("merge-only"), Some(&merge.commit_id), &exe, list, true)
                .unwrap_err()
                .to_string()
                .contains("auto-merged")
        );
    }

    #[test]
    fn real_cli_file_diff_is_pinned_literal_read_only_and_explicit_about_limits() {
        let Some(exe) = detected_jj_executable() else { return };
        let tmp = tempfile::tempdir().unwrap();
        jj(&exe, tmp.path(), &["git", "init", "--colocate"]);
        let repo = crate::Repo::discover(tmp.path()).unwrap().unwrap();
        let root = repo.root();
        for (name, text) in [("modified", "before\n"), ("deleted", "gone"), ("old name", "rename contents")] {
            std::fs::write(root.join(name), text).unwrap();
        }
        jj(&exe, root, &["new"]);
        let unchanged = file_diff_read(&repo, &root.join("modified"), None, &exe).unwrap();
        assert_eq!(unchanged.before, "before\n");
        assert_eq!(crate::diff_hunks(&unchanged.before, "unsaved\n")[0].old_text, "before\n");
        std::fs::write(root.join("modified"), "after\n").unwrap();
        std::fs::remove_file(root.join("deleted")).unwrap();
        std::fs::rename(root.join("old name"), root.join("new name")).unwrap();
        for name in ["empty", "日本語 space", "glob*[x]", "file:foo", "-option", "tab\tand\nnewline"] {
            std::fs::write(root.join(name), "").unwrap();
        }
        std::fs::write(root.join("binary"), b"a\0b").unwrap();
        std::fs::write(root.join("non-utf8"), [0xff]).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc/passwd", root.join("outside-link")).unwrap();
        // Gutter reads use the same parent and rename baseline as the diff viewer.
        let gutter = |name: &str, text: &str| {
            let pair = file_diff_read(&repo, &root.join(name), None, &exe).unwrap();
            crate::diff_hunks(&pair.before, text)
        };
        assert_eq!(gutter("modified", "buffer\n")[0].old_text, "before\n");
        assert_eq!(gutter("deleted", "")[0].kind, crate::HunkKind::Deleted);
        assert_eq!(gutter("empty", "unsaved\n")[0].kind, crate::HunkKind::Added);
        assert_eq!(gutter("new name", "unsaved rename")[0].old_text, "rename contents");
        assert!(file_diff_read(&repo, &root.join("binary"), None, &exe).is_err());
        assert!(file_diff_read(&repo, &root.join("non-utf8"), None, &exe).is_err());
        let copy = snapshot(&repo, &exe).unwrap();
        let get = |name: &str| file_diff_with(&repo, &root.join(name), &copy.commit_id, &exe);
        let modified = get("modified").unwrap();
        assert_eq!((modified.before.as_str(), modified.after.as_str()), ("before\n", "after\n"));
        assert!(modified.before_label.starts_with("Parent "));
        assert!(modified.after_label.starts_with("@ "));
        let deleted = get("deleted").unwrap();
        assert_eq!((deleted.before.as_str(), deleted.after.as_str()), ("gone", ""));
        let renamed = get("new name").unwrap();
        assert_eq!((renamed.before.as_str(), renamed.after.as_str()), ("rename contents", "rename contents"));
        assert!(renamed.before_label.contains("old name"));
        let old_target = renamed.before_blame.unwrap();
        let new_target = renamed.after_blame.unwrap();
        assert_eq!(old_target.path, root.join("old name"));
        assert_eq!(new_target.path, root.join("new name"));
        let old_lines = repo.jj_annotate(&old_target.path, &old_target.commit, "rename contents").unwrap();
        let new_lines = repo.jj_annotate(&new_target.path, &new_target.commit, "rename contents").unwrap();
        assert_eq!(old_lines[0].commit, old_target.commit);
        assert!(new_lines[0].commit == old_target.commit || new_lines[0].commit == new_target.commit);
        let target = modified.before_blame.unwrap();
        let lines = repo.jj_annotate(&target.path, &target.commit, "unsaved\nbefore\r\n").unwrap();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].commit.bytes().all(|b| b == b'0'));
        assert_eq!(lines[1].commit, target.commit);
        for name in ["empty", "日本語 space", "glob*[x]", "file:foo", "-option", "tab\tand\nnewline"] {
            let pair = get(name).unwrap();
            assert_eq!((pair.before.as_str(), pair.after.as_str()), ("", ""));
            assert_eq!(pair.before_label, "(does not exist)");
        }
        assert!(get("binary").unwrap_err().to_string().contains("Binary"));
        assert!(get("non-utf8").unwrap_err().to_string().contains("Non-UTF-8"));
        #[cfg(unix)]
        assert!(get("outside-link").unwrap_err().to_string().contains("regular UTF-8"));
        assert!(get("../escape").is_err());
        assert!(file_diff_with(&repo, &root.join("modified"), &copy.commit_id, &root.join("missing-jj")).is_err());
        assert!(repo.stage(&[root.join("modified")]).is_err());
        assert!(repo.unstage(&[root.join("modified")]).is_err());
        assert_eq!(snapshot(&repo, &exe).unwrap().commit_id, copy.commit_id);
        std::fs::write(root.join("modified"), "newer").unwrap();
        assert!(get("modified").unwrap_err().to_string().contains("refresh"));
        // A non-conflicting merge still needs the auto-merged baseline, never its first parent.
        let left = snapshot(&repo, &exe).unwrap().commit_id;
        jj(&exe, root, &["new", &format!("{left}-")]);
        std::fs::write(root.join("other"), "other parent").unwrap();
        let right = snapshot(&repo, &exe).unwrap().commit_id;
        jj(&exe, root, &["new", &left, &right]);
        std::fs::write(root.join("modified"), "merge edit").unwrap();
        let merge = snapshot(&repo, &exe).unwrap();
        assert!(
            file_diff_with(&repo, &root.join("modified"), &merge.commit_id, &exe)
                .unwrap_err()
                .to_string()
                .contains("auto-merged parents")
        );
        // An inherited conflict is explicit even if it has no diff from the merged parents.
        jj(&exe, root, &["new", &format!("{left}-")]);
        std::fs::write(root.join("modified"), "conflicting right").unwrap();
        let conflict_right = snapshot(&repo, &exe).unwrap().commit_id;
        jj(&exe, root, &["new", &left, &conflict_right]);
        let conflict = snapshot(&repo, &exe).unwrap();
        let diff = file_diff_with(&repo, &root.join("modified"), &conflict.commit_id, &exe).unwrap();
        assert!(diff.after.contains("conflicting right"));
        assert!(diff.before_label.contains("Conflict base"));
        std::fs::remove_dir_all(root.join(".jj")).unwrap();
        assert!(file_diff_with(&repo, &root.join("modified"), &conflict.commit_id, &exe).is_err());
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
        let root = repo.root();
        let disk = std::fs::read_to_string(root.join("conflict.txt")).unwrap();
        let pair = file_diff_read(&repo, &root.join("conflict.txt"), Some(&conflicted.commit_id), &exe).unwrap();
        assert_eq!(pair.before, "base\n");
        assert!(pair.after.contains("left\n"));
        assert!(pair.after.contains("right\n"));
        assert_eq!(std::fs::read_to_string(root.join("conflict.txt")).unwrap(), disk);
        // Empty descendants inherit logical conflicts even with no ordinary diff.
        jj(&exe, root, &["new"]);
        let inherited = snapshot(&repo, &exe).unwrap();
        let pair = file_diff_read(&repo, &root.join("conflict.txt"), Some(&inherited.commit_id), &exe).unwrap();
        assert_eq!(pair.before, "base\n");
        assert!(pair.after.contains("|||||||"));
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
        let diff_error = repo.jj_file_diff(&root.join("file.txt"), "abc12345").unwrap_err().to_string();
        let hunk_error = repo.jj_line_hunks(&root.join("file.txt"), "text").unwrap_err().to_string();
        set_jj_executable(None);
        assert!(error.contains("Restricted Mode"), "{error}");
        assert!(diff_error.contains("Restricted Mode"), "{diff_error}");
        assert!(hunk_error.contains("Restricted Mode"), "{hunk_error}");
        assert!(!marker.exists(), "configured jj executable ran in Restricted Mode");
    }
}

/// A pinned operation and the oldest returned frontier, scoped to one workspace.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JjHistoryCursor {
    pub root: String,
    pub operation: String,
    pub seen: Vec<String>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JjHistoryCommit {
    pub id: String,
    pub change_id: String,
    pub description: String,
    pub parents: Vec<String>,
    pub local_bookmarks: Vec<String>,
    pub remote_bookmarks: Vec<String>,
    pub tags: Vec<String>,
    pub author: String,
    pub email: String,
    pub time_ms: String,
    pub working_copy: bool,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JjHistoryPage {
    pub commits: Vec<JjHistoryCommit>,
    pub next: Option<JjHistoryCursor>,
}

// Build the object explicitly: jj lists of strings serialize, mapped label lists do not.
const HISTORY_TEMPLATE: &str = r#""{\"id\":" ++ json(commit_id) ++ ",\"changeId\":" ++ json(change_id) ++ ",\"description\":" ++ json(description) ++ ",\"parents\":" ++ json(parents.map(|p| p.commit_id())) ++ ",\"localBookmarks\":" ++ json(local_bookmarks.map(|b| b.name())) ++ ",\"remoteBookmarks\":[" ++ remote_bookmarks.map(|b| json(stringify(b.name() ++ "@" ++ b.remote()))).join(",") ++ "],\"tags\":" ++ json(tags.map(|t| t.name())) ++ ",\"author\":" ++ json(author.name()) ++ ",\"email\":" ++ json(author.email()) ++ ",\"timeMs\":" ++ json(author.timestamp().format("%s%3f")) ++ ",\"workingCopy\":" ++ json(current_working_copy) ++ "}\n""#;

pub(crate) fn history(repo: &crate::Repo, cursor: Option<JjHistoryCursor>, limit: usize) -> IdeResult<JjHistoryPage> {
    repo.require_execution_allowed()?;
    history_with(repo, cursor, limit, &executable(None)?)
}

fn history_with(
    repo: &crate::Repo,
    cursor: Option<JjHistoryCursor>,
    limit: usize,
    exe: &Path,
) -> IdeResult<JjHistoryPage> {
    repo.require_execution_allowed()?;
    if repo.kind() != crate::VcsKind::Jj {
        return Err(IdeError::invalid("Jujutsu history requires a Jujutsu repository"));
    }
    let root = repo.root().to_string_lossy().into_owned();
    let hex = |s: &str, length| s.len() == length && s.bytes().all(|b| b.is_ascii_hexdigit());
    let mut cursor = if let Some(cursor) = cursor {
        if cursor.seen.len() > 1000 {
            return Err(IdeError::unavailable(
                "Jujutsu history has too many parallel heads to page safely; inspect with jj log",
            ));
        }
        if cursor.root != root || !hex(&cursor.operation, 128) || cursor.seen.iter().any(|id| !hex(id, 40)) {
            return Err(IdeError::invalid("Invalid Jujutsu history cursor; refresh history"));
        }
        cursor
    } else {
        // Snapshot disk once, then all metadata and subsequent pages read that operation.
        // Capture after snapshot; a concurrent operation simply becomes the coherent view.
        let mut cmd = Command::new(exe);
        cmd.current_dir(repo.root())
            .args(["--color=never", "--no-pager", "log", "-G", "-r", "@", "-T", r#""""#])
            .stdin(Stdio::null())
            .env("LC_ALL", "C");
        ide_core::process::prepare(&mut cmd);
        let out = cmd.output().map_err(|e| IdeError::unavailable(format!("cannot run jj history: {e}")))?;
        if !out.status.success() {
            return Err(IdeError::unavailable(format!("jj history: {}", String::from_utf8_lossy(&out.stderr).trim())));
        }
        let operation = String::from_utf8(read_command(repo, exe, &["op", "log", "-G", "--limit", "1", "-T", "id"])?)
            .map_err(|e| IdeError::invalid(format!("invalid jj operation: {e}")))?;
        if !hex(&operation, 128) {
            return Err(IdeError::invalid("invalid jj history operation ID"));
        }
        JjHistoryCursor { root, operation, seen: Vec::new() }
    };
    let limit = limit.clamp(1, 100);
    // Exclude exact immutable IDs rather than mutable change IDs or a moving @ offset.
    let revset = if cursor.seen.is_empty() {
        "all()".to_owned()
    } else {
        format!("all() ~ descendants({})", cursor.seen.join(" | "))
    };
    let bytes = read_command(
        repo,
        exe,
        &[
            "--at-operation",
            &cursor.operation,
            "log",
            "-G",
            "-r",
            &revset,
            "--limit",
            &(limit + 1).to_string(),
            "-T",
            HISTORY_TEMPLATE,
        ],
    )?;
    let mut commits = serde_json::Deserializer::from_slice(&bytes)
        .into_iter::<JjHistoryCommit>()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| IdeError::invalid(format!("invalid jj history JSON: {e}")))?;
    let more = commits.len() > limit;
    commits.truncate(limit);
    if more {
        // Compact the exclusion set to its oldest nodes. Because log is topological,
        // every visible descendant has already been returned. Linear history keeps
        // one ID, rather than growing a command argument for every loaded commit.
        cursor.seen.extend(commits.iter().map(|c| c.id.clone()));
        let frontier = format!("roots({})", cursor.seen.join(" | "));
        let bytes = read_command(
            repo,
            exe,
            &["--at-operation", &cursor.operation, "log", "-G", "-r", &frontier, "-T", "json(commit_id) ++ \"\\n\""],
        )?;
        cursor.seen = serde_json::Deserializer::from_slice(&bytes)
            .into_iter::<String>()
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| IdeError::invalid(format!("invalid jj history frontier JSON: {e}")))?;
    }
    Ok(JjHistoryPage { commits, next: more.then_some(cursor) })
}

#[cfg(test)]
mod history_tests {
    use super::*;

    fn run(exe: &Path, root: &Path, args: &[&str]) {
        let out = Command::new(exe)
            .current_dir(root)
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
    fn description_preserves_multiline_clears_and_accepts_file_snapshots_only() {
        let Some(exe) = detected_jj_executable() else { return };
        let temp = tempfile::tempdir().unwrap();
        run(&exe, temp.path(), &["git", "init"]);
        run(&exe, temp.path(), &["config", "set", "--repo", "signing.behavior", "drop"]);
        run(&exe, temp.path(), &["describe", "-m", "original"]);
        let repo = crate::Repo::discover(temp.path()).unwrap().unwrap();
        let before = snapshot(&repo, &exe).unwrap();
        let mut edit = JjDescriptionEdit {
            commit: before.commit_id.clone(),
            change: before.change_id.clone(),
            original: before.description.clone(),
            description: "subject\n\nbody with \"quotes\" and --flags\n".into(),
        };
        std::fs::write(repo.root().join("file"), "saved while typing").unwrap();
        let rewritten = snapshot(&repo, &exe).unwrap();
        assert_ne!(before.commit_id, rewritten.commit_id);
        describe_with(&repo, &edit, &exe).unwrap();
        let saved = snapshot(&repo, &exe).unwrap();
        assert_eq!(saved.change_id, before.change_id);
        assert_eq!(saved.description, edit.description);
        assert_eq!(std::fs::read_to_string(repo.root().join("file")).unwrap(), "saved while typing");
        // A stale baseline never overwrites an external description.
        assert!(describe_with(&repo, &edit, &exe).unwrap_err().to_string().contains("description changed"));
        edit.commit = saved.commit_id;
        edit.original = saved.description;
        edit.description.clear();
        describe_with(&repo, &edit, &exe).unwrap();
        let cleared = snapshot(&repo, &exe).unwrap();
        assert_eq!(cleared.description, "");
        edit.commit = cleared.commit_id;
        edit.original.clear();
        run(&exe, repo.root(), &["new", "-m", "another change"]);
        assert!(describe_with(&repo, &edit, &exe).is_err());
        assert_eq!(snapshot(&repo, &exe).unwrap().description, "another change\n");
        repo.set_execution_allowed(false);
        assert!(describe_with(&repo, &edit, &exe).unwrap_err().to_string().contains("Restricted Mode"));
    }

    #[cfg(unix)]
    #[test]
    fn description_refuses_external_switch_between_validation_and_write() {
        use std::os::unix::fs::PermissionsExt;
        let Some(exe) = detected_jj_executable() else { return };
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        std::fs::create_dir(&root).unwrap();
        run(&exe, &root, &["git", "init"]);
        run(&exe, &root, &["config", "set", "--repo", "signing.behavior", "drop"]);
        let repo = crate::Repo::discover(&root).unwrap().unwrap();
        let copy = snapshot(&repo, &exe).unwrap();
        let edit = JjDescriptionEdit {
            commit: copy.commit_id.clone(),
            change: copy.change_id,
            original: copy.description,
            description: "must not redirect".into(),
        };
        let wrapper = temp.path().join("jj-wrapper");
        std::fs::write(&wrapper, format!("#!/bin/sh\nfor arg in \"$@\"; do\nif [ \"$arg\" = describe ]; then\n'{}' new -m switched >/dev/null 2>&1 || exit 90\nfi\ndone\nexec '{}' \"$@\"\n", exe.display(), exe.display())).unwrap();
        std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(describe_with(&repo, &edit, &wrapper).is_err());
        assert_eq!(snapshot(&repo, &exe).unwrap().description, "switched\n");
        assert_eq!(snapshot_at(&repo, &exe, Some(&copy.commit_id)).unwrap().description, "");
    }

    #[test]
    fn description_rejects_divergent_same_change_version() {
        let Some(exe) = detected_jj_executable() else { return };
        let temp = tempfile::tempdir().unwrap();
        run(&exe, temp.path(), &["git", "init"]);
        run(&exe, temp.path(), &["config", "set", "--repo", "signing.behavior", "drop"]);
        run(&exe, temp.path(), &["describe", "-m", "original"]);
        let repo = crate::Repo::discover(temp.path()).unwrap().unwrap();
        let base = snapshot(&repo, &exe).unwrap();
        let operation = String::from_utf8(
            read_command(&repo, &exe, &["op", "log", "--no-graph", "--limit", "1", "-T", "id"]).unwrap(),
        )
        .unwrap();
        std::fs::write(repo.root().join("file"), "first branch").unwrap();
        let first = snapshot(&repo, &exe).unwrap();
        run(&exe, repo.root(), &["op", "restore", operation.trim()]);
        std::fs::write(repo.root().join("file"), "second branch").unwrap();
        let second = snapshot(&repo, &exe).unwrap();
        assert_eq!(first.change_id, second.change_id);
        let edit = JjDescriptionEdit {
            commit: first.commit_id,
            change: first.change_id,
            original: first.description,
            description: "must not save".into(),
        };
        assert!(describe_with(&repo, &edit, &exe).unwrap_err().to_string().contains("diverged"));
        assert_eq!(snapshot(&repo, &exe).unwrap().description, base.description);
    }

    #[test]
    fn real_history_preserves_merge_metadata_and_operation_pinned_pages() {
        let Some(exe) = detected_jj_executable() else { return };
        let temp = tempfile::tempdir().unwrap();
        run(&exe, temp.path(), &["git", "init"]);
        let repo = crate::Repo::discover(temp.path()).unwrap().unwrap();
        let root = repo.root();
        std::fs::write(root.join("common"), "base").unwrap();
        run(&exe, root, &["describe", "-m", "共通\n\nfull body with \"quotes\"\n"]);
        let base = history_with(&repo, None, 100, &exe).unwrap().commits[0].id.clone();
        run(&exe, root, &["new", &base, "-m", "left"]);
        std::fs::write(root.join("left"), "left").unwrap();
        std::fs::write(root.join("common"), "left").unwrap();
        run(&exe, root, &["bookmark", "create", "left-label"]);
        let left = history_with(&repo, None, 100, &exe).unwrap().commits[0].id.clone();
        run(&exe, root, &["new", &base, "-m", "right"]);
        std::fs::write(root.join("right"), "right").unwrap();
        std::fs::write(root.join("common"), "right").unwrap();
        let right = history_with(&repo, None, 100, &exe).unwrap().commits[0].id.clone();
        run(&exe, root, &["new", "root()", "-m", "independent head"]);
        run(&exe, root, &["bookmark", "create", "independent"]);
        run(&exe, root, &["new", &left, &right, "-m", "統合\n\nmerge body\n"]);
        run(&exe, root, &["tag", "set", "release", "-r", &left]);
        let expected = history_with(&repo, None, 100, &exe).unwrap().commits;
        let merge = expected.iter().find(|c| c.working_copy).unwrap();
        assert_eq!(merge.parents, [left.clone(), right]);
        assert!(merge.local_bookmarks.is_empty());
        assert_eq!(
            read_command(&repo, &exe, &["log", "-G", "-r", &merge.id, "-T", "json(conflict)"]).unwrap(),
            b"true"
        );
        assert_eq!(merge.description, "統合\n\nmerge body\n");
        assert!(expected.iter().any(|c| c.local_bookmarks == ["left-label"] && c.tags == ["release"]));
        assert!(expected.iter().all(|c| c.time_ms.parse::<i64>().unwrap() >= 0));
        // Export then clone a local fixture to exercise real remote bookmark labels.
        run(&exe, root, &["git", "export"]);
        let clone = tempfile::tempdir().unwrap();
        run(&exe, clone.path(), &["git", "clone", root.to_str().unwrap(), "remote"]);
        let cloned = crate::Repo::discover(&clone.path().join("remote")).unwrap().unwrap();
        assert!(
            history_with(&cloned, None, 100, &exe)
                .unwrap()
                .commits
                .iter()
                .any(|c| c.remote_bookmarks.iter().any(|b| b == "left-label@origin"))
        );

        assert!(expected.iter().any(|c| c.description == "共通\n\nfull body with \"quotes\"\n"));
        let first = history_with(&repo, None, 1, &exe).unwrap();
        let mut cursor = first.next;
        let mut seen = first.commits;
        // Mutate @ after the first page; cursor must retain the old operation and @ marker.
        run(&exe, root, &["describe", "-m", "new operation"]);
        while let Some(next) = cursor {
            let page = history_with(&repo, Some(next), 1, &exe).unwrap();
            seen.extend(page.commits);
            cursor = page.next;
        }
        assert_eq!(seen.iter().map(|c| &c.id).collect::<std::collections::HashSet<_>>().len(), expected.len());
        assert_eq!(seen.len(), expected.len());
        assert_eq!(seen.iter().filter(|c| c.working_copy).count(), 1);
        for (index, c) in seen.iter().enumerate() {
            assert!(c.parents.iter().all(|parent| seen.iter().position(|p| &p.id == parent).is_none_or(|p| p > index)));
            assert_eq!(c.description, expected.iter().find(|e| e.id == c.id).unwrap().description);
        }
        assert!(
            history_with(&repo, None, 100, &exe).unwrap().commits.iter().any(|c| c.description == "new operation\n")
        );
        let mut cursor = history_with(&repo, None, 1, &exe).unwrap().next.unwrap();
        cursor.root.push_str("/other");
        assert!(history_with(&repo, Some(cursor), 1, &exe).unwrap_err().to_string().contains("cursor"));
        assert!(history_with(&repo, None, 1, &root.join("missing-jj")).is_err());
        // Rewrite the same change independently from the same operation, creating
        // divergence after jj reconciles operations. Both commit identities survive.
        let before = history_with(&repo, None, 1, &exe).unwrap().next.unwrap().operation;
        run(&exe, root, &["describe", "-m", "variant one"]);
        run(&exe, root, &["--at-operation", &before, "describe", "-m", "variant two"]);
        let divergent = history_with(&repo, None, 100, &exe).unwrap().commits;
        let variants: Vec<_> = divergent.iter().filter(|c| c.description.starts_with("variant ")).collect();
        assert_eq!(variants.len(), 2);
        assert_eq!(variants[0].change_id, variants[1].change_id);
        assert_ne!(variants[0].id, variants[1].id);
    }

    #[cfg(unix)]
    #[test]
    fn malformed_history_is_an_error() {
        use std::os::unix::fs::PermissionsExt;
        let Some(exe) = detected_jj_executable() else { return };
        let tmp = tempfile::tempdir().unwrap();
        run(&exe, tmp.path(), &["git", "init"]);
        let repo = crate::Repo::discover(tmp.path()).unwrap().unwrap();
        let fake = tmp.path().join("fake-jj");
        std::fs::write(&fake, "#!/bin/sh\nprintf 'not-json'\n").unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let cursor = JjHistoryCursor {
            root: repo.root().to_string_lossy().into_owned(),
            operation: "a".repeat(128),
            seen: vec![],
        };
        assert!(history_with(&repo, Some(cursor), 1, &fake).unwrap_err().to_string().contains("JSON"));
    }

    #[cfg(unix)]
    #[test]
    fn restricted_history_pagination_does_not_spawn_configured_executable() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir_all(root.join(".jj")).unwrap();
        let marker = tmp.path().join("spawned");
        let exe = tmp.path().join("fake-jj");
        std::fs::write(&exe, format!("#!/bin/sh\ntouch '{}'\n", marker.display())).unwrap();
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        let repo = crate::Repo::discover(&root).unwrap().unwrap();
        repo.set_execution_allowed(false);
        set_jj_executable(Some(&exe));
        let first = repo.jj_history(None, 25).unwrap_err().to_string();
        let cursor = JjHistoryCursor {
            root: root.to_string_lossy().into_owned(),
            operation: "a".repeat(128),
            seen: vec!["b".repeat(40)],
        };
        let later = repo.jj_history(Some(cursor), 25).unwrap_err().to_string();
        let files = repo.jj_history_files(&"c".repeat(40)).unwrap_err().to_string();
        let diff = repo.jj_history_file_diff(&root.join("file.txt"), &"c".repeat(40)).unwrap_err().to_string();
        let action = repo.jj_log_action(&"c".repeat(40), &"z".repeat(32), &JjLogAction::New).unwrap_err().to_string();
        set_jj_executable(None);
        assert!(first.contains("Restricted Mode"), "{first}");
        assert!(later.contains("Restricted Mode"), "{later}");
        assert!(files.contains("Restricted Mode"), "{files}");
        assert!(diff.contains("Restricted Mode"), "{diff}");
        assert!(action.contains("Restricted Mode"), "{action}");
        assert!(!marker.exists(), "configured jj executable ran for restricted history");
    }
}

/// Log actions are separate from Git operations and accept full row identities only.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum JjLogAction {
    New,
    Edit,
    Abandon,
    Bookmark { name: String },
    MoveBookmark { name: String },
    Tag { name: String },
}

impl JjLogAction {
    pub fn changes_working_copy(&self) -> bool {
        matches!(self, Self::New | Self::Edit | Self::Abandon)
    }
}

pub(crate) fn log_action(repo: &crate::Repo, commit: &str, change: &str, action: &JjLogAction) -> IdeResult<()> {
    log_action_with(repo, commit, change, action, &executable(None)?)
}

fn log_action_with(repo: &crate::Repo, commit: &str, change: &str, action: &JjLogAction, exe: &Path) -> IdeResult<()> {
    repo.require_execution_allowed()?;
    if repo.kind() != crate::VcsKind::Jj {
        return Err(IdeError::invalid("Jujutsu actions require a Jujutsu repository"));
    }
    if commit.len() != 40
        || !commit.bytes().all(|b| b.is_ascii_hexdigit())
        || change.len() != 32
        || !change.bytes().all(|b| (b'k'..=b'z').contains(&b))
    {
        return Err(IdeError::invalid("Invalid full Jujutsu row identity; refresh history"));
    }
    // Snapshot disk first. Saving a buffer may have rewritten the displayed @;
    // never silently redirect an old row to its replacement or an abandoned commit.
    snapshot(repo, exe)?;
    let revision = format!("({commit} & {change} & all())");
    let accepted = read_command(repo, exe, &["log", "-G", "-r", &revision, "-T", "commit_id"])?;
    if accepted != commit.as_bytes() {
        return Err(IdeError::unavailable("Selected Jujutsu revision changed; refresh history and try again"));
    }
    let name = match action {
        JjLogAction::Bookmark { name } | JjLogAction::MoveBookmark { name } | JjLogAction::Tag { name } => {
            Some(name.as_str())
        }
        _ => None,
    };
    if let Some(name) = name {
        if name.is_empty() || name.starts_with('-') || name.chars().any(|c| c.is_control() || c.is_whitespace()) {
            return Err(IdeError::invalid("Invalid Jujutsu reference name"));
        }
        if matches!(action, JjLogAction::MoveBookmark { .. }) {
            let bookmark = format!("bookmarks(exact:{})", serde_json::to_string(name).unwrap());
            if read_command(repo, exe, &["log", "-G", "-r", &bookmark, "-T", "commit_id"])?.is_empty() {
                return Err(IdeError::invalid("Local bookmark does not exist; enter an existing bookmark name"));
            }
        }
        // tag set refuses movement but accepts an existing tag at the same target.
        // The create dialog must reject that case too.
        if matches!(action, JjLogAction::Tag { .. }) {
            let bytes = read_command(repo, exe, &["tag", "list", "-T", "json(name) ++ \"\\n\""])?;
            let names = serde_json::Deserializer::from_slice(&bytes).into_iter::<String>();
            for existing in names {
                if existing.map_err(|e| IdeError::invalid(format!("invalid jj tag JSON: {e}")))? == name {
                    return Err(IdeError::invalid("Tag already exists; choose a new name"));
                }
            }
        }
    }
    // Bookmark move accepts patterns; keep the entered name literal.
    let bookmark_pattern = name.map(|name| format!("exact:{name}"));
    let args: Vec<&str> = match action {
        JjLogAction::New => vec!["new", "--", &revision],
        JjLogAction::Edit => vec!["edit", "--", &revision],
        JjLogAction::Abandon => vec!["abandon", "--", &revision],
        JjLogAction::Bookmark { name } => vec!["bookmark", "create", "-r", &revision, "--", name],
        JjLogAction::MoveBookmark { .. } => {
            vec!["bookmark", "move", "--allow-backwards", "--to", &revision, "--", bookmark_pattern.as_deref().unwrap()]
        }
        JjLogAction::Tag { name } => vec!["tag", "set", "-r", &revision, "--", name],
    };
    let mut cmd = Command::new(exe);
    cmd.current_dir(repo.root())
        .args(["--color=never", "--no-pager"])
        .args(args)
        .stdin(Stdio::null())
        .env("LC_ALL", "C");
    ide_core::process::prepare(&mut cmd);
    let out = cmd.output().map_err(|e| IdeError::unavailable(format!("cannot run jj: {e}")))?;
    if !out.status.success() {
        return Err(IdeError::unavailable(format!("jj action: {}", String::from_utf8_lossy(&out.stderr).trim())));
    }
    Ok(())
}

#[cfg(test)]
mod log_action_tests {
    use super::*;

    fn fixture() -> Option<(tempfile::TempDir, crate::Repo, PathBuf)> {
        let exe = detected_jj_executable()?;
        let tmp = tempfile::tempdir().unwrap();
        cli(&exe, tmp.path(), &["git", "init"]);
        let repo = crate::Repo::discover(tmp.path()).unwrap().unwrap();
        cli(&exe, repo.root(), &["config", "set", "--repo", "signing.behavior", "drop"]);
        Some((tmp, repo, exe))
    }
    fn cli(exe: &Path, root: &Path, args: &[&str]) {
        let out = Command::new(exe)
            .current_dir(root)
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
    fn push_sends_only_selected_exact_refs_and_rejects_stale_review() {
        let Some((_tmp, repo, exe)) = fixture() else { return };
        cli(&exe, repo.root(), &["describe", "-m", "push target"]);
        cli(&exe, repo.root(), &["config", "set", "--repo", "user.name", "Test"]);
        cli(&exe, repo.root(), &["config", "set", "--repo", "user.email", "test@example.com"]);
        let remote = tempfile::tempdir().unwrap();
        let bare = remote.path().join("remote.git");
        let out = Command::new("git").args(["init", "--bare"]).arg(&bare).output().unwrap();
        assert!(out.status.success());
        cli(&exe, repo.root(), &["git", "remote", "add", "--", "-remote", bare.to_str().unwrap()]);
        for name in ["release-1", "release1", "unselected"] {
            cli(&exe, repo.root(), &["bookmark", "create", name]);
            cli(&exe, repo.root(), &["tag", "set", name]);
        }
        let refs = || {
            let out = Command::new("git")
                .arg("--git-dir")
                .arg(&bare)
                .args(["for-each-ref", "--format=%(refname)"])
                .output()
                .unwrap();
            assert!(out.status.success());
            String::from_utf8(out.stdout).unwrap()
        };
        let mut request = JjPushRequest {
            bookmarks: vec!["release-1".into()],
            tags: vec![],
            all_tags: false,
            remote: "-remote".into(),
            review: None,
        };
        let preview = push_with(&repo, &request, &exe).unwrap();
        assert!(refs().is_empty(), "preview must not push");
        request.review = Some(preview.token);
        push_with(&repo, &request, &exe).unwrap();
        assert_eq!(refs(), "refs/heads/release-1\n");
        request.bookmarks.clear();
        request.tags = vec!["release-1".into()];
        request.review = None;
        request.review = Some(push_with(&repo, &request, &exe).unwrap().token);
        push_with(&repo, &request, &exe).unwrap();
        assert_eq!(refs(), "refs/heads/release-1\nrefs/tags/release-1\n");
        request.bookmarks = vec!["release1".into()];
        request.tags = vec!["release1".into()];
        request.review = None;
        request.review = Some(push_with(&repo, &request, &exe).unwrap().token);
        push_with(&repo, &request, &exe).unwrap();
        assert_eq!(refs(), "refs/heads/release-1\nrefs/heads/release1\nrefs/tags/release-1\nrefs/tags/release1\n");
        request.bookmarks.clear();
        request.tags = vec!["unselected".into()];
        request.review = None;
        request.review = Some(push_with(&repo, &request, &exe).unwrap().token);
        cli(&exe, repo.root(), &["new", "-m", "new target"]);
        cli(&exe, repo.root(), &["bookmark", "set", "unselected"]);
        assert!(push_with(&repo, &request, &exe).unwrap_err().to_string().contains("review"));
        assert!(!refs().contains("unselected"));
        // A literal tag named all is distinct from selecting all tags.
        cli(&exe, repo.root(), &["tag", "set", "all"]);
        request.tags = vec!["all".into()];
        request.review = None;
        request.review = Some(push_with(&repo, &request, &exe).unwrap().token);
        push_with(&repo, &request, &exe).unwrap();
        assert!(refs().contains("refs/tags/all\n"));
        assert!(!refs().contains("refs/tags/unselected\n"));
        request.tags.clear();
        request.all_tags = true;
        request.review = None;
        request.review = Some(push_with(&repo, &request, &exe).unwrap().token);
        cli(&exe, repo.root(), &["tag", "set", "-r", "@-", "added-after-preview"]);
        assert!(push_with(&repo, &request, &exe).unwrap_err().to_string().contains("review"));
        assert!(!refs().contains("added-after-preview"));
        request.review = None;
        request.review = Some(push_with(&repo, &request, &exe).unwrap().token);
        push_with(&repo, &request, &exe).unwrap();
        assert!(refs().contains("refs/tags/added-after-preview\n"));
        assert!(refs().contains("refs/tags/unselected\n"));
        assert!(!refs().contains("refs/heads/unselected\n"));
        request.bookmarks = vec!["unselected".into()];
        request.review = None;
        request.review = Some(push_with(&repo, &request, &exe).unwrap().token);
        push_with(&repo, &request, &exe).unwrap();
        assert!(refs().contains("refs/heads/unselected\n"));
        request.all_tags = false;
        request.review = None;
        request.bookmarks.clear();
        request.tags.clear();
        assert!(push_with(&repo, &request, &exe).is_err());
        request.bookmarks = vec!["unselected".into()];
        request.remote = "*".into();
        assert!(push_with(&repo, &request, &exe).is_err());
        repo.set_execution_allowed(false);
        assert!(push_options_with(&repo, &exe).is_err());
        assert!(push_with(&repo, &request, &exe).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn push_passes_metacharacters_as_exact_single_arguments() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let exe = tmp.path().join("fake-jj");
        // No executable outside this fixture is invoked; a Git repo is enough for discovery.
        let root = tmp.path().join("repo");
        std::fs::create_dir(&root).unwrap();
        let git = Command::new("git").args(["init"]).arg(&root).output().unwrap();
        assert!(git.status.success());
        std::fs::create_dir(root.join(".jj")).unwrap();
        let repo = crate::Repo::discover(&root).unwrap().unwrap();
        std::fs::write(
            &exe,
            r#"#!/bin/sh
case "$*" in
  *"bookmark list"*) printf 'release[1]\n' ;;
  *"tag list"*) printf 'release[1]\n' ;;
  *"git remote list"*) printf '"-remote" /tmp/remote\n' ;;
  *"op log"*) printf 'operation-id' ;;
  *" log "*) : ;;
  *"git push"*) printf '%s\n' "$@" > args; printf 'outgoing\n' ;;
  *) exit 1 ;;
esac
"#,
        )
        .unwrap();
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        let request = JjPushRequest {
            bookmarks: vec![],
            tags: vec!["release[1]".into()],
            all_tags: false,
            remote: "-remote".into(),
            review: None,
        };
        push_with(&repo, &request, &exe).unwrap();
        let args = std::fs::read_to_string(root.join("args")).unwrap();
        assert!(args.contains("--remote\nexact:\"-remote\"\n--tag\nexact:\"release[1]\"\n--dry-run\n"), "{args}");
        assert!(!args.contains("--ignore-immutable"));
    }

    fn row(repo: &crate::Repo, exe: &Path) -> JjWorkingCopy {
        snapshot(repo, exe).unwrap()
    }
    fn act(repo: &crate::Repo, exe: &Path, row: &JjWorkingCopy, action: JjLogAction) -> IdeResult<()> {
        log_action_with(repo, &row.commit_id, &row.change_id, &action, exe)
    }

    #[test]
    fn rollback_restores_only_literal_checked_entries_and_rejects_stale_lists() {
        let Some((_tmp, repo, exe)) = fixture() else { return };
        let root = repo.root();
        for name in ["modified", "deleted", "untouched", "glob*[x]", "binary"] {
            std::fs::write(root.join(name), b"base\0bytes").unwrap();
        }
        cli(&exe, root, &["new", "-m", "changes"]);
        for name in ["modified", "untouched", "glob*[x]", "binary", "added"] {
            std::fs::write(root.join(name), b"changed\0bytes").unwrap();
        }
        std::fs::remove_file(root.join("deleted")).unwrap();
        let before = row(&repo, &exe);
        let paths: Vec<_> = ["modified", "deleted", "glob*[x]", "binary", "added"].map(|n| root.join(n)).into();
        restore_files_with(&repo, &before.commit_id, &paths, &exe).unwrap();
        for name in ["modified", "deleted", "glob*[x]", "binary"] {
            assert_eq!(std::fs::read(root.join(name)).unwrap(), b"base\0bytes");
        }
        assert!(!root.join("added").exists());
        assert_eq!(std::fs::read(root.join("untouched")).unwrap(), b"changed\0bytes");
        assert!(restore_files_with(&repo, &before.commit_id, &[root.join("untouched")], &exe).is_err());
        let current = row(&repo, &exe);
        assert!(restore_files_with(&repo, &current.commit_id, &[root.join("not-changed")], &exe).is_err());
        assert!(restore_files_with(&repo, &current.commit_id, &[], &exe).is_err());
    }

    #[test]
    fn rollback_renames_restore_endpoints_without_touching_other_changes() {
        let Some((_tmp, repo, exe)) = fixture() else { return };
        let root = repo.root();
        std::fs::write(root.join("old"), "original").unwrap();
        cli(&exe, root, &["new"]);
        std::fs::rename(root.join("old"), root.join("new")).unwrap();
        std::fs::write(root.join("unrelated"), "keep").unwrap();
        let before = row(&repo, &exe);
        // jj may report a rename or separate added/deleted entries depending on
        // copy tracking. Only a checked rename includes both endpoints.
        let renamed = before.files.iter().find(|f| f.renamed_from.is_some());
        let paths = if let Some(file) = renamed {
            vec![file.path.as_ref().to_path_buf()]
        } else {
            vec![root.join("old"), root.join("new")]
        };
        restore_files_with(&repo, &before.commit_id, &paths, &exe).unwrap();
        assert_eq!(std::fs::read_to_string(root.join("old")).unwrap(), "original");
        assert!(!root.join("new").exists());
        assert_eq!(std::fs::read_to_string(root.join("unrelated")).unwrap(), "keep");
    }

    #[cfg(unix)]
    #[test]
    fn rollback_symlink_leaf_does_not_write_link_target() {
        let Some((_tmp, repo, exe)) = fixture() else { return };
        let outside = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(outside.path(), "outside").unwrap();
        std::os::unix::fs::symlink(outside.path(), repo.root().join("link")).unwrap();
        let copy = row(&repo, &exe);
        restore_files_with(&repo, &copy.commit_id, &[repo.root().join("link")], &exe).unwrap();
        assert!(!repo.root().join("link").symlink_metadata().is_ok());
        assert_eq!(std::fs::read_to_string(outside.path()).unwrap(), "outside");
    }

    #[test]
    fn rollback_rejects_merge_baselines_and_conflicts() {
        let Some((_tmp, repo, exe)) = fixture() else { return };
        std::fs::write(repo.root().join("file"), "base").unwrap();
        cli(&exe, repo.root(), &["new"]);
        std::fs::write(repo.root().join("file"), "left").unwrap();
        let left = row(&repo, &exe);
        cli(&exe, repo.root(), &["new", "@-"]);
        std::fs::write(repo.root().join("file"), "right").unwrap();
        let right = row(&repo, &exe);
        cli(&exe, repo.root(), &["new", &left.commit_id, &right.commit_id]);
        let merge = row(&repo, &exe);
        let error =
            restore_files_with(&repo, &merge.commit_id, &[repo.root().join("file")], &exe).unwrap_err().to_string();
        assert!(error.contains("auto-merged"), "{error}");
        cli(&exe, repo.root(), &["new"]);
        let conflict = row(&repo, &exe);
        let error =
            restore_files_with(&repo, &conflict.commit_id, &[repo.root().join("file")], &exe).unwrap_err().to_string();
        assert!(error.contains("conflicts"), "{error}");
    }

    #[test]
    fn log_actions_create_edit_abandon_and_rebase_descendants() {
        let Some((_tmp, repo, exe)) = fixture() else { return };
        std::fs::write(repo.root().join("base"), "base").unwrap();
        cli(&exe, repo.root(), &["describe", "-m", "base"]);
        let base = row(&repo, &exe);
        act(&repo, &exe, &base, JjLogAction::New).unwrap();
        let child = row(&repo, &exe);
        assert_ne!(child.change_id, base.change_id);
        assert_eq!(
            read_command(&repo, &exe, &["log", "-G", "-r", "@-", "-T", "commit_id"]).unwrap(),
            base.commit_id.as_bytes()
        );
        cli(&exe, repo.root(), &["describe", "-m", "child"]);
        let child = row(&repo, &exe);
        act(&repo, &exe, &base, JjLogAction::Edit).unwrap();
        assert_eq!(row(&repo, &exe).change_id, base.change_id);
        act(&repo, &exe, &base, JjLogAction::Abandon).unwrap();
        let visible = read_command(&repo, &exe, &["log", "-G", "-r", "all()", "-T", "change_id ++ \"\\n\""]).unwrap();
        let visible = String::from_utf8(visible).unwrap();
        assert!(!visible.contains(&base.change_id));
        assert!(visible.contains(&child.change_id));
        let parents = read_command(
            &repo,
            &exe,
            &["log", "-G", "-r", &child.change_id, "-T", "parents.map(|p| p.commit_id()).join(\" \")"],
        )
        .unwrap();
        assert_eq!(parents, "0".repeat(40).as_bytes());
    }

    #[test]
    fn log_actions_create_refs_without_moving_existing_refs_or_targeting_stale_rows() {
        let Some((_tmp, repo, exe)) = fixture() else { return };
        cli(&exe, repo.root(), &["describe", "-m", "target"]);
        let target = row(&repo, &exe);
        act(&repo, &exe, &target, JjLogAction::New).unwrap();
        act(&repo, &exe, &target, JjLogAction::Bookmark { name: "topic".into() }).unwrap();
        act(&repo, &exe, &target, JjLogAction::Tag { name: "v-test".into() }).unwrap();
        let current = row(&repo, &exe);
        for action in [JjLogAction::Bookmark { name: "topic".into() }, JjLogAction::Tag { name: "v-test".into() }] {
            assert!(act(&repo, &exe, &current, action).is_err());
        }
        for reference in ["topic", "v-test"] {
            assert_eq!(
                read_command(&repo, &exe, &["log", "-G", "-r", reference, "-T", "commit_id"]).unwrap(),
                target.commit_id.as_bytes()
            );
        }
        assert!(
            act(&repo, &exe, &target, JjLogAction::Tag { name: "v-test".into() })
                .unwrap_err()
                .to_string()
                .contains("already exists")
        );
        for name in ["", "--allow-move", "bad name", "bad\nname", "bad..name"] {
            assert!(act(&repo, &exe, &current, JjLogAction::Bookmark { name: name.into() }).is_err(), "{name:?}");
        }
        cli(&exe, repo.root(), &["describe", "-m", "external rewrite"]);
        assert!(act(&repo, &exe, &current, JjLogAction::New).unwrap_err().to_string().contains("refresh history"));
        assert!(log_action_with(&repo, "@", &current.change_id, &JjLogAction::New, &exe).is_err());
        assert!(log_action_with(&repo, &target.commit_id, &current.change_id, &JjLogAction::New, &exe).is_err());
    }

    #[test]
    fn log_actions_move_only_the_named_existing_local_bookmark() {
        let Some((_tmp, repo, exe)) = fixture() else { return };
        cli(&exe, repo.root(), &["describe", "-m", "base"]);
        let base = row(&repo, &exe);
        act(&repo, &exe, &base, JjLogAction::Bookmark { name: "main".into() }).unwrap();
        act(&repo, &exe, &base, JjLogAction::Bookmark { name: "main-other".into() }).unwrap();
        act(&repo, &exe, &base, JjLogAction::Bookmark { name: "topic*".into() }).unwrap();
        act(&repo, &exe, &base, JjLogAction::Bookmark { name: "topic-other".into() }).unwrap();
        act(&repo, &exe, &base, JjLogAction::New).unwrap();
        let target = row(&repo, &exe);
        for name in ["main", "topic*"] {
            act(&repo, &exe, &target, JjLogAction::MoveBookmark { name: name.into() }).unwrap();
            assert_eq!(
                read_command(&repo, &exe, &["log", "-G", "-r", &format!("bookmarks(exact:{name})"), "-T", "commit_id"])
                    .unwrap(),
                target.commit_id.as_bytes()
            );
        }
        for name in ["main-other", "topic-other"] {
            assert_eq!(
                read_command(&repo, &exe, &["log", "-G", "-r", name, "-T", "commit_id"]).unwrap(),
                base.commit_id.as_bytes()
            );
        }
        act(&repo, &exe, &base, JjLogAction::MoveBookmark { name: "main".into() }).unwrap();
        assert_eq!(
            read_command(&repo, &exe, &["log", "-G", "-r", "main", "-T", "commit_id"]).unwrap(),
            base.commit_id.as_bytes()
        );
        for name in ["missing", "main@origin", "", "--all", "bad name"] {
            assert!(act(&repo, &exe, &target, JjLogAction::MoveBookmark { name: name.into() }).is_err(), "{name:?}");
        }
        assert!(
            read_command(&repo, &exe, &["log", "-G", "-r", "bookmarks(exact:missing)", "-T", "commit_id"])
                .unwrap()
                .is_empty()
        );
        assert!(!JjLogAction::MoveBookmark { name: "main".into() }.changes_working_copy());
        cli(&exe, repo.root(), &["describe", "-m", "rewritten"]);
        assert!(
            act(&repo, &exe, &target, JjLogAction::MoveBookmark { name: "main".into() })
                .unwrap_err()
                .to_string()
                .contains("refresh history")
        );
    }

    #[test]
    fn log_actions_keep_immutable_protection_and_allow_new_refs_on_immutable_revisions() {
        let Some((_tmp, repo, exe)) = fixture() else { return };
        cli(&exe, repo.root(), &["describe", "-m", "immutable target"]);
        let target = row(&repo, &exe);
        act(&repo, &exe, &target, JjLogAction::New).unwrap();
        cli(&exe, repo.root(), &["config", "set", "--repo", "revset-aliases.\"immutable_heads()\"", &target.commit_id]);
        for action in [JjLogAction::Edit, JjLogAction::Abandon] {
            let error = act(&repo, &exe, &target, action).unwrap_err().to_string();
            assert!(error.contains("immutable"), "{error}");
        }
        act(&repo, &exe, &target, JjLogAction::Bookmark { name: "immutable-ref".into() }).unwrap();
        act(&repo, &exe, &target, JjLogAction::Tag { name: "immutable-tag".into() }).unwrap();
        act(&repo, &exe, &target, JjLogAction::New).unwrap();
        assert_ne!(row(&repo, &exe).change_id, target.change_id);
    }
}

/// Registered workspace metadata. Older jj registrations may have no recorded root.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JjWorkspace {
    pub name: String,
    pub path: Option<PathBuf>,
    pub change_id: String,
    pub commit_id: String,
    #[serde(default)]
    pub current: bool,
}

fn workspace_command(repo: &crate::Repo, args: &[&str]) -> IdeResult<String> {
    repo.require_execution_allowed()?;
    if repo.kind() != crate::VcsKind::Jj {
        return Err(IdeError::invalid("Workspaces require a Jujutsu repository"));
    }
    let mut cmd = Command::new(executable(None)?);
    cmd.current_dir(repo.root())
        .args(["--color=never", "--no-pager"])
        .args(args)
        .stdin(Stdio::null())
        .env("LC_ALL", "C");
    ide_core::process::prepare(&mut cmd);
    let out = cmd.output().map_err(|e| IdeError::unavailable(format!("cannot run jj: {e}")))?;
    if !out.status.success() {
        return Err(IdeError::unavailable(String::from_utf8_lossy(&out.stderr).trim().to_owned()));
    }
    String::from_utf8(out.stdout).map_err(|_| IdeError::invalid("invalid jj workspace output"))
}

pub(crate) fn workspaces(repo: &crate::Repo) -> IdeResult<Vec<JjWorkspace>> {
    // root() is optional, and is only supported by jj versions which record workspace paths.
    let template = r#"json({"name" => name, "path" => root, "changeId" => target.change_id(), "commitId" => target.commit_id()}) ++ "\n""#;
    let output = workspace_command(repo, &["--ignore-working-copy", "workspace", "list", "-T", template])?;
    let root = repo.root().canonicalize().map_err(|e| IdeError::invalid(e.to_string()))?;
    output
        .lines()
        .map(|line| {
            let mut row: JjWorkspace =
                serde_json::from_str(line).map_err(|e| IdeError::invalid(format!("invalid jj workspace JSON: {e}")))?;
            row.current = row.path.as_ref().and_then(|p| p.canonicalize().ok()).is_some_and(|p| p == root);
            Ok(row)
        })
        .collect()
}

fn valid_workspace_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
        && !name.starts_with('-')
}

pub(crate) fn add_workspace(repo: &crate::Repo, name: &str, path: &Path, revision: &str) -> IdeResult<()> {
    if !valid_workspace_name(name) || revision.trim().is_empty() || revision.contains('\0') {
        return Err(IdeError::invalid("Enter a workspace name and base revision"));
    }
    if workspaces(repo)?.iter().any(|w| w.name == name) {
        return Err(IdeError::invalid("Workspace name already exists"));
    }
    if !path.is_absolute()
        || std::fs::symlink_metadata(path).is_ok()
        || path.file_name().is_none()
        || path.components().any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(IdeError::invalid("Choose a new absolute workspace folder"));
    }
    let parent = path
        .parent()
        .and_then(|p| p.canonicalize().ok())
        .ok_or_else(|| IdeError::invalid("Workspace parent folder must exist"))?;
    let target = parent.join(path.file_name().unwrap());
    let root = repo.root().canonicalize().map_err(|e| IdeError::invalid(e.to_string()))?;
    if target.starts_with(&root) || root.starts_with(&target) {
        return Err(IdeError::invalid("Workspace folder must be outside the current workspace"));
    }
    let path = target.to_str().ok_or_else(|| IdeError::invalid("Workspace path is not UTF-8"))?;
    workspace_command(repo, &["workspace", "add", "--name", name, "--revision", revision, "--", path])?;
    Ok(())
}

fn workspace_repository(root: &Path) -> IdeResult<PathBuf> {
    let marker = root.join(".jj/repo");
    let path = if marker.is_file() {
        let pointer = std::fs::read_to_string(&marker).map_err(|e| IdeError::invalid(e.to_string()))?;
        let pointer = PathBuf::from(pointer.trim());
        if pointer.is_absolute() { pointer } else { marker.parent().unwrap().join(pointer) }
    } else {
        marker
    };
    path.canonicalize().map_err(|e| IdeError::invalid(format!("Workspace repository is unavailable: {e}")))
}

/// Recovery pins registration identity, deliberately not its mutable commit.
pub(crate) fn update_workspace(repo: &crate::Repo, expected: &JjWorkspace) -> IdeResult<()> {
    if !valid_workspace_name(&expected.name) {
        return Err(IdeError::invalid("Invalid workspace name"));
    }
    let row = workspaces(repo)?
        .into_iter()
        .find(|w| w.name == expected.name)
        .ok_or_else(|| IdeError::invalid("Workspace no longer exists; refresh"))?;
    let path = row
        .path
        .as_ref()
        .filter(|p| Some(*p) == expected.path.as_ref())
        .ok_or_else(|| IdeError::invalid("Workspace path changed or unavailable; refresh"))?;
    let target = path.canonicalize().map_err(|_| IdeError::invalid("Workspace folder is unavailable; refresh"))?;
    if &target != path || workspace_repository(repo.root())? != workspace_repository(&target)? {
        return Err(IdeError::invalid("Workspace repository identity changed; refresh"));
    }
    let target_repo = crate::Repo::discover(&target)?.ok_or_else(|| IdeError::invalid("Workspace is unavailable"))?;
    if target_repo.root() != target || !workspaces(&target_repo)?.iter().any(|w| w.name == row.name && w.current) {
        return Err(IdeError::invalid("Workspace identity changed; refresh"));
    }
    let path = target.to_str().ok_or_else(|| IdeError::invalid("Workspace path is not UTF-8"))?;
    workspace_command(repo, &["-R", path, "workspace", "update-stale"])?;
    Ok(())
}

pub(crate) fn remove_workspace(repo: &crate::Repo, expected: &JjWorkspace) -> IdeResult<()> {
    if !valid_workspace_name(&expected.name) {
        return Err(IdeError::invalid("Invalid workspace name"));
    }
    let rows = workspaces(repo)?;
    let row = rows
        .iter()
        .find(|r| r.name == expected.name)
        .ok_or_else(|| IdeError::invalid("Workspace no longer exists; refresh"))?;
    if row.current || row.path.is_none() || row != expected {
        return Err(IdeError::invalid("Workspace is current, unavailable or changed; refresh"));
    }
    let path = row.path.as_ref().unwrap();
    let target = path.canonicalize().map_err(|_| IdeError::invalid("Workspace folder is unavailable; refresh"))?;
    if &target != path || target.join(".jj/repo").is_dir() {
        return Err(IdeError::invalid("Cannot remove the main workspace or a changed workspace path"));
    }
    if workspace_repository(repo.root())? != workspace_repository(&target)? {
        return Err(IdeError::invalid("Workspace repository identity changed; refresh"));
    }
    let target_repo = crate::Repo::discover(&target)?.ok_or_else(|| IdeError::invalid("Workspace is unavailable"))?;
    if target_repo.root() != target
        || !workspaces(&target_repo)?.iter().any(|w| w.name == row.name && w.current && w.commit_id == row.commit_id)
    {
        return Err(IdeError::invalid("Workspace identity changed; refresh"));
    }
    // Snapshot the target workspace before removal; removing it from another workspace
    // does not reliably retain files written since its last snapshot.
    workspace_command(&target_repo, &["status"])?;
    workspace_command(repo, &["workspace", "remove", "--", &expected.name])?;
    Ok(())
}

#[cfg(test)]
mod workspace_tests {
    use super::*;
    #[test]
    fn update_stale_recovers_pinned_workspace_and_allows_explicit_removal() {
        let Some(exe) = detected_jj_executable() else { return };
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().canonicalize().unwrap();
        let root = base.join("main");
        assert!(Command::new(&exe).args(["git", "init"]).arg(&root).output().unwrap().status.success());
        let repo = crate::Repo::discover(&root).unwrap().unwrap();
        workspace_command(&repo, &["config", "set", "--repo", "signing.behavior", "drop"]).unwrap();
        let target = base.join("secondary");
        repo.jj_add_workspace("other", &target, "@").unwrap();
        let pinned = repo.jj_workspaces().unwrap().into_iter().find(|w| w.name == "other").unwrap();
        std::fs::write(root.join("updated.txt"), "updated on disk").unwrap();
        workspace_command(&repo, &["restore", "--from", "@", "--into", "other@", "updated.txt"]).unwrap();
        let secondary = crate::Repo::discover(&target).unwrap().unwrap();
        let error = workspace_command(&secondary, &["status"]).unwrap_err().to_string();
        assert!(error.contains("stale"), "{error}");
        assert_ne!(
            pinned.commit_id,
            repo.jj_workspaces().unwrap().into_iter().find(|w| w.name == "other").unwrap().commit_id
        );
        let mut wrong = pinned.clone();
        wrong.path = Some(root.clone());
        assert!(repo.jj_update_workspace(&wrong).is_err());
        let alien = base.join("alien");
        assert!(Command::new(&exe).args(["git", "init"]).arg(&alien).output().unwrap().status.success());
        let pointer = target.join(".jj/repo");
        let original = std::fs::read(&pointer).unwrap();
        std::fs::write(&pointer, alien.join(".jj/repo").to_str().unwrap()).unwrap();
        assert!(repo.jj_update_workspace(&pinned).unwrap_err().to_string().contains("identity changed"));
        std::fs::write(&pointer, original).unwrap();
        repo.jj_update_workspace(&pinned).unwrap();
        assert_eq!(std::fs::read_to_string(target.join("updated.txt")).unwrap(), "updated on disk");
        let current = secondary.jj_workspaces().unwrap().into_iter().find(|w| w.current).unwrap();
        secondary.jj_update_workspace(&current).unwrap();
        let latest = repo.jj_workspaces().unwrap().into_iter().find(|w| w.name == "other").unwrap();
        repo.jj_remove_workspace(&latest).unwrap();
        assert!(!target.exists());
        assert!(repo.jj_update_workspace(&pinned).is_err());
    }

    #[test]
    fn remotes_use_the_jj_backend_in_non_colocated_and_linked_workspaces() {
        let Some(exe) = detected_jj_executable() else { return };
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("main with spaces");
        assert!(
            Command::new(&exe).args(["git", "init", "--no-colocate"]).arg(&root).output().unwrap().status.success()
        );
        let repo = crate::Repo::discover(&root).unwrap().unwrap();
        workspace_command(&repo, &["git", "remote", "add", "origin", "https://github.com/example/fork.git"]).unwrap();
        assert!(!root.join(".git").exists());
        let remotes = repo.remotes().unwrap();
        assert_eq!(
            remotes,
            vec![crate::Remote { name: "origin".into(), url: "https://github.com/example/fork.git".into() }]
        );
        let linked = tmp.path().join("linked");
        repo.jj_add_workspace("linked", &linked, "@").unwrap();
        let secondary = crate::Repo::discover(&linked).unwrap().unwrap();
        assert_eq!(secondary.remotes().unwrap(), remotes);
        secondary.set_execution_allowed(false);
        assert!(secondary.remotes().is_err());
    }

    #[test]
    fn workspace_lifecycle_snapshots_removal_and_discovers_secondary_root() {
        let Some(exe) = detected_jj_executable() else { return };
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().canonicalize().unwrap();
        let root = base.join("main");
        let out = Command::new(&exe).args(["git", "init"]).arg(&root).output().unwrap();
        assert!(out.status.success());
        let repo = crate::Repo::discover(&root).unwrap().unwrap();
        workspace_command(&repo, &["config", "set", "--repo", "signing.behavior", "drop"]).unwrap();
        let rows = repo.jj_workspaces().unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].current);
        assert_eq!(rows[0].path.as_ref(), Some(&root));
        assert!(repo.jj_remove_workspace(&rows[0]).is_err());
        let target = base.join("secondary with spaces");
        for name in ["", "--help", "../escape", "two words"] {
            assert!(repo.jj_add_workspace(name, &target, "@").is_err());
        }
        assert!(repo.jj_add_workspace("other", &root.join("nested"), "@").is_err());
        assert!(repo.jj_add_workspace("other", &root, "@").is_err());
        assert!(repo.jj_add_workspace("other", &target, "--help").is_err());
        assert!(!target.exists());
        #[cfg(unix)]
        {
            let link = base.join("dangling");
            std::os::unix::fs::symlink(base.join("missing"), &link).unwrap();
            assert!(repo.jj_add_workspace("other", &link, "@").is_err());
            assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        }
        repo.jj_add_workspace("other", &target, "@").unwrap();
        assert!(target.join(".jj/repo").is_file());
        let secondary = crate::Repo::discover(&target).unwrap().unwrap();
        assert_eq!(secondary.root(), target);
        assert_eq!(secondary.kind(), crate::VcsKind::Jj);
        assert!(secondary.jj_workspaces().unwrap().iter().any(|w| w.name == "other" && w.current));
        let main = secondary.jj_workspaces().unwrap().into_iter().find(|w| w.name == "default").unwrap();
        assert!(secondary.jj_remove_workspace(&main).is_err());
        assert!(root.exists());
        assert!(repo.jj_add_workspace("other", &base.join("duplicate"), "@").is_err());
        let row = repo.jj_workspaces().unwrap().into_iter().find(|w| w.name == "other").unwrap();
        let mut stale = row.clone();
        stale.commit_id = "stale".into();
        assert!(repo.jj_remove_workspace(&stale).is_err());
        std::fs::write(target.join("unsnapshotted.txt"), "keep my data").unwrap();
        repo.jj_remove_workspace(&row).unwrap();
        assert!(!target.exists());
        let saved = workspace_command(&repo, &["file", "show", "-r", &row.change_id, "unsnapshotted.txt"]);
        assert_eq!(saved.unwrap(), "keep my data");
        assert_eq!(repo.jj_workspaces().unwrap().len(), 1);
        assert!(repo.jj_remove_workspace(&row).is_err());
        repo.set_execution_allowed(false);
        assert!(repo.jj_workspaces().is_err());
    }
}

/// Explicit Jujutsu push choices. Conflicted/deleted refs are deliberately excluded.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JjPushOptions {
    pub bookmarks: Vec<String>,
    pub tags: Vec<String>,
    pub remotes: Vec<String>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JjPushRequest {
    pub bookmarks: Vec<String>,
    pub tags: Vec<String>,
    #[serde(default)]
    pub all_tags: bool,
    pub remote: String,
    /// None previews; Some executes only if the current preview still matches.
    pub review: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct JjPushPreview {
    pub summary: String,
    pub token: String,
    /// Selected-reference history, capped at 100; not the exact network object set.
    pub commits: Vec<JjHistoryCommit>,
}

pub(crate) fn push_options(repo: &crate::Repo) -> IdeResult<JjPushOptions> {
    let exe = executable(None)?;
    push_options_with(repo, &exe)
}

fn push_remote_name(line: &str) -> Option<String> {
    if line.starts_with('"') {
        serde_json::Deserializer::from_str(line).into_iter::<String>().next()?.ok()
    } else {
        line.split_whitespace().next().map(str::to_owned)
    }
}

fn push_options_with(repo: &crate::Repo, exe: &Path) -> IdeResult<JjPushOptions> {
    repo.require_execution_allowed()?;
    if repo.kind() != crate::VcsKind::Jj {
        return Err(IdeError::invalid("Push requires a Jujutsu repository"));
    }
    let names = |kind| -> IdeResult<Vec<String>> {
        let bytes =
            read_command(repo, exe, &[kind, "list", "-T", r#"if(!remote && present && !conflict, name ++ "\n")"#])?;
        Ok(String::from_utf8_lossy(&bytes).lines().map(str::to_owned).collect())
    };
    let remotes = read_command(repo, exe, &["git", "remote", "list"])?;
    Ok(JjPushOptions {
        bookmarks: names("bookmark")?,
        tags: names("tag")?,
        remotes: String::from_utf8_lossy(&remotes).lines().filter_map(push_remote_name).collect(),
    })
}

pub(crate) fn push(repo: &crate::Repo, request: &JjPushRequest) -> IdeResult<JjPushPreview> {
    let _update = request.review.as_ref().map(|_| remote::UpdateGuard::acquire(repo)).transpose()?;
    push_with(repo, request, &executable(None)?)
}

fn push_with(repo: &crate::Repo, request: &JjPushRequest, exe: &Path) -> IdeResult<JjPushPreview> {
    let options = push_options_with(repo, exe)?;
    if request.all_tags && !request.tags.is_empty() {
        return Err(IdeError::invalid("Choose all tags or explicit tag names"));
    }
    let tags = if request.all_tags { &options.tags } else { &request.tags };
    if request.bookmarks.is_empty() && tags.is_empty() {
        return Err(IdeError::invalid("Select a bookmark or tag to push"));
    }
    if request.bookmarks.iter().any(|name| !options.bookmarks.contains(name))
        || tags.iter().any(|name| !options.tags.contains(name))
        || !options.remotes.contains(&request.remote)
    {
        return Err(IdeError::invalid("Push reference or remote changed; refresh and review again"));
    }
    // Pin the operation so a concurrent ref move cannot change what was reviewed.
    let operation = read_command(repo, exe, &["op", "log", "--limit", "1", "--no-graph", "-T", "id"])?;
    let operation = String::from_utf8_lossy(&operation).trim().to_owned();
    let remote_config = read_command(repo, exe, &["git", "remote", "list"])?;
    let run = |dry_run: bool| -> IdeResult<String> {
        let mut cmd = Command::new(exe);
        cmd.current_dir(repo.root()).args([
            "--color=never",
            "--no-pager",
            "--ignore-working-copy",
            "--at-operation",
            &operation,
            "git",
            "push",
            "--remote",
            &format!("exact:{}", serde_json::to_string(&request.remote).unwrap()),
        ]);
        for name in &request.bookmarks {
            cmd.args(["--bookmark", &format!("exact:{}", serde_json::to_string(name).unwrap())]);
        }
        for name in tags {
            cmd.args(["--tag", &format!("exact:{}", serde_json::to_string(name).unwrap())]);
        }
        if dry_run {
            cmd.arg("--dry-run");
        }
        cmd.stdin(Stdio::null()).env("LC_ALL", "C");
        ide_core::process::prepare(&mut cmd);
        let out = cmd.output().map_err(|e| IdeError::unavailable(format!("cannot run jj: {e}")))?;
        let output = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        if !out.status.success() {
            return Err(IdeError::unavailable(format!("jj push: {}", output.trim())));
        }
        Ok(output)
    };
    let output = run(true)?;
    let review = format!(
        "Operation: {operation}\nRemotes:\n{}\nBookmarks: {:?}\nTags: {:?}\nAll tags: {}\nRemote: {}\n{output}",
        String::from_utf8_lossy(&remote_config),
        request.bookmarks,
        tags,
        request.all_tags,
        request.remote
    );
    if let Some(expected) = &request.review {
        if expected != &review {
            return Err(IdeError::invalid("Push changed; review the outgoing references again"));
        }
        Ok(JjPushPreview { summary: run(false)?, token: review, commits: vec![] })
    } else {
        let config = String::from_utf8_lossy(&remote_config);
        let destination = config
            .lines()
            .find(|line| push_remote_name(line).as_deref() == Some(&request.remote))
            .unwrap_or(&request.remote);
        let revisions = request
            .bookmarks
            .iter()
            .map(|name| format!("bookmarks(exact:{})", serde_json::to_string(name).unwrap()))
            .chain(tags.iter().map(|name| format!("tags(exact:{})", serde_json::to_string(name).unwrap())))
            .collect::<Vec<_>>()
            .join(" | ");
        let remote_pattern = serde_json::to_string(&request.remote).unwrap();
        let revset = format!(
            "::({revisions}) ~ ::(remote_bookmarks(remote=exact:{remote_pattern}) | remote_tags(remote=exact:{remote_pattern})) ~ root()"
        );
        let history = read_command(
            repo,
            exe,
            &[
                "--at-operation",
                &operation,
                "log",
                "--no-graph",
                "-r",
                &revset,
                "--limit",
                "100",
                "-T",
                HISTORY_TEMPLATE,
            ],
        )?;
        let commits = String::from_utf8_lossy(&history)
            .lines()
            .map(|line| {
                serde_json::from_str(line).map_err(|e| IdeError::invalid(format!("invalid jj push history: {e}")))
            })
            .collect::<IdeResult<Vec<JjHistoryCommit>>>()?;
        Ok(JjPushPreview { summary: format!("{destination}\n\n{output}"), token: review, commits })
    }
}
