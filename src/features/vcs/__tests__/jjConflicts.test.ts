import { expect, it } from "vitest";
import { jjConflicts } from "../jjConflicts";

const diff = `<<<<<<< conflict 1 of 1
%%%%%%% base to left
\\\\\\\\\\\\\\ to left
 common
-old
+left
+++++++ right
right
>>>>>>> conflict 1 of 1 ends
`;
it("reads real default diff markers, including common lines in the diff", () => {
  expect(jjConflicts(diff)).toEqual([
    { from: 0, to: diff.length, ours: "common\nleft\n", base: "common\nold\n", theirs: "right\n" },
  ]);
});
it("supports snapshot style and extended marker widths without treating embedded separators as markers", () => {
  const raw = `<<<<<<<<<<<<<<< conflict 1 of 1
+++++++++++++++ left
left
=======
--------------- base
base
+++++++++++++++ right
right
>>>>>>>>>>>>>>> conflict 1 of 1 ends
`;
  expect(jjConflicts(raw)[0]).toMatchObject({ ours: "left\n=======\n", base: "base\n", theirs: "right\n" });
});
it("supports long Git diff3 markers and missing final newline semantics", () => {
  const raw = "<<<<<<<<<<<<<<< left\nleft\n||||||||||||||| base\nbase\n===============\nright\n>>>>>>>>>>>>>>> right\n";
  expect(jjConflicts(raw)[0]).toMatchObject({ ours: "left\n", base: "base\n", theirs: "right\n" });
  expect(jjConflicts(diff.trimEnd())[0]).toMatchObject({ ours: "common\nleft", base: "common\nold", theirs: "right" });
});
it("leaves malformed or unsupported multiple-side blocks without destructive actions", () => {
  expect(jjConflicts(diff.replace("-old\n", "unexpected\n"))).toEqual([]);
  expect(jjConflicts(diff.replace(">>>>>>>", "+++++++ third\nthird\n>>>>>>>"))).toEqual([]);
});
