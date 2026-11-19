import { expect, it, vi } from "vitest";
import type { FileStatus } from "@/bindings";

const native = vi.hoisted(() => ({ write: vi.fn(), call: vi.fn(async () => undefined) }));
vi.mock("@/platform/ipc", async (original) => {
  const actual = await original<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    isTauri: () => true,
    call: native.call,
    commands: { ...actual.commands, clipboardWriteText: native.write },
  };
});
import { copyChangedFiles } from "../changeCopy";

it("copies jj selections through the native clipboard, preserving order and deduplicating paths", () => {
  const files = ["/p/first.ts", "/p/other.ts", "/p/first.ts"].map((path) => ({ path }) as FileStatus);
  copyChangedFiles(files, "absolute");
  expect(native.write).toHaveBeenLastCalledWith("/p/first.ts\n/p/other.ts");
  copyChangedFiles(files, "name");
  expect(native.write).toHaveBeenLastCalledWith("first.ts\nother.ts");
  expect(native.call).toHaveBeenCalledTimes(2);
});
