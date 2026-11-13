import { beforeEach, expect, it } from "vitest";
import { diffWindowData } from "../DiffWindow";
import { useVcs } from "../store";
import type { DiffLaunch } from "@/bindings";

beforeEach(() => {
  useVcs.setState({ roots: ["/project"], kinds: { "/project": "git", "/project/jj": "jj" } });
});

it("retains the no-Git-Blame sentinel when native IPC omits a null jj target", () => {
  const launch: DiffLaunch = {
    path: "/project/jj/conflicted",
    left: { type: "text", text: "base", label: "Conflict base" },
    right: { type: "worktree", label: "Working copy @" },
  };
  const diff = diffWindowData(launch);
  expect(diff.left).toMatchObject({ jjBlame: null });
  expect(diff.right).toMatchObject({ jjBlame: null });
  expect(diffWindowData({ ...launch, path: "/project/git-file" }).right).not.toHaveProperty("jjBlame");
});

it("keeps an exact jj snapshot and absent side through launch conversion", () => {
  const target = { root: "/project/jj", path: "/project/jj/deleted", commit: "immutable" };
  const diff = diffWindowData({
    path: target.path,
    left: { type: "text", text: "old", label: "Parent", jjBlame: target },
    right: { type: "text", text: "", label: "Deleted", absent: true },
  });
  expect(diff.left).toMatchObject({ jjBlame: target });
  expect(diff.right).toMatchObject({ absent: true, jjBlame: null });
});
