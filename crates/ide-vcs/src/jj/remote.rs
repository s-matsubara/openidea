use super::{executable, push_remote_name, read_command, workspace_repository};
use crate::{Repo, VcsKind};
use ide_core::{IdeError, IdeResult};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct JjRemoteBookmark {
    pub name: String,
    pub remote: String,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct JjPullOptions {
    pub remotes: Vec<String>,
    pub bookmarks: Vec<JjRemoteBookmark>,
    pub preferred: Option<JjRemoteBookmark>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct JjRemoteTag {
    pub name: String,
    pub remote: String,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct JjFetchOptions {
    pub remotes: Vec<String>,
    pub tags: Vec<JjRemoteTag>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum JjRebaseRevisionKind {
    Revision,
    Bookmark,
    Tag,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JjRebaseRevision {
    pub commit_id: String,
    pub label: String,
    pub kind: JjRebaseRevisionKind,
    pub remote: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JjRebaseOptions {
    pub source: JjRebaseRevision,
    pub destinations: Vec<JjRebaseRevision>,
    pub preferred: Option<String>,
    pub trunk_label: Option<String>,
}

#[derive(serde::Deserialize)]
struct RefTarget {
    name: String,
    remote: Option<String>,
    commit: String,
}

fn refs(repo: &Repo, exe: &Path, kind: &str) -> IdeResult<Vec<RefTarget>> {
    let template = r#"if(present && !conflict, json({"name" => name, "remote" => remote, "commit" => normal_target.commit_id()}) ++ "\n")"#;
    let output = read_command(repo, exe, &[kind, "list", "--all-remotes", "-T", template])?;
    String::from_utf8_lossy(&output)
        .lines()
        .map(|line| serde_json::from_str(line).map_err(|e| IdeError::invalid(format!("Invalid jj {kind} JSON: {e}"))))
        .collect()
}

pub(crate) fn fetch_options(repo: &Repo) -> IdeResult<JjFetchOptions> {
    require_root(repo)?;
    let exe = executable(None)?;
    let remotes = remotes(repo, &exe)?;
    let tags = refs(repo, &exe, "tag")?
        .into_iter()
        .filter_map(|tag| {
            let remote = tag.remote?;
            remotes.contains(&remote).then_some(JjRemoteTag { name: tag.name, remote })
        })
        .collect();
    Ok(JjFetchOptions { remotes, tags })
}

pub(crate) fn fetch_selected(repo: &Repo, remote: &str, tag: Option<&str>) -> IdeResult<String> {
    let _update = UpdateGuard::acquire(repo)?;
    fetch_selected_with(repo, &executable(None)?, remote, tag)
}

fn fetch_selected_with(repo: &Repo, exe: &Path, remote: &str, tag: Option<&str>) -> IdeResult<String> {
    if !remotes(repo, exe)?.iter().any(|name| name == remote) {
        return Err(IdeError::invalid("The selected Jujutsu remote no longer exists"));
    }
    let remote = exact(remote);
    let tag = tag.map(|name| if name == "*" { name.to_owned() } else { exact(name) });
    let mut args = vec!["git", "fetch", "--remote", &remote];
    if let Some(tag) = tag.as_deref() {
        args.extend(["--tag", tag]);
    }
    run(repo, exe, &args).map_err(|error| IdeError::new(error.kind, format!("Jujutsu Fetch failed: {}", error.message)))
}

fn revision(repo: &Repo, exe: &Path, revset: &str) -> IdeResult<JjRebaseRevision> {
    let template = r#""{\"commitId\":" ++ json(commit_id) ++ ",\"label\":" ++ json(stringify(change_id.shortest() ++ " " ++ description.first_line())) ++ ",\"kind\":\"revision\",\"remote\":null}""#;
    let revset = format!("exactly({revset}, 1)");
    let output = read_command(repo, exe, &["log", "--no-graph", "-r", &revset, "-T", template])?;
    serde_json::from_slice(&output).map_err(|e| IdeError::invalid(format!("Invalid jj revision JSON: {e}")))
}

pub(crate) fn rebase_options(repo: &Repo) -> IdeResult<JjRebaseOptions> {
    require_root(repo)?;
    rebase_options_with(repo, &executable(None)?)
}

fn rebase_options_with(repo: &Repo, exe: &Path) -> IdeResult<JjRebaseOptions> {
    let remotes = remotes(repo, exe)?;
    let source = revision(repo, exe, "@")?;
    let trunk = revision(repo, exe, "trunk()").ok();
    let preferred = trunk.as_ref().map(|row| row.commit_id.clone());
    let mut destinations = Vec::new();
    for (command, kind) in [("bookmark", JjRebaseRevisionKind::Bookmark), ("tag", JjRebaseRevisionKind::Tag)] {
        destinations.extend(
            refs(repo, exe, command)?
                .into_iter()
                .filter(|row| row.remote.as_ref().is_none_or(|remote| remotes.contains(remote)))
                .map(|row| JjRebaseRevision {
                    commit_id: row.commit,
                    label: match &row.remote {
                        Some(remote) => format!("{}@{remote}", row.name),
                        None => row.name,
                    },
                    kind: kind.clone(),
                    remote: row.remote,
                }),
        );
    }
    let trunk_label = trunk.as_ref().map(|trunk| {
        let unique_bookmark = |remote: bool| {
            let mut matching = destinations.iter().filter(|row| {
                matches!(row.kind, JjRebaseRevisionKind::Bookmark)
                    && row.commit_id == trunk.commit_id
                    && row.remote.is_some() == remote
            });
            let row = matching.next()?;
            matching.next().is_none().then_some(row.label.clone())
        };
        unique_bookmark(true).or_else(|| unique_bookmark(false)).unwrap_or_else(|| trunk.label.clone())
    });
    if let Some(trunk) = trunk {
        if !destinations.iter().any(|row| row.commit_id == trunk.commit_id) {
            destinations.push(trunk);
        }
    }
    Ok(JjRebaseOptions { source, destinations, preferred, trunk_label })
}

pub(crate) fn rebase(
    repo: &Repo,
    source: Option<&str>,
    destination: &str,
    skip_emptied: bool,
    ignore_immutable: bool,
) -> IdeResult<String> {
    let _update = UpdateGuard::acquire(repo)?;
    rebase_with(repo, &executable(None)?, source, destination, skip_emptied, ignore_immutable)
}

fn rebase_with(
    repo: &Repo,
    exe: &Path,
    source: Option<&str>,
    destination: &str,
    skip_emptied: bool,
    ignore_immutable: bool,
) -> IdeResult<String> {
    let valid = |id: &str| matches!(id.len(), 40 | 64) && id.bytes().all(|byte| byte.is_ascii_hexdigit());
    if !valid(destination) || source.is_some_and(|id| !valid(id)) {
        return Err(IdeError::invalid("Rebase requires full Jujutsu commit IDs"));
    }
    let selected = source.map(|id| format!("exactly({id} & visible(), 1)"));
    let destination = format!("exactly({destination} & visible(), 1)");
    let mut args = vec!["rebase", "-d", &destination];
    match &selected {
        Some(source) => args.extend(["-s", source]),
        None => args.extend(["-b", "@"]),
    }
    if skip_emptied {
        args.push("--skip-emptied");
    }
    if ignore_immutable {
        args.push("--ignore-immutable");
    }
    run(repo, exe, &args)
}

#[derive(serde::Deserialize)]
struct BookmarkTarget {
    name: String,
    remote: String,
    commit: String,
}

impl BookmarkTarget {
    fn bookmark(&self) -> JjRemoteBookmark {
        JjRemoteBookmark { name: self.name.clone(), remote: self.remote.clone() }
    }
}

fn require_root(repo: &Repo) -> IdeResult<()> {
    repo.require_execution_allowed()?;
    if repo.kind() != VcsKind::Jj || crate::repo::jj_root(repo.root()).as_deref() != Some(repo.root()) {
        return Err(IdeError::invalid("Update requires the exact root of a Jujutsu repository"));
    }
    Ok(())
}

fn remotes(repo: &Repo, exe: &Path) -> IdeResult<Vec<String>> {
    let output = read_command(repo, exe, &["git", "remote", "list"])?;
    Ok(String::from_utf8_lossy(&output).lines().filter_map(push_remote_name).collect())
}

fn bookmarks(repo: &Repo, exe: &Path) -> IdeResult<Vec<BookmarkTarget>> {
    let template = r#"if(remote && present && !conflict, json({"name" => name, "remote" => remote, "commit" => normal_target.commit_id()}) ++ "\n")"#;
    let output = read_command(repo, exe, &["bookmark", "list", "--all-remotes", "-T", template])?;
    String::from_utf8_lossy(&output)
        .lines()
        .map(|line| serde_json::from_str(line).map_err(|e| IdeError::invalid(format!("Invalid jj bookmark JSON: {e}"))))
        .collect()
}

pub(crate) fn pull_options(repo: &Repo) -> IdeResult<JjPullOptions> {
    require_root(repo)?;
    let exe = executable(None)?;
    let remotes = remotes(repo, &exe)?;
    let mut targets = bookmarks(repo, &exe)?;
    targets.retain(|target| remotes.contains(&target.remote));
    let trunk = commits(repo, &exe, "trunk()").ok().filter(|ids| ids.len() == 1);
    let preferred = trunk.and_then(|ids| {
        let mut matches = targets.iter().filter(|target| target.commit == ids[0]);
        let candidate = matches.next()?.bookmark();
        matches.next().is_none().then_some(candidate)
    });
    Ok(JjPullOptions { remotes, bookmarks: targets.iter().map(BookmarkTarget::bookmark).collect(), preferred })
}

static UPDATING: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

pub(super) struct UpdateGuard(PathBuf);

impl UpdateGuard {
    pub(super) fn acquire(repo: &Repo) -> IdeResult<Self> {
        require_root(repo)?;
        let root = workspace_repository(repo.root())?;
        let mut active = UPDATING.lock().unwrap_or_else(|e| e.into_inner());
        if active.contains(&root) {
            return Err(IdeError::invalid("A Jujutsu update is already running in this repository"));
        }
        active.push(root.clone());
        Ok(Self(root))
    }
}

impl Drop for UpdateGuard {
    fn drop(&mut self) {
        UPDATING.lock().unwrap_or_else(|e| e.into_inner()).retain(|root| root != &self.0);
    }
}

fn run(repo: &Repo, exe: &Path, args: &[&str]) -> IdeResult<String> {
    require_root(repo)?;
    let mut cmd = Command::new(exe);
    cmd.current_dir(repo.root())
        .args(["--color=never", "--no-pager"])
        .args(args)
        .stdin(Stdio::null())
        .env("LC_ALL", "C");
    ide_core::process::prepare(&mut cmd);
    let output = cmd.output().map_err(|e| IdeError::unavailable(format!("Cannot run jj: {e}")))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        return Err(IdeError::unavailable(format!("{stdout}{stderr}").trim()));
    }
    Ok(format!("{stdout}{stderr}"))
}

pub(crate) fn fetch(repo: &Repo) -> IdeResult<String> {
    let _update = UpdateGuard::acquire(repo)?;
    run(repo, &executable(None)?, &["git", "fetch", "--all-remotes"])
        .map_err(|error| IdeError::new(error.kind, format!("Jujutsu Fetch failed: {}", error.message)))
}

#[derive(serde::Deserialize)]
struct Operation {
    id: String,
    parents: Vec<String>,
    description: String,
}

fn operation(repo: &Repo, exe: &Path) -> IdeResult<Operation> {
    let template = r#"json({"id" => id, "parents" => parents.map(|p| p.id()), "description" => description})"#;
    let output = read_command(repo, exe, &["op", "log", "--limit", "1", "--no-graph", "-T", template])?;
    serde_json::from_slice(&output).map_err(|e| IdeError::invalid(format!("Invalid jj operation JSON: {e}")))
}

fn commits(repo: &Repo, exe: &Path, revset: &str) -> IdeResult<Vec<String>> {
    let output = read_command(repo, exe, &["log", "--no-graph", "-r", revset, "-T", r#"commit_id ++ "\n""#])?;
    Ok(String::from_utf8_lossy(&output).lines().map(str::to_owned).collect())
}

fn exact(name: &str) -> String {
    format!("exact:{}", serde_json::to_string(name).expect("strings serialize to JSON"))
}

fn selected_bookmark(repo: &Repo, exe: &Path, remote: &str, name: &str) -> IdeResult<String> {
    bookmarks(repo, exe)?
        .into_iter()
        .find(|target| target.remote == remote && target.name == name)
        .map(|target| target.commit)
        .ok_or_else(|| IdeError::invalid("The selected remote bookmark is missing or conflicted"))
}

pub(crate) fn pull(repo: &Repo, remote: &str, bookmark: &str) -> IdeResult<String> {
    let _update = UpdateGuard::acquire(repo)?;
    pull_with(repo, &executable(None)?, remote, bookmark)
}

fn pull_with(repo: &Repo, exe: &Path, remote: &str, bookmark: &str) -> IdeResult<String> {
    let remote_config = read_command(repo, exe, &["git", "remote", "list"])?;
    if !String::from_utf8_lossy(&remote_config).lines().filter_map(push_remote_name).any(|name| name == remote) {
        return Err(IdeError::invalid("The selected Jujutsu remote no longer exists"));
    }
    let destination = format!("remote_bookmarks({}, remote={})", exact(bookmark), exact(remote));
    // Snapshot before fetching so a later snapshot cannot be mistaken for the fetch operation.
    run(repo, exe, &["log", "-r", "@", "--no-graph", "-T", r#""""#])?;
    let before = operation(repo, exe)?;
    let source = commits(repo, exe, "@")?;
    let target_id = selected_bookmark(repo, exe, remote, bookmark)?;
    let [source_id] = source.as_slice() else {
        return Err(IdeError::invalid("The Jujutsu working copy changed"));
    };
    let affected = format!("(({target_id}..{source_id}):: | {target_id}) & conflicts()");
    if !commits(repo, exe, &affected)?.is_empty() {
        return Err(IdeError::invalid("Resolve existing Jujutsu conflicts before pulling"));
    }
    if operation(repo, exe)?.id != before.id {
        return Err(IdeError::invalid("The Jujutsu repository changed before fetching"));
    }

    let fetched = run(repo, exe, &["git", "fetch", "--remote", &exact(remote)])
        .map_err(|error| IdeError::new(error.kind, format!("Jujutsu Fetch failed: {}", error.message)))?;
    let rebase = || -> IdeResult<String> {
        let after = operation(repo, exe)?;
        // A no-op fetch may create no operation. Otherwise only accept the direct fetch child.
        if after.id != before.id
            && (after.parents != [before.id] || after.description != format!("fetch from git remote(s) {remote}"))
        {
            return Err(IdeError::invalid("The Jujutsu repository changed during fetching"));
        }
        if commits(repo, exe, "@")? != source {
            return Err(IdeError::invalid("The Jujutsu working copy changed during fetching"));
        }
        if read_command(repo, exe, &["git", "remote", "list"])? != remote_config {
            return Err(IdeError::invalid("The Jujutsu remote configuration changed during fetching"));
        }
        let new_target = selected_bookmark(repo, exe, remote, bookmark)?;
        if commits(repo, exe, &format!("{target_id} & ::{new_target}"))?.is_empty() {
            return Err(IdeError::invalid("The selected remote bookmark moved outside its previous history"));
        }
        let affected = format!("(({new_target}..{source_id}):: | {new_target}) & conflicts()");
        if !commits(repo, exe, &affected)?.is_empty() {
            return Err(IdeError::invalid("Jujutsu conflicts appeared after fetching"));
        }
        if operation(repo, exe)?.id != after.id {
            return Err(IdeError::invalid("The Jujutsu repository changed after fetching"));
        }
        // Intersect with the verified revisions so a later command cannot select another target.
        run(
            repo,
            exe,
            &[
                "rebase",
                "-b",
                &format!("exactly(@ & {source_id}, 1)"),
                "-d",
                &format!("exactly({destination} & {new_target}, 1)"),
            ],
        )
    };
    match rebase() {
        Ok(rebased) => Ok(format!("{fetched}{rebased}")),
        Err(error) => Err(IdeError::new(
            error.kind,
            format!("Jujutsu Fetch completed, but rebase did not complete: {}", error.message),
        )),
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn pull_rebases_onto_the_fetched_target_and_stops_when_it_disappears() {
        let Some(real_exe) = crate::detected_jj_executable() else { return };
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let exe = root.join("jj");
        let config = root.join("jj.toml");
        std::fs::write(&config, "[user]\nname = 'Test'\nemail = 'test@example.com'\n[signing]\nbehavior = 'drop'\n")
            .unwrap();
        // Use an isolated user configuration without aliases or local immutable-head overrides.
        use std::os::unix::fs::PermissionsExt;
        std::fs::write(&exe, "#!/bin/sh\nexport JJ_CONFIG=\"$0.toml\"\nexec \"$0.real\" \"$@\"\n").unwrap();
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::os::unix::fs::symlink(real_exe, root.join("jj.real")).unwrap();
        let cli = |dir: &Path, args: &[&str]| {
            let output = Command::new(&exe).current_dir(dir).args(args).output().unwrap();
            assert!(output.status.success(), "{args:?}: {}", String::from_utf8_lossy(&output.stderr));
        };
        cli(&root, &["git", "init", "--colocate", "upstream"]);
        let remote = root.join("upstream");
        cli(&remote, &["describe", "-m", "initial"]);
        cli(&remote, &["bookmark", "create", "main"]);
        cli(&root, &["git", "clone", "upstream", "local"]);
        let repo = Repo::discover(&root.join("local")).unwrap().unwrap();
        repo.set_execution_allowed(true);
        std::fs::write(repo.root().join("local.txt"), "local").unwrap();

        cli(&remote, &["new", "main", "-m", "update"]);
        std::fs::write(remote.join("remote.txt"), "remote").unwrap();
        cli(&remote, &["bookmark", "set", "main", "-r", "@"]);
        let options = bookmarks(&repo, &exe).unwrap();
        assert!(options.iter().any(|row| row.name == "main" && row.remote == "origin"));
        pull_with(&repo, &exe, "origin", "main").unwrap();
        assert_eq!(commits(&repo, &exe, "@-").unwrap(), commits(&repo, &exe, "main@origin").unwrap());
        assert_eq!(std::fs::read_to_string(repo.root().join("local.txt")).unwrap(), "local");
        assert_eq!(std::fs::read_to_string(repo.root().join("remote.txt")).unwrap(), "remote");

        // A no-op fetch can leave the operation unchanged and is still safe to pull.
        pull_with(&repo, &exe, "origin", "main").unwrap();

        // Fetch is kept when rebase fails on a protected commit in the local series.
        cli(repo.root(), &["new", "-m", "working"]);
        let immutable = "revset-aliases.'immutable_heads()'";
        cli(repo.root(), &["config", "set", "--repo", immutable, "@- | trunk()"]);
        let source = commits(&repo, &exe, "@").unwrap();
        let old_target = commits(&repo, &exe, "main@origin").unwrap();
        cli(&remote, &["new", "main", "-m", "next update"]);
        cli(&remote, &["bookmark", "set", "main", "-r", "@"]);
        let error = pull_with(&repo, &exe, "origin", "main").unwrap_err();
        assert!(error.message.contains("Fetch completed, but rebase did not complete"), "{}", error.message);
        assert!(error.message.contains("immutable"), "{}", error.message);
        assert_eq!(commits(&repo, &exe, "@").unwrap(), source);
        assert_ne!(commits(&repo, &exe, "main@origin").unwrap(), old_target);
        cli(repo.root(), &["config", "unset", "--repo", immutable]);

        // Selected Fetch imports the requested tag only, then standalone Rebase
        // can move the current series to the tag's exact revision.
        cli(&remote, &["new", "main", "-m", "tag destination"]);
        cli(&remote, &["tag", "set", "release-1", "release-2"]);
        let target_before = commits(&repo, &exe, "main@origin").unwrap();
        fetch_selected_with(&repo, &exe, "origin", Some("release-1")).unwrap();
        let tags = refs(&repo, &exe, "tag").unwrap();
        let target =
            tags.iter().find(|tag| tag.name == "release-1" && tag.remote.as_deref() == Some("origin")).unwrap();
        assert!(tags.iter().all(|tag| tag.name != "release-2"));
        fetch_selected_with(&repo, &exe, "origin", Some("*")).unwrap();
        assert!(refs(&repo, &exe, "tag").unwrap().iter().any(|tag| tag.name == "release-2"));
        assert_eq!(commits(&repo, &exe, "main@origin").unwrap(), target_before);
        assert!(rebase_with(&repo, &exe, None, "@", false, false).is_err());
        let options = rebase_options_with(&repo, &exe).unwrap();
        assert_eq!(options.source.commit_id, commits(&repo, &exe, "@").unwrap()[0]);
        assert_eq!(options.preferred.as_ref(), target_before.first());
        assert_eq!(options.trunk_label.as_deref(), Some("main@origin"));
        assert!(options.destinations.iter().any(|row| row.label == "release-1@origin"));
        assert!(options.destinations.iter().all(|row| row.remote.as_deref() != Some("git")));
        let local_parent = commits(&repo, &exe, "@-").unwrap().remove(0);
        rebase_with(&repo, &exe, Some(&local_parent), &target.commit, false, false).unwrap();
        assert_eq!(commits(&repo, &exe, "@--").unwrap(), [target.commit.clone()]);

        // An unavailable remote reports a fetch failure and leaves the current series intact.
        let source = commits(&repo, &exe, "@").unwrap();
        cli(repo.root(), &["git", "remote", "set-url", "origin", "../unavailable"]);
        let error = pull_with(&repo, &exe, "origin", "main").unwrap_err();
        assert!(error.message.contains("Fetch failed"), "{}", error.message);
        assert_eq!(commits(&repo, &exe, "@").unwrap(), source);

        cli(repo.root(), &["git", "remote", "set-url", "origin", remote.to_str().unwrap()]);
        cli(&remote, &["bookmark", "delete", "main"]);
        let error = pull_with(&repo, &exe, "origin", "main").unwrap_err();
        assert!(error.message.contains("Fetch completed, but rebase did not complete"), "{}", error.message);
        assert!(operation(&repo, &exe).unwrap().description.starts_with("fetch from git remote(s)"));
        assert_eq!(std::fs::read_to_string(repo.root().join("local.txt")).unwrap(), "local");
        assert!(bookmarks(&repo, &exe).unwrap().iter().all(|row| row.name != "main"));
    }

    #[test]
    fn updating_the_same_root_twice_is_rejected() {
        let Some(exe) = crate::detected_jj_executable() else { return };
        let temp = tempfile::tempdir().unwrap();
        assert!(Command::new(exe).current_dir(temp.path()).args(["git", "init"]).output().unwrap().status.success());
        let repo = Repo::discover(temp.path()).unwrap().unwrap();
        repo.set_execution_allowed(true);
        let guard = UpdateGuard::acquire(&repo).unwrap();
        assert!(UpdateGuard::acquire(&repo).is_err());
        drop(guard);
        assert!(UpdateGuard::acquire(&repo).is_ok());
    }
}
