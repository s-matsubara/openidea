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
