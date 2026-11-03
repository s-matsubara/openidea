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
        let guard = UpdateGuard::acquire(&repo).unwrap();
        assert!(UpdateGuard::acquire(&repo).is_err());
        drop(guard);
        assert!(UpdateGuard::acquire(&repo).is_ok());
    }
}
