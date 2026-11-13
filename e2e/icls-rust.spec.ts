import { readFileSync } from "node:fs";
import { expect, test } from "./fixtures";

const xml = process.env.OPENIDEA_RUST_ICLS_FIXTURE
  ? readFileSync(process.env.OPENIDEA_RUST_ICLS_FIXTURE, "utf8")
  : `<scheme name="Iceberg Rust" parent_scheme="Darcula"><attributes>
      <option name="org.rust.STRUCT"><value><option name="FOREGROUND" value="6fafbd"/></value></option>
      <option name="org.rust.TYPE_PARAMETER"><value><option name="FOREGROUND" value="b7c685"/></value></option>
      <option name="org.rust.LIFETIME"><value><option name="FOREGROUND" value="b7c685"/><option name="FONT_TYPE" value="2"/></value></option>
      <option name="org.rust.MACRO"><value><option name="FOREGROUND" value="e2a478"/></value></option>
      <option name="org.rust.FIELD"><value><option name="FOREGROUND" value="ada0d3"/><option name="FONT_TYPE" value="2"/></value></option>
    </attributes></scheme>`;

test("ICLS applies Rust colours with and without rust-analyzer tokens", async ({ workbench: page }, info) => {
  await page.evaluate(async (xml) => {
    const iclsPath = "/src/platform/icls.ts";
    const projectPath = "/src/platform/project.ts";
    const backendPath = "/src/editor/core/backend.ts";
    const contributionsPath = "/src/workbench/contributions.ts";
    const ipcPath = "/src/platform/ipc.ts";
    const routePath = "/src/platform/tauriCore.ts";
    const { parseIcls } = await import(iclsPath);
    const { useProject } = await import(projectPath);
    const { docBackend } = await import(backendPath);
    const { editorService } = await import(contributionsPath);
    const { commands } = await import(ipcPath);
    const { setInvokeRoute } = await import(routePath);
    const previous = useProject.getState().settings ?? {};
    useProject.setState({
      settings: {
        ...previous,
        editor: {
          ...previous.editor,
          colorScheme: "custom-rust",
          customSchemes: { "custom-rust": parseIcls(xml).scheme },
          semanticHighlighting: false,
        },
      },
    });
    const backend = docBackend();
    backend.files.set(
      "/dev/acme-api/palette.rs",
      "struct Sample<'a, T> { value: &'a T }\nfn check<'a, T>(item: Sample<'a, T>) { assert!(true); }\n",
    );
    const tokens = new Promise<void>((resolve) => {
      window.addEventListener("test:rust-semantic-tokens", () => resolve(), { once: true });
    });
    commands.lspSemanticTokens = async () => {
      await tokens;
      return {
        status: "ok",
        data: {
          tokenTypes: ["struct", "typeParameter", "macro"],
          tokenModifiers: ["defaultLibrary"],
          data: [1, 22, 6, 0, 0, 1, 33, 1, 1, 0, 1, 39, 6, 2, 1],
        },
      };
    };
    setInvokeRoute(() => null);
    await editorService().openFile("/dev/acme-api/palette.rs");
  }, xml);
  const rust = page.locator('.cm-editor[data-language="Rust"]');
  await expect(rust.locator(".cm-sem-rust-struct").first()).toHaveCSS("color", "rgb(111, 175, 189)");
  await expect(rust.locator(".cm-sem-rust-field")).toHaveCSS("font-style", "italic");
  await expect(rust.locator(".cm-sem-rust-lifetime").first()).toHaveCSS("color", "rgb(183, 198, 133)");
  await expect(rust.locator(".cm-sem-rust-lifetime").first()).toHaveCSS("font-style", "italic");
  await expect(rust.locator(".cm-sem-rust-macro")).toHaveCSS("color", "rgb(226, 164, 120)");
  await page.evaluate(() => window.dispatchEvent(new Event("test:rust-semantic-tokens")));
  await expect(rust.locator(".cm-sem-rust-struct.cm-sem-type")).toHaveText("Sample");
  await expect(rust.locator(".cm-sem-rust-struct.cm-sem-type")).toHaveCSS("color", "rgb(111, 175, 189)");
  await expect(rust.locator(".cm-sem-rust-type-parameter.cm-sem-typeParameter")).toHaveText("T");
  await expect(rust.locator(".cm-sem-rust-type-parameter.cm-sem-typeParameter")).toHaveCSS(
    "color",
    "rgb(183, 198, 133)",
  );
  await expect(rust.locator(".cm-sem-rust-macro.cm-sem-builtin")).toHaveCSS("color", "rgb(226, 164, 120)");
  await rust.screenshot({ path: info.outputPath("rust-icls.png"), animations: "disabled" });
});
