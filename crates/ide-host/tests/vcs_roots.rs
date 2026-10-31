//! Repository-scoped patch operations must never fall back to the primary root.
use ide_core::{ChangeSet, NullSink, TextChange};
use ide_host::{Host, HostConfig, ops::vcs};
use std::{path::Path, process::Command, sync::Arc, time::Duration};

fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git").current_dir(root).args(args).output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn patches_read_and_write_the_requested_repository() {
    let temp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(temp.path()).unwrap();
    let project_root = base.join("project");
    let roots = [project_root.join("front"), project_root.join("back")];
    let mut revisions = Vec::new();
    for (i, root) in roots.iter().enumerate() {
        std::fs::create_dir_all(root).unwrap();
        git(root, &["init", "-b", "main"]);
        git(root, &["config", "user.name", "Test"]);
        git(root, &["config", "user.email", "test@example.com"]);
        std::fs::write(root.join("same.txt"), format!("root {i}\n")).unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-m", "initial"]);
        std::fs::write(root.join("same.txt"), format!("changed {i}\n")).unwrap();
        git(root, &["commit", "-am", "change"]);
        revisions.push(git(root, &["rev-parse", "HEAD"]));
    }
    let host = Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    });
    host.trust.decide(&project_root, true, false).unwrap();
    let project = host.open_project("main", &project_root).unwrap();
    for _ in 0..500 {
        if project.repos().all().len() == 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(project.repos().all().len(), 2);
    for (i, root) in roots.iter().enumerate() {
        let patch = vcs::vcs_create_patch(
            &host,
            "main",
            Some(root.clone()),
            vcs::PatchSource::Commits { commits: vec![revisions[i].clone()], reverse: true },
        )
        .await
        .unwrap();
        assert!(patch.contains(&format!("-changed {i}")));
        assert_eq!(vcs::vcs_patch_preview(&host, "main", Some(root.clone()), patch.clone()).await.unwrap().len(), 1);
        vcs::vcs_apply_patch(&host, "main", Some(root.clone()), patch).await.unwrap();
        assert_eq!(std::fs::read_to_string(root.join("same.txt")).unwrap(), format!("root {i}\n"));
    }
    assert!(vcs::vcs_apply_patch(&host, "main", Some(base.join("outside")), String::new()).await.is_err());
    host.close_project("main");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn jj_roots_reject_git_operations_before_mutation() {
    let temp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(temp.path()).unwrap();
    let root = base.join("project");
    std::fs::create_dir_all(&root).unwrap();
    git(&root, &["init", "-b", "main"]);
    std::fs::create_dir(root.join(".jj")).unwrap();
    let file = root.join("keep.txt");
    std::fs::write(&file, "keep\n").unwrap();
    let host = Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    });
    let project = host.open_project("main", &root).unwrap();
    let roots = vcs::vcs_roots(&host, "main").unwrap();
    assert_eq!(roots.len(), 1);
    assert_eq!(roots[0].kind, ide_vcs::VcsKind::Jj);
    assert!(roots[0].unavailable_reason.is_some());
    assert!(!ide_host::ops::project::info(&project).is_git);
    assert!(project.with_repo_at(Some(&root), |r| r.stage(std::slice::from_ref(&file))).is_err());
    let patch = "diff --git a/keep.txt b/keep.txt\n--- a/keep.txt\n+++ b/keep.txt\n@@ -1 +1 @@\n-keep\n+changed\n";
    assert!(vcs::vcs_apply_patch(&host, "main", Some(root.clone()), patch.into()).await.is_err());
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "keep\n");
    assert!(!root.join(".git/index").exists());
    host.close_project("main");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn jj_diff_reads_owning_nested_root_without_enabling_git_writes() {
    let Some(exe) = ide_vcs::detected_jj_executable() else { return };
    let temp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(temp.path()).unwrap();
    let root = base.join("project");
    let nested = root.join("nested");
    std::fs::create_dir_all(&nested).unwrap();
    let jj = |at: &Path, args: &[&str]| {
        let out = Command::new(&exe)
            .current_dir(at)
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
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    };
    jj(&root, &["git", "init", "--colocate"]);
    jj(&nested, &["git", "init", "--colocate"]);
    for (at, text) in [(&root, "outer"), (&nested, "nested")] {
        std::fs::write(at.join("same.txt"), text).unwrap();
        jj(at, &["new"]);
        std::fs::write(at.join("same.txt"), format!("{text} changed")).unwrap();
        jj(at, &["describe", "-m", text]);
    }
    let host = Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    });
    let project = host.open_project("main", &root).unwrap();
    for _ in 0..500 {
        if project.repos().all().len() == 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(project.repos().all().len(), 2);
    let roots = vcs::vcs_roots(&host, "main").unwrap();
    for (at, text) in [(&root, "outer"), (&nested, "nested")] {
        let copy = roots.iter().find(|r| Path::new(r.root.as_ref()) == at).unwrap().working_copy.as_ref().unwrap();
        let pair = vcs::vcs_jj_file_diff(&host, "main", at.join("same.txt"), copy.commit_id.clone()).await.unwrap();
        assert_eq!(pair.before, text);
        assert_eq!(pair.after, format!("{text} changed"));
        let history = vcs::vcs_jj_history(&host, "main", at.to_path_buf(), None).await.unwrap();
        assert_eq!(history.commits.iter().filter(|c| c.working_copy).count(), 1);
        assert_eq!(history.commits.iter().find(|c| c.working_copy).unwrap().description, format!("{text}\n"));
        assert!(history.commits.iter().all(|c| !c.description.contains(if text == "outer" {
            "nested"
        } else {
            "outer"
        })));
        assert!(vcs::vcs_jj_history(&host, "main", at.join("same.txt"), None).await.is_err());

        let path = at.join("same.txt");
        let doc = project.documents.open(&path).unwrap();
        project
            .documents
            .edit(
                doc.id,
                doc.version,
                ChangeSet {
                    changes: vec![TextChange {
                        from: 0,
                        to: doc.text.encode_utf16().count() as u32,
                        insert: format!("{text} unsaved"),
                    }],
                },
            )
            .unwrap();
        let hunks = vcs::vcs_line_hunks(&host, "main", path.clone()).unwrap();
        assert_eq!(hunks.len(), 1);
        assert_eq!(hunks[0].old_text, text);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), format!("{text} changed"));
        // Restoring only the buffer to the parent removes markers even while disk differs.
        let doc = project.documents.snapshot(doc.id).unwrap();
        project
            .documents
            .edit(
                doc.id,
                doc.version,
                ChangeSet {
                    changes: vec![TextChange {
                        from: 0,
                        to: doc.text.encode_utf16().count() as u32,
                        insert: text.into(),
                    }],
                },
            )
            .unwrap();
        assert!(vcs::vcs_line_hunks(&host, "main", path.clone()).unwrap().is_empty());
        let doc = project.documents.snapshot(doc.id).unwrap();
        project
            .documents
            .edit(doc.id, doc.version, ChangeSet { changes: vec![TextChange { from: 0, to: 0, insert: "\0".into() }] })
            .unwrap();
        assert!(vcs::vcs_line_hunks(&host, "main", path).unwrap_err().to_string().contains("Binary buffers"));

        assert!(project.with_repo_of(&at.join("same.txt"), |r| r.stage(&[at.join("same.txt")])).is_err());
    }
    // The read route reapplies this project's executable setting even if another
    // window has replaced the process-wide executable since the list was loaded.
    let nested_copy =
        roots.iter().find(|r| Path::new(r.root.as_ref()) == nested).unwrap().working_copy.as_ref().unwrap();
    project
        .settings
        .set(ide_workspace::SettingsScope::Project, "vcs.jj.executable", serde_json::json!(base.join("missing-jj")))
        .unwrap();
    let error =
        vcs::vcs_jj_file_diff(&host, "main", nested.join("same.txt"), nested_copy.commit_id.clone()).await.unwrap_err();
    assert!(error.to_string().contains("cannot run"));
    assert!(
        vcs::vcs_jj_history(&host, "main", nested.clone(), None).await.unwrap_err().to_string().contains("cannot run")
    );

    project.settings.set(ide_workspace::SettingsScope::Project, "vcs.jj.executable", serde_json::json!(exe)).unwrap();
    ide_vcs::set_jj_executable(Some(&base.join("another-window-jj")));
    assert_eq!(
        vcs::vcs_jj_file_diff(&host, "main", nested.join("same.txt"), nested_copy.commit_id.clone())
            .await
            .unwrap()
            .after,
        "nested changed"
    );

    ide_vcs::set_jj_executable(Some(&base.join("another-window-jj")));
    assert!(
        vcs::vcs_jj_history(&host, "main", nested.clone(), None)
            .await
            .unwrap()
            .commits
            .iter()
            .any(|c| c.working_copy && c.description == "nested\n")
    );
    assert!(vcs::vcs_jj_history(&host, "main", base.join("outside"), None).await.is_err());
    assert!(vcs::vcs_jj_file_diff(&host, "main", base.join("outside"), String::new()).await.is_err());
    assert!(vcs::vcs_jj_file_diff(&host, "main", nested.join("same.txt"), "stale".into()).await.is_err());
    host.close_project("main");
}
