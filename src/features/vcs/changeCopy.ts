import { writeClipboardText } from "@/platform/clipboard";
import type { FileStatus } from "@/bindings";
import { basename } from "@/platform/project";

/** Copy each selected path once, preserving tree order. */
export function copyChangedFiles(files: readonly FileStatus[], kind: "absolute" | "name") {
  const paths = [...new Set(files.map((file) => file.path))];
  const text = paths.map((path) => (kind === "name" ? basename(path) : path)).join("\n");
  if (text) void writeClipboardText(text);
}
