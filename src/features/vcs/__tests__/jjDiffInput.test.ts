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

it("routes pinned jj image snapshots and absent sides to the shared image reader without Git", async () => {
  const { imageDiffKind, readImageSide } = await import("../imageDiffInput");
  const beforeImage = "data:image/png;base64,iVBORw0KGgo=";
  const afterImage = "data:image/png;base64,iVBORw0KGgoAAA==";
  const images = { ...pair, beforeImage, afterImage };
  const data = jjFileDiffData("/jj/image.png", images);
  expect(
    imageDiffKind(jjFileDiffData("/jj/renamed.svg", { ...images, afterImage: "data:image/svg+xml;base64,PHN2Zy8+" })),
  ).toBe("raster");
  expect(imageDiffKind(data)).toBe("raster");
  expect(await readImageSide(data.path, data.left)).toBe(beforeImage);
  expect(await readImageSide(data.path, data.right)).toBe(afterImage);
  const removed = jjWorkingDiffData(data.path, { ...images, afterImage: undefined, afterAbsent: true }, true);
  expect(imageDiffKind(removed)).toBe("raster");
  expect(await readImageSide(removed.path, removed.right)).toBeNull();
  expect(jjWorkingDiffData(data.path, images).right.type).toBe("worktree");
  expect(
    imageDiffKind(
      jjFileDiffData("/jj/icon.svg", { ...pair, beforeImage: "data:image/svg+xml;base64,PHN2Zy8+", afterAbsent: true }),
    ),
  ).toBe("svg");
});
