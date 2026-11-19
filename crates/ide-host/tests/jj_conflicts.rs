//! Conflict reads must reach the real host IPC operation for the owning VCS root.
use ide_core::NullSink;
use ide_host::{Host, HostConfig, ops::vcs};
use std::{path::Path, process::Command, sync::Arc, time::Duration};

fn git(root: &Path, args: &[&str]) {
    let out = Command::new("git").current_dir(root).args(["-c", "commit.gpgsign=false"]).args(args).output().unwrap();
    assert!(out.status.success(), "{args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

fn utf16(text: &str) -> Vec<u8> {
    [vec![0xff, 0xfe], text.encode_utf16().flat_map(u16::to_le_bytes).collect()].concat()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn conflict_versions_routes_real_host_reads_by_kind_trust_and_innermost_root() {
    let Some(exe) = ide_vcs::detected_jj_executable() else { return };
    let temp = tempfile::tempdir().unwrap();
    let base = dunce::canonicalize(temp.path()).unwrap();
    let root = base.join("project");
    std::fs::create_dir_all(&root).unwrap();
    git(&root, &["init", "-b", "main"]);
    git(&root, &["config", "user.name", "Test"]);
    git(&root, &["config", "user.email", "test@example.com"]);
    let git_path = root.join("same.txt");
    std::fs::write(&git_path, utf16("base 日本語\n")).unwrap();
    git(&root, &["add", "same.txt"]);
    git(&root, &["commit", "-m", "base"]);
    git(&root, &["checkout", "-b", "incoming"]);
    std::fs::write(&git_path, utf16("theirs 日本語\n")).unwrap();
    git(&root, &["commit", "-am", "theirs"]);
    git(&root, &["checkout", "main"]);
    std::fs::write(&git_path, utf16("ours 日本語\n")).unwrap();
    git(&root, &["commit", "-am", "ours"]);
    let merge = Command::new("git").current_dir(&root).args(["merge", "incoming"]).output().unwrap();
    assert!(!merge.status.success());
    let nested = root.join("nested");
    let deeper = nested.join("deeper");
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
        assert!(out.status.success(), "{args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8(out.stdout).unwrap().trim().to_owned()
    };
    for (at, label) in [(&nested, "nested"), (&deeper, "deeper")] {
        std::fs::create_dir_all(at).unwrap();
        jj(at, &["git", "init"]);
        std::fs::write(at.join("same.txt"), format!("{label} base\n")).unwrap();
        jj(at, &["new"]);
        std::fs::write(at.join("same.txt"), format!("{label} ours\n")).unwrap();
        jj(at, &["describe", "-m", "left"]);
        let left = jj(at, &["log", "--no-graph", "-r", "@", "-T", "commit_id"]);
        jj(at, &["new", "@-", "-m", "right"]);
        std::fs::write(at.join("same.txt"), format!("{label} theirs\n")).unwrap();
        jj(at, &["new", &left, "@"]);
        // Empty child inherits the parent's conflict, just like the user's project.
        jj(at, &["new"]);
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
    let project = host.open_project("main", &root).unwrap();
    for _ in 0..500 {
        if project.repos().all().len() == 3 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(project.repos().all().len(), 3);
    project.settings.set(ide_workspace::SettingsScope::Project, "vcs.jj.executable", serde_json::json!(exe)).unwrap();
    // Restricted Git reads retain their existing safe in-process/host-owned preview path.
    let control = vcs::vcs_conflict_versions(&host, "main", git_path.clone()).await.unwrap();
    assert_eq!(control.base.as_deref(), Some("base 日本語\n"));
    assert_eq!(control.ours.as_deref(), Some("ours 日本語\n"));
    assert_eq!(control.theirs.as_deref(), Some("theirs 日本語\n"));
    let before = std::fs::read(nested.join("same.txt")).unwrap();
    let error = vcs::vcs_conflict_versions(&host, "main", nested.join("same.txt")).await.unwrap_err().to_string();
    assert!(error.contains("Restricted Mode"), "{error}");
    assert_eq!(std::fs::read(nested.join("same.txt")).unwrap(), before);
    host.set_project_trust(&root, true, false).await.unwrap();
    for (at, label) in [(&nested, "nested"), (&deeper, "deeper")] {
        let path = at.join("same.txt");
        let disk = std::fs::read(&path).unwrap();
        let versions = vcs::vcs_conflict_versions(&host, "main", path.clone()).await.unwrap();
        assert_eq!(versions.base, Some(format!("{label} base\n")));
        assert_eq!(versions.ours, Some(format!("{label} ours\n")));
        assert_eq!(versions.theirs, Some(format!("{label} theirs\n")));
        assert!(versions.merged.unwrap().contains("|||||||"));
        assert_eq!(std::fs::read(&path).unwrap(), disk, "opening a merge editor must not write");
        assert!(vcs::vcs_stage(&host, "main", vec![path]).await.is_err(), "Git staging must stay disabled");
    }
    let control_trusted = vcs::vcs_conflict_versions(&host, "main", git_path.clone()).await.unwrap();
    assert_eq!(control_trusted.ours, control.ours);
    assert_eq!(control_trusted.theirs, control.theirs);
    assert!(vcs::vcs_conflict_versions(&host, "main", base.join("outside.txt")).await.is_err());
    project
        .settings
        .set(ide_workspace::SettingsScope::Project, "vcs.jj.executable", serde_json::json!(base.join("missing-jj")))
        .unwrap();
    let error = vcs::vcs_conflict_versions(&host, "main", deeper.join("same.txt")).await.unwrap_err().to_string();
    assert!(error.contains("cannot run"), "configured executable must be used: {error}");
    host.close_project("main");
}
