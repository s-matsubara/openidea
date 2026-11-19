import { expect, it } from "vitest";
import { jjFileDiffData, jjWorkingDiffData } from "../jjDiffInput";
import { oneSided } from "../diffInput";
import type { JjFileDiff } from "@/bindings";

const pair: JjFileDiff = { before: "", after: "", beforeLabel: "Parent", afterLabel: "@" };

it("distinguishes absent jj snapshots from empty existing files", () => {
  expect(oneSided(jjFileDiffData("/jj/empty", pair))).toBe(false);
  const added = { ...pair, beforeAbsent: true, afterAbsent: false };
  expect(oneSided(jjFileDiffData("/jj/added", added))).toBe(true);
  expect(oneSided(jjWorkingDiffData("/jj/added", added))).toBe(true);
  const deleted = { ...pair, beforeAbsent: false, afterAbsent: true };
  expect(oneSided(jjWorkingDiffData("/jj/deleted", deleted, true))).toBe(true);
});

it("keeps jj revision identities and read-only text on one-sided history diffs", () => {
  const target = { root: "/jj", path: "/jj/deleted", commit: "exact-commit" };
  const diff = jjFileDiffData("/jj/deleted", { ...pair, before: "old", beforeBlame: target, afterAbsent: true });
  expect(diff.left).toMatchObject({ type: "text", text: "old", jjBlame: target });
  expect(diff.right).toMatchObject({ type: "text", absent: true });
});
