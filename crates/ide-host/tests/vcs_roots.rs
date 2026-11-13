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
        local_data_dir: base.join("data"),
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
        local_data_dir: base.join("data"),
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

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn jj_version_does_not_spawn_configured_executable_in_restricted_project() {
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(temp.path()).unwrap();
    let root = base.join("project");
    std::fs::create_dir_all(root.join(".jj")).unwrap();
    let marker = base.join("spawned");
    let exe = base.join("fake-jj");
    std::fs::write(&exe, format!("#!/bin/sh\ntouch '{}'\nprintf 'jj 0.35.0\\n'\n", marker.display())).unwrap();
    std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
    let host = Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        local_data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    });
    host.open_project("main", &root).unwrap();
    let error = match vcs::vcs_jj_version(&host, "main", exe.to_string_lossy().into_owned()).await {
        Ok(_) => panic!("restricted project ran jj version test"),
        Err(error) => error.to_string(),
    };
    assert!(error.contains("Restricted Mode"), "{error}");
    assert!(!marker.exists(), "configured jj executable ran in Restricted Mode");
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
    std::fs::write(nested.join("historical.txt"), "outer historical nested path").unwrap();
    jj(&root, &["describe", "-m", "outer historical"]);
    let repo = ide_vcs::Repo::discover(&root).unwrap().unwrap();
    repo.set_execution_allowed(true);
    let historical_id = repo.jj_working_copy().unwrap().commit_id;
    jj(&root, &["new"]);
    std::fs::remove_file(nested.join("historical.txt")).unwrap();
    jj(&root, &["new"]);
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
        local_data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    });
    host.trust.decide(&root, true, false).unwrap();
    let project = host.open_project("main", &root).unwrap();
    for _ in 0..500 {
        if project.repos().all().len() == 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(project.repos().all().len(), 2);
    let roots = vcs::vcs_roots(&host, "main").unwrap();
    // Current nested-root discovery must not invalidate files owned by an older outer tree.
    let old_nested_path =
        vcs::vcs_jj_history_file_diff(&host, "main", root.clone(), nested.join("historical.txt"), historical_id)
            .await
            .unwrap();
    assert_eq!(old_nested_path.before, "");
    assert_eq!(old_nested_path.after, "outer historical nested path");
    for (at, text) in [(&root, "outer"), (&nested, "nested")] {
        let url = format!("https://github.com/example/{text}.git");
        jj(at, &["git", "remote", "add", "origin", &url]);
        let remotes = vcs::vcs_remotes(&host, "main", Some(at.clone())).await.unwrap();
        assert_eq!(remotes, vec![ide_vcs::Remote { name: "origin".into(), url, resolved_url: None }]);
        assert!(vcs::vcs_remotes(&host, "main", Some(at.join("same.txt"))).await.is_err());
        let copy = roots.iter().find(|r| Path::new(r.root.as_ref()) == at).unwrap().working_copy.as_ref().unwrap();
        let pair = vcs::vcs_jj_file_diff(&host, "main", at.join("same.txt"), copy.commit_id.clone()).await.unwrap();
        assert_eq!(pair.before, text);
        assert_eq!(pair.after, format!("{text} changed"));
        let historical =
            vcs::vcs_jj_history_files(&host, "main", at.to_path_buf(), copy.commit_id.clone()).await.unwrap();
        assert_eq!(historical.len(), 1);
        assert_eq!(historical[0].rel_path, "same.txt");
        let historical_pair =
            vcs::vcs_jj_history_file_diff(&host, "main", at.to_path_buf(), at.join("same.txt"), copy.commit_id.clone())
                .await
                .unwrap();
        assert_eq!(historical_pair.before, text);
        assert_eq!(historical_pair.after, format!("{text} changed"));
        assert!(vcs::vcs_jj_history_files(&host, "main", at.join("same.txt"), copy.commit_id.clone()).await.is_err());
        assert!(
            vcs::vcs_jj_history_file_diff(
                &host,
                "main",
                at.to_path_buf(),
                base.join("outside"),
                copy.commit_id.clone()
            )
            .await
            .is_err()
        );
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
        let hunks = vcs::vcs_line_hunks(&host, "main", path.clone()).await.unwrap();
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
        assert!(vcs::vcs_line_hunks(&host, "main", path.clone()).await.unwrap().is_empty());
        let doc = project.documents.snapshot(doc.id).unwrap();
        project
            .documents
            .edit(doc.id, doc.version, ChangeSet { changes: vec![TextChange { from: 0, to: 0, insert: "\0".into() }] })
            .unwrap();
        assert!(vcs::vcs_line_hunks(&host, "main", path).await.unwrap_err().to_string().contains("Binary buffers"));

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

    assert!(
        vcs::vcs_jj_history_files(&host, "main", nested.clone(), nested_copy.commit_id.clone())
            .await
            .unwrap_err()
            .to_string()
            .contains("cannot run")
    );
    assert!(
        vcs::vcs_jj_history_file_diff(
            &host,
            "main",
            nested.clone(),
            nested.join("same.txt"),
            nested_copy.commit_id.clone()
        )
        .await
        .unwrap_err()
        .to_string()
        .contains("cannot run")
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
    assert!(
        vcs::vcs_jj_history_file_diff(
            &host,
            "main",
            root.clone(),
            nested.join("same.txt"),
            nested_copy.commit_id.clone()
        )
        .await
        .is_err()
    );
    assert!(vcs::vcs_jj_history_files(&host, "main", root.clone(), "@".into()).await.is_err());
    assert!(vcs::vcs_jj_file_diff(&host, "main", base.join("outside"), String::new()).await.is_err());
    assert!(vcs::vcs_jj_file_diff(&host, "main", nested.join("same.txt"), "stale".into()).await.is_err());
    host.close_project("main");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn jj_log_actions_guard_trust_exact_root_and_unsaved_documents() {
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
    for at in [&root, &nested] {
        jj(at, &["git", "init", "--colocate"]);
        jj(at, &["config", "set", "--repo", "signing.behavior", "drop"]);
        std::fs::write(at.join("same.txt"), "before").unwrap();
        jj(at, &["describe", "-m", "base"]);
        jj(at, &["new", "-m", "child"]);
        std::fs::write(at.join("same.txt"), "after").unwrap();
    }
    let host = Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        local_data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    });
    host.open_project("restricted", &root).unwrap();
    let error = vcs::vcs_jj_log_action(
        &host,
        "restricted",
        root.clone(),
        "a".repeat(40),
        "z".repeat(32),
        ide_vcs::JjLogAction::New,
    )
    .await
    .unwrap_err()
    .to_string();
    assert!(error.contains("Restricted Mode"), "{error}");
    assert!(
        vcs::vcs_jj_restore_files(&host, "restricted", root.clone(), "a".repeat(40), vec![root.join("same.txt")])
            .await
            .unwrap_err()
            .to_string()
            .contains("Restricted Mode")
    );
    let edit = ide_vcs::JjDescriptionEdit {
        commit: "a".repeat(40),
        change: "z".repeat(32),
        original: "".into(),
        description: "new description".into(),
    };
    assert!(
        vcs::vcs_jj_describe(&host, "restricted", root.clone(), edit.clone())
            .await
            .unwrap_err()
            .to_string()
            .contains("Restricted Mode")
    );
    host.close_project("restricted");
    host.trust.decide(&root, true, false).unwrap();
    let project = host.open_project("main", &root).unwrap();
    for _ in 0..500 {
        if project.repos().all().len() == 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(project.repos().all().len(), 2);
    let history = vcs::vcs_jj_history(&host, "main", nested.clone(), None).await.unwrap();
    let selected = history.commits.iter().find(|c| c.working_copy).unwrap();
    for invalid_root in [root.join("same.txt"), base.join("outside")] {
        assert!(
            vcs::vcs_jj_log_action(
                &host,
                "main",
                invalid_root,
                selected.id.clone(),
                selected.change_id.clone(),
                ide_vcs::JjLogAction::New
            )
            .await
            .unwrap_err()
            .to_string()
            .contains("root")
        );
    }
    assert!(
        vcs::vcs_jj_restore_files(
            &host,
            "main",
            base.join("outside"),
            selected.id.clone(),
            vec![nested.join("same.txt")]
        )
        .await
        .is_err()
    );
    assert!(
        vcs::vcs_jj_restore_files(&host, "main", root.clone(), selected.id.clone(), vec![nested.join("same.txt")])
            .await
            .is_err()
    );
    assert!(
        vcs::vcs_jj_restore_files(&host, "main", nested.clone(), "stale".into(), vec![nested.join("same.txt")])
            .await
            .is_err()
    );
    for invalid_root in [root.join("same.txt"), base.join("outside")] {
        assert!(
            vcs::vcs_jj_describe(&host, "main", invalid_root, edit.clone())
                .await
                .unwrap_err()
                .to_string()
                .contains("root")
        );
    }
    let nested_copy = vcs::vcs_roots(&host, "main")
        .unwrap()
        .into_iter()
        .find(|r| r.root.as_ref() == nested)
        .unwrap()
        .working_copy
        .unwrap();
    let nested_edit = ide_vcs::JjDescriptionEdit {
        commit: nested_copy.commit_id,
        change: nested_copy.change_id,
        original: nested_copy.description,
        description: "nested description\n\nbody\n".into(),
    };
    vcs::vcs_jj_describe(&host, "main", nested.clone(), nested_edit).await.unwrap();
    let roots = vcs::vcs_roots(&host, "main").unwrap();
    assert_eq!(
        roots.iter().find(|r| r.root.as_ref() == nested).unwrap().working_copy.as_ref().unwrap().description,
        "nested description\n\nbody\n"
    );
    assert_eq!(
        roots.iter().find(|r| r.root.as_ref() == root).unwrap().working_copy.as_ref().unwrap().description,
        "child\n"
    );
    let history = vcs::vcs_jj_history(&host, "main", nested.clone(), None).await.unwrap();
    let selected = history.commits.iter().find(|c| c.working_copy).unwrap();
    let path = nested.join("same.txt");
    let doc = project.documents.open(&path).unwrap();
    project
        .documents
        .edit(
            doc.id,
            doc.version,
            ChangeSet { changes: vec![TextChange { from: 0, to: 0, insert: "unsaved ".into() }] },
        )
        .unwrap();
    for action in [ide_vcs::JjLogAction::New, ide_vcs::JjLogAction::Edit, ide_vcs::JjLogAction::Abandon] {
        let error = vcs::vcs_jj_log_action(
            &host,
            "main",
            nested.clone(),
            selected.id.clone(),
            selected.change_id.clone(),
            action,
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(error.contains("Save unsaved documents"), "{error}");
        assert_eq!(project.documents.snapshot(doc.id).unwrap().text, "unsaved after");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "after");
    }
    assert!(
        vcs::vcs_jj_restore_files(&host, "main", nested.clone(), selected.id.clone(), vec![path.clone()])
            .await
            .unwrap_err()
            .to_string()
            .contains("Save unsaved documents")
    );
    project.documents.close(doc.id);
    let clean = project.documents.open(&path).unwrap();
    vcs::vcs_jj_restore_files(&host, "main", nested.clone(), selected.id.clone(), vec![path.clone()]).await.unwrap();
    assert_eq!(project.documents.snapshot(clean.id).unwrap().text, "before");
    assert_eq!(std::fs::read_to_string(root.join("same.txt")).unwrap(), "after");
    let parent = history.commits.iter().find(|c| c.id == selected.parents[0]).unwrap();
    vcs::vcs_jj_log_action(
        &host,
        "main",
        nested.clone(),
        parent.id.clone(),
        parent.change_id.clone(),
        ide_vcs::JjLogAction::Edit,
    )
    .await
    .unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "before");
    assert_eq!(project.documents.snapshot(clean.id).unwrap().text, "before");
    assert_eq!(std::fs::read_to_string(root.join("same.txt")).unwrap(), "after");
    host.close_project("main");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn jj_workspaces_require_trust_and_exact_project_root() {
    let Some(exe) = ide_vcs::detected_jj_executable() else { return };
    let temp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(temp.path()).unwrap();
    let root = base.join("project");
    assert!(Command::new(&exe).args(["git", "init"]).arg(&root).output().unwrap().status.success());
    assert!(
        Command::new(&exe)
            .current_dir(&root)
            .args(["config", "set", "--repo", "signing.behavior", "drop"])
            .output()
            .unwrap()
            .status
            .success()
    );
    let host = Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        local_data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    });
    host.open_project("restricted", &root).unwrap();
    assert!(vcs::vcs_jj_workspaces(&host, "restricted", root.clone()).await.is_err());
    let push_request = ide_vcs::JjPushRequest {
        bookmarks: vec!["main".into()],
        tags: vec![],
        all_tags: false,
        remote: "origin".into(),
        review: None,
    };
    assert!(vcs::vcs_jj_push_options(&host, "restricted", root.clone()).await.is_err());
    assert!(vcs::vcs_jj_push(&host, "restricted", root.clone(), push_request.clone()).await.is_err());
    assert!(
        vcs::vcs_jj_add_workspace(&host, "restricted", root.clone(), "other".into(), base.join("other"), "@".into())
            .await
            .is_err()
    );
    let unavailable = ide_vcs::JjWorkspace {
        name: "other".into(),
        path: Some(base.join("other")),
        change_id: String::new(),
        commit_id: String::new(),
        current: false,
    };
    assert!(vcs::vcs_jj_remove_workspace(&host, "restricted", root.clone(), unavailable).await.is_err());
    assert!(!base.join("other").exists());
    host.close_project("restricted");
    host.trust.decide(&root, true, false).unwrap();
    host.open_project("main", &root).unwrap();
    assert_eq!(vcs::vcs_jj_workspaces(&host, "main", root.clone()).await.unwrap().len(), 1);
    for wrong in [base.clone(), root.join(".jj"), base.join("outside")] {
        assert!(vcs::vcs_jj_workspaces(&host, "main", wrong.clone()).await.is_err());
        assert!(vcs::vcs_jj_push_options(&host, "main", wrong.clone()).await.is_err());
        assert!(vcs::vcs_jj_push(&host, "main", wrong.clone(), push_request.clone()).await.is_err());
        assert!(
            vcs::vcs_jj_add_workspace(&host, "main", wrong, "other".into(), base.join("other"), "@".into())
                .await
                .is_err()
        );
    }
    let target = base.join("other");
    vcs::vcs_jj_add_workspace(&host, "main", root.clone(), "other".into(), target.clone(), "@".into()).await.unwrap();
    let row = vcs::vcs_jj_workspaces(&host, "main", root.clone())
        .await
        .unwrap()
        .into_iter()
        .find(|w| w.name == "other")
        .unwrap();
    assert!(vcs::vcs_jj_remove_workspace(&host, "main", root.join(".jj"), row.clone()).await.is_err());
    host.trust.decide(&target, true, false).unwrap();
    host.open_project("other", &target).unwrap();
    assert!(
        vcs::vcs_jj_remove_workspace(&host, "main", root.clone(), row.clone())
            .await
            .unwrap_err()
            .to_string()
            .contains("Close the open or attached workspace")
    );
    assert!(target.exists());
    host.close_project("other");
    let project = host.project("main").unwrap();
    let file = target.join("keep.txt");
    std::fs::write(&file, "keep").unwrap();
    let doc = project.documents.open(&file).unwrap();
    project
        .documents
        .edit(doc.id, doc.version, ChangeSet { changes: vec![TextChange { from: 0, to: 0, insert: "unsaved".into() }] })
        .unwrap();
    assert!(
        vcs::vcs_jj_remove_workspace(&host, "main", root.clone(), row.clone())
            .await
            .unwrap_err()
            .to_string()
            .contains("Close workspace documents")
    );
    assert!(target.exists());
    project.documents.close(doc.id);
    vcs::vcs_jj_remove_workspace(&host, "main", root.clone(), row).await.unwrap();
    assert!(!target.exists());
    host.close_project("main");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn jj_workspace_update_guards_all_projects_and_syncs_clean_documents() {
    let Some(exe) = ide_vcs::detected_jj_executable() else { return };
    let temp = tempfile::tempdir().unwrap();
    let base = temp.path().canonicalize().unwrap();
    let root = base.join("main");
    let run = |args: &[&str]| {
        let out = Command::new(&exe)
            .current_dir(&root)
            .args(["--config", "signing.behavior=drop", "-R"])
            .arg(&root)
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    };
    assert!(Command::new(&exe).args(["git", "init"]).arg(&root).output().unwrap().status.success());
    std::fs::write(root.join("file.txt"), "before").unwrap();
    run(&["new"]);
    let host = Host::new(HostConfig {
        config_dir: base.join("config"),
        data_dir: base.join("data"),
        local_data_dir: base.join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    });
    host.trust.decide(&root, true, false).unwrap();
    host.open_project("main", &root).unwrap();
    let target = base.join("other");
    vcs::vcs_jj_add_workspace(&host, "main", root.clone(), "other".into(), target.clone(), "@-".into()).await.unwrap();
    let pinned = vcs::vcs_jj_workspaces(&host, "main", root.clone())
        .await
        .unwrap()
        .into_iter()
        .find(|w| w.name == "other")
        .unwrap();
    host.trust.decide(&target, true, false).unwrap();
    host.open_project("other", &target).unwrap();
    let other = host.project("other").unwrap();
    let file = target.join("file.txt");
    let doc = other.documents.open(&file).unwrap();
    other
        .documents
        .edit(doc.id, doc.version, ChangeSet { changes: vec![TextChange { from: 0, to: 0, insert: "unsaved".into() }] })
        .unwrap();
    std::fs::write(root.join("file.txt"), "after recovery with different length").unwrap();
    run(&["restore", "--from", "@", "--into", "other@", "file.txt"]);
    assert!(
        vcs::vcs_jj_update_workspace(&host, "main", root.clone(), pinned.clone())
            .await
            .unwrap_err()
            .to_string()
            .contains("unsaved")
    );
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "before");
    assert!(other.documents.snapshot(doc.id).unwrap().text.starts_with("unsaved"));
    other.documents.close(doc.id);
    let clean = other.documents.open(&file).unwrap();
    assert!(vcs::vcs_jj_update_workspace(&host, "main", root.join(".jj"), pinned.clone()).await.is_err());
    // The selected secondary is not a root of the calling project.
    vcs::vcs_jj_update_workspace(&host, "main", root.clone(), pinned.clone()).await.unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "after recovery with different length");
    assert_eq!(other.documents.snapshot(clean.id).unwrap().text, "after recovery with different length");
    let current =
        vcs::vcs_jj_workspaces(&host, "main", root.clone()).await.unwrap().into_iter().find(|w| w.current).unwrap();
    vcs::vcs_jj_update_workspace(&host, "main", root.clone(), current).await.unwrap();
    host.close_project("other");
    host.close_project("main");
    // Trust is established at project opening; use a fresh untrusted root for Restricted Mode.
    let restricted = base.join("restricted");
    assert!(Command::new(&exe).args(["git", "init"]).arg(&restricted).output().unwrap().status.success());
    host.open_project("locked", &restricted).unwrap();
    assert!(vcs::vcs_jj_update_workspace(&host, "locked", restricted, pinned).await.is_err());
}
