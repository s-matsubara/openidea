/** Parse jj's documented diff/snapshot materialization without rewriting the document. */
import { parseConflicts, type ConflictBlock } from "./conflicts";

export type ResultConflict = Pick<ConflictBlock, "from" | "to" | "ours" | "base" | "theirs">;

export function jjConflicts(text: string): ResultConflict[] {
  const blocks: ResultConflict[] = parseConflicts(text).map((block) => {
    if (text.slice(block.from, block.to).endsWith("\n")) return block;
    const trim = (s: string) => s.replace(/\n$/, "");
    return {
      ...block,
      ours: trim(block.ours),
      base: block.base === null ? null : trim(block.base),
      theirs: trim(block.theirs),
    };
  });
  const lines = [...text.matchAll(/[^\n]*\n|[^\n]+$/g)];
  for (let i = 0; i < lines.length; i++) {
    const start = /^(<{7,}) conflict \d+ of \d+/.exec(lines[i]![0]);
    if (!start) continue;
    const width = start[1]!.length;
    const marker = (line: string, char: string) =>
      line.startsWith(char.repeat(width)) && /^[ \r\n]|^$/.test(line.slice(width));
    let end = i + 1;
    while (end < lines.length && !marker(lines[end]![0], ">")) end++;
    if (end === lines.length) continue;
    const sides: string[] = [];
    let base: string | null = null;
    let valid = true;
    for (let j = i + 1; j < end;) {
      const header = lines[j]![0];
      const diff = marker(header, "%");
      const snapshot = marker(header, "+");
      const ancestor = marker(header, "-");
      if (!diff && !snapshot && !ancestor) {
        valid = false;
        break;
      }
      j++;
      if (diff && j < end && marker(lines[j]![0], "\\")) j++;
      let content = "";
      let old = "";
      for (; j < end; j++) {
        const line = lines[j]![0];
        if (["%", "+", "-"].some((m) => marker(line, m))) break;
        if (diff) {
          if (line[0] === " " || line[0] === "-") old += line.slice(1);
          if (line[0] === " " || line[0] === "+") content += line.slice(1);
          if (![" ", "-", "+"].includes(line[0]!)) valid = false;
        } else content += line;
      }
      if (diff) {
        base = old;
        sides.push(content);
      } else if (ancestor) base = content;
      else sides.push(content);
    }
    if (valid && sides.length === 2 && base !== null) {
      // jj adds one newline to every term when its final marker has no newline.
      const trim = (s: string) => (lines[end]![0].endsWith("\n") ? s : s.replace(/\n$/, ""));
      blocks.push({
        from: lines[i]!.index!,
        to: lines[end]!.index! + lines[end]![0].length,
        ours: trim(sides[0]!),
        base: trim(base),
        theirs: trim(sides[1]!),
      });
    }
    i = end;
  }
  return blocks.sort((a, b) => a.from - b.from);
}
