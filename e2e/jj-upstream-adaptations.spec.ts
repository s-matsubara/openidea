import type { EditorView } from "@codemirror/view";
import type { Page } from "@playwright/test";
import type { FileStatus, JjFileDiff, LineHunk, VcsRoot } from "../src/bindings";
import { expect, ipcCalls, openFromTree, stubDesktop, test } from "./fixtures";

const ROOT = "/dev/acme-api";
const COMMIT = "1111111111111111111111111111111111111111";
const README = `${ROOT}/README.md`;
const DELETED = `${ROOT}/obsolete.md`;

async function stubJj(page: Page) {
  await stubDesktop(page);
  await page.evaluate(
    async ({ root, commit, readme, deleted }) => {
      const files: FileStatus[] = [
        { path: readme, relPath: "README.md", staged: null, unstaged: "modified", renamedFrom: null },
        { path: deleted, relPath: "obsolete.md", staged: null, unstaged: "deleted", renamedFrom: null },
      ];
      const h = window.__ipc.handlers;
      h.menu_configure = () => null;
      const before = "# Acme API\nPrevious instructions\n";
      const after = "# Acme API\nUpdated instructions\n";
      const backend = "/src/editor/core/backend.ts";
      (await import(/* @vite-ignore */ backend)).docBackend().files.set(readme, after);
      let currentFiles = files;
      h.vcs_roots = (): VcsRoot[] => [
        {
          root,
          branchRoot: root,
          kind: "jj",
          head: "main",
          headCommit: commit,
          operation: null,
          workingCopy: {
            changeId: "qrstuvwx",
            commitId: commit,
            description: "Update documentation",
            files: currentFiles,
          },
          unavailableReason: null,
        },
      ];
      h.finish_readme_change = () => {
        currentFiles = files.filter((file) => file.path !== readme);
        window.__ipc.emit({ type: "vcsChanged", root });
      };
      h.vcs_jj_file_diff = ({ path, commit: revision }): JjFileDiff => {
        if (revision !== commit || !files.some((f) => f.path === path))
          throw new Error("Unexpected jj revision or path");
        return path === deleted
          ? {
              before: "Obsolete instructions\n",
              after: "",
              afterAbsent: true,
              beforeLabel: "Parent",
              afterLabel: "Working copy @",
            }
          : {
              before,
              after,
              beforeLabel: "Parent",
              afterLabel: "Working copy @",
            };
      };
      h.vcs_jj_history_file_diff = (args) => {
        if (args.root !== root) throw new Error("Unexpected jj root");
        return h.vcs_jj_file_diff!(args);
      };
      h.fs_probe = ({ path }) => (path === readme ? { size: 11, binary: false, tooLarge: false } : null);
      h.fs_read_text = ({ path }) => (path === readme ? after : "");
      h.vcs_line_hunks = ({ path }): LineHunk[] =>
        path === readme
          ? [{ kind: "modified", start: 1, lines: 1, oldStart: 1, oldLines: 1, oldText: "Previous instructions\n" }]
          : [];
      const vcs = "/src/features/vcs/store.ts";
      const { useVcs, discoverRoots } = await import(/* @vite-ignore */ vcs);
      useVcs.setState({ available: false });
      await discoverRoots();
    },
    { root: ROOT, commit: COMMIT, readme: README, deleted: DELETED },
  );
}

test("opens modified and deleted jj files in the same diff", async ({ workbench: page }, testInfo) => {
  await stubJj(page);
  await page.evaluate(async () => {
    const layout = "/src/workbench/toolwindows/store.ts";
    (await import(/* @vite-ignore */ layout)).showToolWindow("commit", true);
  });
  const changes = page.getByRole("tree", { name: "Working-copy changes" });
  const file = changes.getByText("README.md", { exact: true });
  await expect(file).toBeVisible();
  await file.dblclick();
  const singleDiff = page.getByRole("toolbar", { name: "Diff", exact: true });
  await expect(singleDiff).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("jj-before-combined-diff.png"), animations: "disabled" });
  await singleDiff.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByText("Show All Files in One Diff View", { exact: true }).click();

  await expect(page.getByRole("toolbar", { name: "Combined Changes Diff" })).toContainText("2 files");
  const modified = page.locator(`[data-combined-block="${README}"]`);
  const deleted = page.locator(`[data-combined-block="${DELETED}"]`);
  await expect(modified.getByText("Previous instructions", { exact: true })).toBeVisible();
  await expect(deleted.getByText("Obsolete instructions", { exact: true })).toBeVisible();
  expect(await ipcCalls(page, "vcs_jj_file_diff")).toContainEqual({ path: README, commit: COMMIT });
  expect(await ipcCalls(page, "vcs_jj_history_file_diff")).toContainEqual({
    root: ROOT,
    path: DELETED,
    commit: COMMIT,
  });
  await page.screenshot({ path: testInfo.outputPath("jj-all-files-diff.png"), animations: "disabled" });
});

test("opens a jj working-copy diff from the selected changed line", async ({ workbench: page }, testInfo) => {
  await stubJj(page);
  const editor = await openFromTree(page, "README.md");
  await editor.locator(".cm-content").evaluate((content) => {
    const { view } = (content as HTMLElement & { cmTile: { view: EditorView } }).cmTile;
    const line = view.state.doc.line(2);
    view.dispatch({ selection: { anchor: line.from, head: line.to } });
    view.focus();
  });
  const selectedLineDiffEnabled = () =>
    page.evaluate(async () => {
      const actions = "/src/platform/actions.ts";
      const { getAction, isActionEnabled } = await import(/* @vite-ignore */ actions);
      const show = getAction("vcs.showDiffForLines");
      return !!show && isActionEnabled(show);
    });
  await expect.poll(selectedLineDiffEnabled).toBe(true);
  await page.keyboard.press("Meta+Shift+A");
  const query = page.getByRole("combobox", { name: "Search query" });
  await query.fill("Show Diff for Lines");
  await expect(page.locator("#se-results")).toContainText("Show Diff for Lines");
  await query.press("Enter");

  await expect(page.getByRole("toolbar", { name: "Diff", exact: true })).toBeVisible();
  await expect(page.getByText("Previous instructions", { exact: true })).toBeVisible();
  const right = page.locator(".cm-merge-b .cm-content");
  await expect
    .poll(() =>
      right.evaluate((content) => {
        const { state } = (content as HTMLElement & { cmTile: { view: EditorView } }).cmTile.view;
        return state.doc.lineAt(state.selection.main.head).text;
      }),
    )
    .toBe("Updated instructions");
  expect(await ipcCalls(page, "vcs_jj_file_diff")).toEqual(expect.arrayContaining([{ path: README, commit: COMMIT }]));
  expect(await ipcCalls(page, "vcs_file_at")).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("jj-selected-line-diff.png"), animations: "disabled" });
});

test("updates the jj project root's changed-file count after a VCS refresh", async ({ workbench: page }, testInfo) => {
  await stubJj(page);
  const project = page.getByRole("tree", { name: "Project", exact: true });
  const root = project.getByRole("treeitem", { name: /acme-api/ });
  await expect(root.getByRole("img", { name: "2 changed files", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("jj-project-change-count.png"), animations: "disabled" });

  await page.evaluate(() => window.__ipc.handlers.finish_readme_change!({}));
  await expect(root.getByRole("img", { name: "1 changed files", exact: true })).toBeVisible();
});

test("changes jj annotate name format through its gutter menu", async ({ workbench: page }, testInfo) => {
  await stubJj(page);
  await page.evaluate((commit) => {
    window.__ipc.handlers.vcs_jj_annotate = () =>
      Array.from({ length: 3 }, () => ({
        commit,
        author: "Ada Lovelace",
        timeMs: 1700000000000,
        summary: "Documentation",
        originPath: null,
      }));
  }, COMMIT);
  const editor = await openFromTree(page, "README.md");
  await page.keyboard.press("Meta+Shift+A");
  const query = page.getByRole("combobox", { name: "Search query" });
  await query.fill("Annotate with Jujutsu Blame");
  await expect(page.locator("#se-results")).toContainText("Annotate with Jujutsu Blame");
  await query.press("Enter");
  const gutter = editor.locator(".cm-vcs-blame");
  await expect(gutter).toContainText("Lovelace");
  await query.press("Escape");
  await expect(query).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath("jj-annotate-last-name.png"), animations: "disabled" });
  // Code Vision may have requested its existing Git author hint while opening the file.
  const gitBlameBefore = await ipcCalls(page, "vcs_blame");
  const gitLogBefore = await ipcCalls(page, "vcs_log");
  const jjBefore = (await ipcCalls(page, "vcs_jj_annotate")).length;
  await gutter.locator("[data-commit]:visible").first().click({ button: "right" });
  await page.getByText("Options", { exact: true }).hover();
  await page.getByText("Names", { exact: true }).hover();
  await page.getByText("Initials", { exact: true }).click();
  await expect(gutter).toContainText("AL");
  expect((await ipcCalls(page, "vcs_jj_annotate")).length).toBeGreaterThan(jjBefore);
  expect(await ipcCalls(page, "vcs_blame")).toEqual(gitBlameBefore);
  expect(await ipcCalls(page, "vcs_log")).toEqual(gitLogBefore);
  await page.screenshot({ path: testInfo.outputPath("jj-annotate-initials.png"), animations: "disabled" });
});

test("compares a jj PNG from Working-copy changes without Git revision reads", async ({
  workbench: page,
}, testInfo) => {
  await stubJj(page);
  await page.evaluate(
    async ({ root, commit }) => {
      const canvas = document.createElement("canvas");
      canvas.width = 4;
      canvas.height = 3;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "teal";
      context.fillRect(0, 0, 4, 3);
      const beforeImage = canvas.toDataURL();
      context.clearRect(0, 0, 1, 1);
      const afterImage = canvas.toDataURL();
      const path = root + "/status.png";
      const file = { path, relPath: "status.png", staged: null, unstaged: "modified", renamedFrom: null };
      const h = window.__ipc.handlers;
      h.vcs_roots = () => [
        {
          root,
          branchRoot: root,
          kind: "jj",
          head: "main",
          headCommit: commit,
          operation: null,
          workingCopy: { changeId: "qrstuvwx", commitId: commit, description: "Image change", files: [file] },
          unavailableReason: null,
        },
      ];
      h.vcs_jj_file_diff = (args) => {
        if (args.path !== path || args.commit !== commit) throw new Error("Wrong jj snapshot");
        return { before: "", after: "", beforeImage, afterImage, beforeLabel: "Pinned parent", afterLabel: "Pinned @" };
      };
      h.fs_read_image = () => afterImage;
      const store = "/src/features/vcs/store.ts";
      await (await import(/* @vite-ignore */ store)).discoverRoots();
      const layout = "/src/workbench/toolwindows/store.ts";
      (await import(/* @vite-ignore */ layout)).showToolWindow("commit", true);
    },
    { root: ROOT, commit: COMMIT },
  );
  const row = page.getByRole("tree", { name: "Working-copy changes" }).getByText("status.png", { exact: true });
  await expect(row).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("jj-image-before.png"), animations: "disabled" });
  const gitBefore = await ipcCalls(page, "vcs_image_at");
  const entriesBefore = await ipcCalls(page, "vcs_diff_entries");
  await row.dblclick();
  const toolbar = page.getByRole("toolbar", { name: "Image diff" });
  await expect(toolbar).toBeVisible();
  await toolbar.getByRole("button", { name: "Highlight changed pixels" }).click();
  await expect(page.getByRole("status").filter({ hasText: /^1 changed pixel$/i })).toBeVisible();
  await expect(page.getByLabel("Pixel difference mask")).toBeVisible();
  expect(await ipcCalls(page, "vcs_jj_file_diff")).toContainEqual({ path: ROOT + "/status.png", commit: COMMIT });
  expect(await ipcCalls(page, "vcs_image_at")).toEqual(gitBefore);
  expect(await ipcCalls(page, "vcs_diff_entries")).toEqual(entriesBefore);
  await page.screenshot({ path: testInfo.outputPath("jj-image-after.png"), animations: "disabled" });
});
