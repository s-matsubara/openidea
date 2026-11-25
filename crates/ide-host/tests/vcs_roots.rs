//! Repository-scoped patch operations must never fall back to the primary root.
mod common;

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
        let source = root.join("located/src");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("settings.txt"), format!("port={}\n", if i == 0 { 900 } else { 100 })).unwrap();
        std::fs::write(source.join("report.txt"), "total=100\n").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-m", "initial"]);
        std::fs::write(root.join("same.txt"), format!("changed {i}\n")).unwrap();
        git(root, &["commit", "-am", "change"]);
        revisions.push(git(root, &["rev-parse", "HEAD"]));
    }
    let host = Host::new(common::host_config(&base));
    host.trust.decide(&project_root, true, false).unwrap();
    let project = host.open_project("main", &project_root).unwrap();
    for _ in 0..500 {
        if project.repos().all().len() == 2
            && !project.index.status().indexing
            && project.index.files_named("settings.txt").len() == 2
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(project.repos().all().len(), 2);

    let source = roots[1].join("located/src");
    let original = source.join("report.txt");
    let renamed = source.join("new report.txt");
    git(&roots[1], &["mv", "located/src/report.txt", "located/src/new report.txt"]);
    let patch = vcs::vcs_create_patch(
        &host,
        "main",
        None,
        vcs::PatchSource::Changes { paths: vec![original.into(), renamed.into()], reverse: false },
        Some(roots[1].join("located")),
    )
    .await
    .unwrap();
    assert!(patch.contains("rename from src/report.txt\n"));
    let preview =
        vcs::vcs_patch_preview(&host, "main", Some(roots[1].clone()), patch, Some(vcs::PatchTarget::Repository), None)
            .await
            .unwrap();
    assert_eq!(preview.files.len(), 1);
    assert_eq!(preview.files[0].old_path.as_deref(), Some("src/report.txt"));
    assert_eq!(preview.files[0].path, "src/new report.txt");
    git(&roots[1], &["reset", "--hard", "HEAD"]);

    for (i, root) in roots.iter().enumerate() {
        let patch = vcs::vcs_create_patch(
            &host,
            "main",
            Some(root.clone()),
            vcs::PatchSource::Commits { commits: vec![revisions[i].clone()], reverse: true },
            None,
        )
        .await
        .unwrap();
        assert!(patch.contains(&format!("-changed {i}")));
        let preview =
            vcs::vcs_patch_preview(&host, "main", Some(root.clone()), patch.clone(), None, None).await.unwrap();
        assert!(preview.base.is_none());
        assert_eq!(preview.files.len(), 1);
        vcs::vcs_apply_patch(&host, "main", Some(root.clone()), patch, Some(vec!["same.txt".into()])).await.unwrap();
        assert_eq!(std::fs::read_to_string(root.join("same.txt")).unwrap(), format!("root {i}\n"));
    }
    assert!(vcs::vcs_apply_patch(&host, "main", Some(base.join("outside")), String::new(), None).await.is_err());

    for (i, root) in roots.iter().enumerate() {
        std::fs::write(root.join("same.txt"), format!("project patch {i}\n")).unwrap();
    }
    let entries = roots
        .iter()
        .map(|root| ide_vcs::StagingPatchEntry {
            path: root.join("same.txt").into(),
            renamed_from: None,
            side: ide_vcs::StagingPatchSide::Unstaged,
        })
        .collect();
    let patch = vcs::vcs_create_patch(&host, "main", None, vcs::PatchSource::Staging { entries, reverse: false }, None)
        .await
        .unwrap();
    let selected_changes = || vcs::PatchSource::Changes {
        paths: roots.iter().map(|root| root.join("same.txt").into()).collect(),
        reverse: false,
    };
    let combined =
        vcs::vcs_create_patch(&host, "main", None, selected_changes(), Some(project_root.clone())).await.unwrap();
    assert!(combined.contains("diff --git a/front/same.txt b/front/same.txt"));
    assert!(combined.contains("diff --git a/back/same.txt b/back/same.txt"));
    let error =
        vcs::vcs_create_patch(&host, "main", None, selected_changes(), Some(roots[0].clone())).await.unwrap_err();
    assert_eq!(error.message, "The base directory must contain every selected path");
    for root in &roots {
        git(root, &["restore", "--", "same.txt"]);
    }
    let preview =
        vcs::vcs_patch_preview(&host, "main", Some(roots[0].clone()), patch.clone(), None, None).await.unwrap();
    assert_eq!(preview.base.unwrap(), project_root);
    assert_eq!(
        preview.files.iter().map(|file| file.path.as_str()).collect::<Vec<_>>(),
        ["back/same.txt", "front/same.txt"]
    );
    assert!(preview.files.iter().all(|file| file.applies));
    let diff = vcs::vcs_patch_file_diff(
        &host,
        "main",
        Some(roots[1].clone()),
        Some(project_root.clone()),
        patch.clone(),
        "front/same.txt".into(),
        None,
    )
    .await
    .unwrap();
    assert_eq!(diff.path, roots[0].join("same.txt"));
    assert!(matches!(
        diff.content,
        ide_vcs::PatchDiffContent::Text { before: Some(before), after: Some(after) }
            if before == "changed 0\n" && after == "project patch 0\n"
    ));
    assert_eq!(std::fs::read_to_string(roots[0].join("same.txt")).unwrap(), "changed 0\n");

    let explicit_repo = vcs::vcs_patch_preview(
        &host,
        "main",
        Some(roots[0].clone()),
        patch.clone(),
        Some(vcs::PatchTarget::Repository),
        None,
    )
    .await
    .unwrap();
    assert!(explicit_repo.base.is_none());
    assert!(explicit_repo.files.iter().all(|file| !file.applies));
    assert!(vcs::vcs_apply_project_patch(&host, "main", base.join("outside"), patch.clone(), None).await.is_err());
    let cross_root_rename = "diff --git a/front/same.txt b/back/moved.txt\nsimilarity index 100%\nrename from front/same.txt\nrename to back/moved.txt\n";
    assert!(
        vcs::vcs_apply_project_patch(&host, "main", project_root.clone(), cross_root_rename.into(), None)
            .await
            .is_err()
    );
    let selected = vcs::vcs_apply_project_patch(
        &host,
        "main",
        project_root.clone(),
        patch.clone(),
        Some(vec!["front/same.txt".into()]),
    )
    .await
    .unwrap();
    assert_eq!(selected.outcome.applied, ["front/same.txt"]);
    assert!(selected.failures.is_empty());
    assert_eq!(std::fs::read_to_string(roots[0].join("same.txt")).unwrap(), "project patch 0\n");
    assert_eq!(std::fs::read_to_string(roots[1].join("same.txt")).unwrap(), "changed 1\n");
    git(&roots[0], &["restore", "--", "same.txt"]);
    std::fs::write(roots[1].join("same.txt"), "local edit\n").unwrap();

    let partial = vcs::vcs_apply_project_patch(&host, "main", project_root.clone(), patch.clone(), None).await.unwrap();
    assert_eq!(partial.outcome.applied, ["front/same.txt"]);
    assert!(partial.outcome.conflicts.is_empty());
    assert_eq!(partial.failures.len(), 1);
    assert_eq!(partial.failures[0].root, roots[1]);
    assert_eq!(std::fs::read_to_string(roots[0].join("same.txt")).unwrap(), "project patch 0\n");
    assert_eq!(std::fs::read_to_string(roots[1].join("same.txt")).unwrap(), "local edit\n");
    for root in &roots {
        assert!(git(root, &["diff", "--cached", "--name-only"]).is_empty());
    }
    git(&roots[0], &["restore", "--", "same.txt"]);
    git(&roots[1], &["commit", "-am", "conflicting local commit"]);
    let conflicted = vcs::vcs_apply_project_patch(&host, "main", project_root, patch, None).await.unwrap();
    assert_eq!(conflicted.outcome.applied, ["front/same.txt"]);
    assert_eq!(conflicted.outcome.conflicts, ["back/same.txt"]);
    assert_eq!(conflicted.conflicted_repositories, [roots[1].clone()]);
    assert!(conflicted.failures.is_empty());
    assert_eq!(git(&roots[1], &["diff", "--name-only", "--diff-filter=U"]), "same.txt");
    let conflict = roots[1].join("same.txt");
    let versions = vcs::vcs_conflict_versions(&host, "main", conflict.clone()).await.unwrap();
    assert_eq!(versions.sides.operation.as_deref(), Some("apply-patch"));
    assert!(!versions.sides.reversed);
    assert_eq!(versions.ours.as_deref(), Some("local edit\n"));
    assert_eq!(versions.theirs.as_deref(), Some("project patch 1\n"));
    vcs::vcs_accept_conflict_side(&host, "main", vec![conflict.clone()], ide_vcs::ConflictSide::Theirs).await.unwrap();
    assert_eq!(std::fs::read_to_string(conflict).unwrap(), "project patch 1\n");

    git(&roots[1], &["restore", "--source=HEAD", "--staged", "--worktree", "--", "same.txt"]);
    let target = roots[1].join("moved here");
    std::fs::create_dir_all(&target).unwrap();
    std::fs::write(target.join("before.txt"), "content\n").unwrap();
    let source = "legacy/path/after.txt";
    let patch = concat!(
        "diff --git a/legacy/path/before.txt b/legacy/path/after.txt\n",
        "similarity index 100%\nrename from legacy/path/before.txt\nrename to legacy/path/after.txt\n",
        "diff --git a/same.txt b/same.txt\n--- a/same.txt\n+++ b/same.txt\n",
        "@@ -1 +1 @@\n-project patch 0\n+unselected\n"
    );
    let mapping = || ide_vcs::PatchPathMapping {
        path: source.into(),
        directory: Some(target.clone().into()),
        strip: 2,
        file: None,
    };
    let make_invalid = |directory| ide_vcs::PatchPathMapping {
        path: "same.txt".into(),
        directory: Some(directory),
        strip: 0,
        file: None,
    };
    let preview = vcs::vcs_patch_preview(
        &host,
        "main",
        Some(roots[0].clone()),
        patch.into(),
        Some(vcs::PatchTarget::Repository),
        Some(vec![mapping(), make_invalid(base.clone().into())]),
    )
    .await
    .unwrap();
    assert!(preview.files[0].applies);
    assert!(!preview.files[1].applies);
    let placements = preview.placements.unwrap();
    assert_eq!(placements[0].target.as_ref().unwrap(), &target.join("after.txt"));
    assert!(placements[1].error.is_some());
    let diff = vcs::vcs_patch_file_diff(
        &host,
        "main",
        Some(roots[0].clone()),
        None,
        patch.into(),
        source.into(),
        Some(vec![mapping()]),
    )
    .await
    .unwrap();
    assert_eq!(diff.path, target.join("after.txt"));
    assert_eq!(diff.old_path.unwrap(), target.join("before.txt"));
    assert!(
        matches!(diff.content, ide_vcs::PatchDiffContent::Text { before: Some(before), after: Some(after) } if before == "content\n" && before == after)
    );
    assert!(target.join("before.txt").exists());
    assert!(!target.join("after.txt").exists());
    assert!(
        vcs::vcs_apply_mapped_patch(
            &host,
            "main",
            Some(roots[0].clone()),
            None,
            patch.into(),
            None,
            vec![mapping(), make_invalid(base.into())],
        )
        .await
        .is_err()
    );
    assert!(target.join("before.txt").exists());
    let applied = vcs::vcs_apply_mapped_patch(
        &host,
        "main",
        Some(roots[0].clone()),
        None,
        patch.into(),
        Some(vec![source.into()]),
        vec![mapping()],
    )
    .await
    .unwrap();
    assert!(applied.failures.is_empty());
    assert_eq!(applied.outcome.applied, [ide_core::ipc_path::to_ipc(&target.join("after.txt"))]);
    assert!(!target.join("before.txt").exists());
    assert_eq!(std::fs::read_to_string(target.join("after.txt")).unwrap(), "content\n");
    assert_eq!(std::fs::read_to_string(roots[0].join("same.txt")).unwrap(), "project patch 0\n");

    let patch = concat!(
        "diff --git a/legacy/original.txt b/legacy/renamed.txt\n",
        "similarity index 55%\nrename from legacy/original.txt\nrename to legacy/renamed.txt\n",
        "--- a/legacy/original.txt\n+++ b/legacy/renamed.txt\n",
        "@@ -1 +1 @@\n-content\n+repaired content\n",
    );
    let source = "legacy/renamed.txt";
    let existing = target.join("local name.txt");
    std::fs::write(&existing, "content\n").unwrap();
    let to_file = |path: &std::path::Path| ide_vcs::PatchPathMapping {
        path: source.into(),
        directory: None,
        strip: 0,
        file: Some(path.into()),
    };
    let root = Some(roots[0].clone());
    let preview = vcs::vcs_patch_preview(&host, "main", root.clone(), patch.into(), None, None).await.unwrap();
    assert!(preview.files[0].missing_base);
    let invalid = vcs::vcs_patch_preview(&host, "main", root.clone(), patch.into(), None, Some(vec![to_file(&target)]))
        .await
        .unwrap();
    assert!(invalid.placements.unwrap()[0].error.is_some());
    let mapped =
        vcs::vcs_patch_preview(&host, "main", root.clone(), patch.into(), None, Some(vec![to_file(&existing)]))
            .await
            .unwrap();
    assert_eq!(mapped.files[0].path, source);
    assert!(!mapped.files[0].missing_base);
    assert!(mapped.files[0].applies);
    assert_eq!(mapped.placements.unwrap()[0].target.as_ref().unwrap(), &existing);
    let diff = vcs::vcs_patch_file_diff(
        &host,
        "main",
        root.clone(),
        None,
        patch.into(),
        source.into(),
        Some(vec![to_file(&existing)]),
    )
    .await
    .unwrap();
    assert_eq!(diff.path, existing);
    assert!(diff.old_path.is_none());
    assert!(matches!(diff.content, ide_vcs::PatchDiffContent::Text { before: Some(before), after: Some(after) }
            if before == "content\n" && after == "repaired content\n"));
    let applied = vcs::vcs_apply_mapped_patch(&host, "main", root, None, patch.into(), None, vec![to_file(&existing)])
        .await
        .unwrap();
    assert!(applied.failures.is_empty());
    assert_eq!(applied.outcome.applied, [ide_core::ipc_path::to_ipc(&existing)]);
    assert_eq!(std::fs::read_to_string(&existing).unwrap(), "repaired content\n");
    assert!(!roots[0].join(source).exists() && !target.join("renamed.txt").exists());

    let patch = concat!(
        "diff --git a/checkout/src/settings.txt b/checkout/src/settings.txt\n",
        "--- a/checkout/src/settings.txt\n+++ b/checkout/src/settings.txt\n",
        "@@ -1 +1 @@\n-port=100\n+port=200\n",
        "diff --git a/checkout/src/report.txt b/checkout/src/report.txt\n",
        "--- a/checkout/src/report.txt\n+++ b/checkout/src/report.txt\n",
        "@@ -1 +1 @@\n-total=100\n+total=200\n",
    );
    let root = Some(roots[0].clone());
    let preview = vcs::vcs_patch_preview(&host, "main", root.clone(), patch.into(), None, None).await.unwrap();
    let automatic = preview.automatic_mappings;
    assert_eq!(automatic.len(), 1);
    assert_eq!(automatic[0].path, "checkout/src/settings.txt");
    assert_eq!(automatic[0].directory.as_ref().unwrap(), &roots[1].join("located"));
    assert_eq!(automatic[0].strip, 1);
    assert!(preview.files[0].applies && !preview.files[0].missing_base);
    assert!(preview.files[1].missing_base);
    assert_eq!(preview.directory_matches[0].candidates[0].applies, Some(true));
    assert_eq!(preview.directory_matches[0].candidates[1].applies, Some(false));
    assert_eq!(preview.directory_matches[1].candidates.len(), 2);
    assert!(preview.directory_matches[1].candidates.iter().all(|candidate| candidate.applies == Some(true)));
    let repo_only =
        vcs::vcs_patch_preview(&host, "main", root.clone(), patch.into(), Some(vcs::PatchTarget::Repository), None)
            .await
            .unwrap();
    assert!(repo_only.automatic_mappings.is_empty());
    assert!(repo_only.files.iter().all(|file| file.missing_base));
    assert!(repo_only.directory_matches.iter().all(|matches| matches.candidates.len() == 1));
    let report = preview.directory_matches[1]
        .candidates
        .iter()
        .find(|candidate| candidate.source.starts_with(&roots[0]))
        .unwrap();
    let selected = ide_vcs::PatchPathMapping {
        path: "checkout/src/report.txt".into(),
        directory: Some(report.directory.clone()),
        strip: report.strip,
        file: None,
    };
    let reset = ide_vcs::PatchPathMapping { path: automatic[0].path.clone(), directory: None, strip: 0, file: None };
    let reset_preview =
        vcs::vcs_patch_preview(&host, "main", root.clone(), patch.into(), None, Some(vec![reset])).await.unwrap();
    assert!(reset_preview.automatic_mappings.is_empty());
    assert!(reset_preview.files[0].missing_base);
    let mappings = [automatic, vec![selected]].concat();
    let diff = vcs::vcs_patch_file_diff(
        &host,
        "main",
        root.clone(),
        None,
        patch.into(),
        mappings[0].path.clone(),
        Some(mappings.clone()),
    )
    .await
    .unwrap();
    assert_eq!(diff.path, roots[1].join("located/src/settings.txt"));
    let applied = vcs::vcs_apply_mapped_patch(&host, "main", root, None, patch.into(), None, mappings).await.unwrap();
    assert!(applied.failures.is_empty());
    assert_eq!(applied.outcome.applied.len(), 2);
    assert_eq!(std::fs::read_to_string(&*report.source).unwrap(), "total=200\n");
    assert_eq!(std::fs::read_to_string(roots[1].join("located/src/report.txt")).unwrap(), "total=100\n");
    assert_eq!(std::fs::read_to_string(roots[1].join("located/src/settings.txt")).unwrap(), "port=200\n");
    assert_eq!(std::fs::read_to_string(roots[0].join("located/src/settings.txt")).unwrap(), "port=900\n");

    // Empty folders never appear in the filename index. The patch should still preserve
    // the new subfolder beneath the matched parent and leave a tie at the original path.
    let mail = roots[1].join("modules/mail/templates");
    let ignored = roots[0].join("cache/mail/templates");
    for path in [&mail, &ignored, &roots[0].join("alpha/widgets/templates"), &roots[1].join("beta/widgets/templates")] {
        std::fs::create_dir_all(path).unwrap();
    }
    std::fs::write(roots[0].join(".git/info/exclude"), "/cache/\n").unwrap();
    let new_mail = "checkout/mail/templates/emails/welcome.txt";
    let new_widget = "checkout/widgets/templates/banner.txt";
    let existing_parent = "located/src/new-settings.txt";
    let generic_parent = "checkout/src/new-module.txt";
    let patch = [new_mail, new_widget, existing_parent, generic_parent]
        .iter()
        .map(|path| {
            format!("diff --git a/{path} b/{path}\nnew file mode 100644\n--- /dev/null\n+++ b/{path}\n@@ -0,0 +1 @@\n+new content\n")
        })
        .collect::<String>();
    let root = Some(roots[0].clone());
    // Automatic mappings wait for indexing; the new folders and exclude rule may start a rescan.
    tokio::time::sleep(Duration::from_millis(200)).await;
    for _ in 0..500 {
        if !project.index.status().indexing {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let preview = vcs::vcs_patch_preview(&host, "main", root.clone(), patch.clone(), None, None).await.unwrap();
    assert!(preview.files.iter().all(|file| file.applies && !file.missing_base));
    assert_eq!(preview.automatic_mappings.len(), 1);
    assert_eq!(preview.automatic_mappings[0].path, new_mail);
    assert_eq!(preview.automatic_mappings[0].strip, 1);
    assert_eq!(preview.automatic_mappings[0].directory.as_ref().unwrap(), &roots[1].join("modules"));
    assert_eq!(preview.directory_matches.len(), 2);
    assert_eq!(preview.directory_matches[0].path, new_mail);
    assert_eq!(preview.directory_matches[0].candidates.len(), 1);
    assert_eq!(preview.directory_matches[1].path, new_widget);
    assert_eq!(preview.directory_matches[1].candidates.len(), 2);
    let expected = mail.join("emails/welcome.txt");
    let placement = |path: &str| {
        let placements = preview.placements.as_ref().unwrap();
        placements.iter().find(|entry| entry.path == path).unwrap().target.as_ref().unwrap()
    };
    assert_eq!(placement(new_mail), &expected);
    assert_eq!(placement(new_widget), &roots[0].join(new_widget));
    assert_eq!(placement(existing_parent), &roots[0].join(existing_parent));
    assert_eq!(placement(generic_parent), &roots[0].join(generic_parent));
    let diff = vcs::vcs_patch_file_diff(
        &host,
        "main",
        root.clone(),
        None,
        patch.clone(),
        new_mail.into(),
        Some(preview.automatic_mappings.clone()),
    )
    .await
    .unwrap();
    assert_eq!(diff.path, expected);
    assert!(
        matches!(diff.content, ide_vcs::PatchDiffContent::Text { before: None, after: Some(after) } if after == "new content\n")
    );
    let applied = vcs::vcs_apply_mapped_patch(
        &host,
        "main",
        root,
        None,
        patch,
        Some(vec![new_mail.into(), new_widget.into()]),
        preview.automatic_mappings,
    )
    .await
    .unwrap();
    assert!(applied.failures.is_empty());
    assert_eq!(applied.outcome.applied.len(), 2);
    assert_eq!(std::fs::read_to_string(expected).unwrap(), "new content\n");
    assert_eq!(std::fs::read_to_string(roots[0].join(new_widget)).unwrap(), "new content\n");
    assert!(!ignored.join("emails/welcome.txt").exists());
    assert!(!roots[0].join(existing_parent).exists());
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
    let roots = vcs::vcs_roots(&host, "main").await.unwrap();
    assert_eq!(roots.len(), 1);
    assert_eq!(roots[0].kind, ide_vcs::VcsKind::Jj);
    assert_eq!(roots[0].branch_root.as_ref(), root);
    assert!(!roots[0].shallow);
    assert!(roots[0].has_remotes.is_none());
    assert!(roots[0].unavailable_reason.is_some());
    assert!(!ide_host::ops::project::info(&project).is_git);
    assert!(project.with_repo_at(Some(&root), |r| r.stage(std::slice::from_ref(&file))).is_err());
    let patch = "diff --git a/keep.txt b/keep.txt\n--- a/keep.txt\n+++ b/keep.txt\n@@ -1 +1 @@\n-keep\n+changed\n";
    assert!(vcs::vcs_apply_patch(&host, "main", Some(root.clone()), patch.into(), None).await.is_err());
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
    let roots = vcs::vcs_roots(&host, "main").await.unwrap();
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
        .await
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
    let roots = vcs::vcs_roots(&host, "main").await.unwrap();
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

/// The Changes view also lists attached projects' repositories, and their untracked files
/// offer Add to .gitignore / .git/info/exclude: the guard must follow the window's
/// repository set, not the project folder alone.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_to_ignore_accepts_the_repositories_of_attached_projects() {
    let temp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(temp.path()).unwrap();
    let project_root = base.join("project");
    let attached_root = base.join("attached");
    for root in [&project_root, &attached_root] {
        std::fs::create_dir_all(root).unwrap();
        git(root, &["init", "-b", "main"]);
        git(root, &["config", "user.name", "Test"]);
        git(root, &["config", "user.email", "test@example.com"]);
        git(root, &["config", "core.autocrlf", "false"]);
        std::fs::write(root.join("tracked.txt"), "x\n").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-m", "initial"]);
    }
    // Untracked files, one per repository; the attached one is what failed.
    let own = project_root.join("own.ignore-me");
    let attached = attached_root.join("attached.ignore-me");
    std::fs::write(&own, "x").unwrap();
    std::fs::write(&attached, "x").unwrap();

    let host = Host::new(common::host_config(&base));
    host.trust.decide(&project_root, true, false).unwrap();
    host.trust.decide(&attached_root, true, false).unwrap();
    let project = host.open_project("main", &project_root).unwrap();
    ide_host::ops::project::attach_workspace(&host, "main", &attached_root).unwrap();
    for _ in 0..500 {
        if project.repos().all().len() == 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(project.repos().all().len(), 2);

    vcs::vcs_add_to_ignore(&host, "main", vec![attached.clone()], ide_vcs::IgnoreDestination::Gitignore).await.unwrap();
    assert!(
        std::fs::read_to_string(attached_root.join(".gitignore")).unwrap().contains("/attached.ignore-me"),
        "the attached repository's .gitignore did not receive the rule"
    );
    vcs::vcs_add_to_ignore(&host, "main", vec![own.clone()], ide_vcs::IgnoreDestination::LocalExclude).await.unwrap();
    assert!(
        std::fs::read_to_string(project_root.join(".git/info/exclude")).unwrap().contains("/own.ignore-me"),
        "the project repository's exclude did not receive the rule"
    );

    // A repository of an unattached sibling folder stays outside.
    let sibling_root = base.join("sibling");
    std::fs::create_dir_all(&sibling_root).unwrap();
    git(&sibling_root, &["init", "-b", "main"]);
    let sibling = sibling_root.join("sibling.ignore-me");
    std::fs::write(&sibling, "x").unwrap();
    let error =
        vcs::vcs_add_to_ignore(&host, "main", vec![sibling], ide_vcs::IgnoreDestination::Gitignore).await.unwrap_err();
    assert!(error.message.contains("outside the project"), "{error:?}");
    assert!(!sibling_root.join(".gitignore").exists());
    host.close_project("main");
}
