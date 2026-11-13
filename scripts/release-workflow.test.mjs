import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
// Run the actual inline scripts, without third-party actions or network requests.
function block(marker, key = "script") {
  const start = workflow.indexOf(marker);
  assert.ok(start >= 0, marker);
  const lines = workflow.slice(start).split("\n");
  const index = lines.findIndex((line) => line.trim() === `${key}: |`);
  assert.ok(index >= 0, `${marker}: ${key}`);
  const indent = lines[index].search(/\S/) + 2;
  const result = [];
  for (const line of lines.slice(index + 1)) {
    if (line.trim() && line.search(/\S/) < indent) break;
    result.push(line.slice(indent));
  }
  return result.join("\n");
}
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const scripts = Object.fromEntries(
  [
    ["target", "- id: target"],
    ["create", "- id: release"],
    ["guard", "- &owned-draft"],
  ].map(([name, marker]) => [name, new AsyncFunction("github", "context", "core", "process", block(marker))]),
);
const sha = "a".repeat(40);
const tag = "v2026.2.11";
const marker = `<!-- openidea-release:42:${sha} -->`;
function fixture(options = {}) {
  const outputs = {};
  const writes = [];
  const context = {
    eventName: "workflow_dispatch",
    ref: "refs/heads/main",
    repo: { owner: "s-matsubara", repo: "openidea" },
    runId: 42,
    ...options.context,
  };
  const env = { TAG: tag, COMMIT_SHA: sha, RELEASE_ID: "123", ...options.env };
  const release = { id: 123, tag_name: tag, draft: true, body: marker, ...options.release };
  const github = {
    paginate: async () => options.existing ?? [],
    rest: {
      git: {
        getRef: async (params) => {
          assert.equal(params.ref, `tags/${env.TAG}`);
          if (options.missing) throw new Error("404 missing tag");
          return { data: { object: options.object ?? { type: "commit", sha } } };
        },
        getTag: async () => ({ data: { object: options.nested ?? { type: "commit", sha } } }),
      },
      repos: {
        compareCommitsWithBasehead: async () => ({ data: { merge_base_commit: { sha: options.base ?? sha } } }),
        listReleases: () => {},
        createRelease: async (params) => {
          writes.push(params);
          return { data: { id: 123 } };
        },
        getRelease: async () => ({ data: release }),
      },
    },
  };
  const core = {
    setOutput: (name, value) => {
      outputs[name] = value;
    },
  };
  return { outputs, writes, release, run: (name) => scripts[name](github, context, core, { env }) };
}

test("main dispatch resolves lightweight and annotated tags without writing", async () => {
  for (const options of [{}, { object: { type: "tag", sha: "b".repeat(40) } }]) {
    const f = fixture(options);
    await f.run("target");
    assert.equal(f.outputs.sha, sha);
    assert.deepEqual(f.writes, []);
  }
});
for (const [name, options] of Object.entries({
  branch: { context: { ref: "refs/heads/feature" } },
  "tag ref": { context: { ref: `refs/tags/${tag}` } },
  "push event": { context: { eventName: "push" } },
  "other repository": { context: { repo: { owner: "other", repo: "openidea" } } },
  "missing tag": { missing: true },
  "unmerged tag": { base: "b".repeat(40) },
  "tree target": { object: { type: "tree", sha } },
  "annotation loop": { object: { type: "tag", sha }, nested: { type: "tag", sha } },
}))
  test(`rejects ${name} before creating a release`, async () => {
    const f = fixture(options);
    await assert.rejects(f.run("target"));
    assert.deepEqual(f.writes, []);
  });
for (const value of [
  "",
  "main",
  "refs/tags/v2026.2.11",
  "v0.1.43",
  "v2026.02.11",
  "v2026.2.11-rc1",
  "v2026.2.11\n",
  "v2026.2.11;echo bad",
]) {
  test(`rejects invalid input ${JSON.stringify(value)}`, async () => {
    const f = fixture({ env: { TAG: value } });
    await assert.rejects(f.run("target"));
    assert.deepEqual(f.writes, []);
  });
}

test("new draft is owned by the run and only that same run can resume it", async () => {
  const f = fixture();
  await f.run("create");
  assert.equal(f.outputs.id, 123);
  assert.equal(f.writes[0].body, marker);
  assert.equal(f.writes[0].draft, true);
  assert.equal(f.writes[0].target_commitish, sha);
  const retry = fixture({ existing: [f.release] });
  await retry.run("create");
  assert.equal(retry.outputs.id, 123);
  assert.deepEqual(retry.writes, []);
});
for (const release of [{ draft: false }, { body: "" }, { body: marker.replace(":42:", ":43:") }])
  test(`refuses to adopt existing release ${JSON.stringify(release)}`, async () => {
    const f = fixture({ existing: [{ id: 123, tag_name: tag, draft: true, body: marker, ...release }] });
    await assert.rejects(f.run("create"));
    assert.deepEqual(f.writes, []);
    assert.equal(f.outputs.id, undefined);
  });

test("upload/publish guard permits only the owned draft with the unchanged target", async () => {
  await fixture().run("guard");
  await fixture({ object: { type: "tag", sha: "b".repeat(40) } }).run("guard");
  for (const options of [
    { release: { draft: false } },
    { release: { tag_name: "v2026.2.9" } },
    { release: { body: "" } },
    { release: { body: marker.replace(":42:", ":43:") } },
    { object: { type: "commit", sha: "b".repeat(40) } },
    { missing: true },
  ]) {
    await assert.rejects(fixture(options).run("guard"));
  }
});

test("all app manifests must match the tag before release creation", () => {
  const dir = mkdtempSync(join(tmpdir(), "release-policy-"));
  try {
    mkdirSync(join(dir, "src-tauri"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "2026.2.11" }));
    writeFileSync(join(dir, "src-tauri/tauri.conf.json"), JSON.stringify({ version: "2026.2.11" }));
    writeFileSync(join(dir, "Cargo.toml"), '[workspace.package]\nversion = "2026.2.11"\n');
    const run = () =>
      spawnSync("bash", ["-c", block("- name: Tag matches app versions", "run")], {
        cwd: dir,
        env: { ...process.env, TAG: tag },
        encoding: "utf8",
      });
    assert.equal(run().status, 0);
    for (const file of ["package.json", "src-tauri/tauri.conf.json", "Cargo.toml"]) {
      const path = join(dir, file);
      const original = readFileSync(path, "utf8");
      writeFileSync(path, original.replaceAll("2026.2.11", "2026.2.12"));
      assert.notEqual(run().status, 0, file);
      writeFileSync(path, original);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
