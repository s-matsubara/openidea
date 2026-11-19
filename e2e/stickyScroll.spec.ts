import { expect, test } from "./fixtures";

const cases = [
  {
    language: "Rust",
    file: "sticky.rs",
    prefix: "struct Sample<'a, T> { value: &'a T }",
    header: "fn check<'a, T>(item: Sample<'a, T>) {",
    body: "    let _ = &item;",
    role: "rust-parameter",
    iclsKey: "org.rust.PARAMETER",
    token: "item",
  },
  {
    language: "Go",
    file: "sticky.go",
    prefix: "package demo\ntype Sample struct{}",
    header: "func (item *Sample) Check() {",
    body: "    _ = item",
    role: "go-method-receiver",
    iclsKey: "GO_METHOD_RECEIVER",
    token: "item",
  },
];

for (const example of cases) {
  test(`${example.language} sticky scroll keeps imported colors when semantic tokens arrive`, async ({
    workbench: page,
  }, info) => {
    const headerLine = example.prefix.split("\n").length + 1;
    await page.evaluate(
      async ({ example, headerLine }) => {
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
        const scheme = parseIcls(`<scheme name="Sticky" parent_scheme="Darcula"><attributes>
        <option name="${example.iclsKey}"><value><option name="FOREGROUND" value="b7c685"/>
        <option name="FONT_TYPE" value="2"/></value></option>
      </attributes></scheme>`).scheme;
        const previous = useProject.getState().settings ?? {};
        useProject.setState({
          settings: {
            ...previous,
            editor: {
              ...previous.editor,
              stickyScroll: true,
              colorScheme: "custom-sticky",
              customSchemes: { "custom-sticky": scheme },
              semanticHighlighting: false,
            },
          },
        });
        const path = `/dev/acme-api/${example.file}`;
        const backend = docBackend();
        const open = backend.open.bind(backend);
        backend.open = async (path: string) => ({ ...(await open(path)), uiMode: example.language });
        backend.files.set(path, [example.prefix, example.header, ...Array(120).fill(example.body), "}", ""].join("\n"));
        const tokens = new Promise<void>((resolve) => {
          window.addEventListener("test:sticky-semantic-tokens", () => resolve(), { once: true });
        });
        commands.lspSemanticTokens = async () => {
          await tokens;
          return {
            status: "ok",
            data: {
              tokenTypes: ["parameter"],
              tokenModifiers: ["deprecated"],
              data: [headerLine - 1, example.header.indexOf(example.token), example.token.length, 0, 1],
            },
          };
        };
        setInvokeRoute(() => null);
        await editorService().openFile(path);
      },
      { example, headerLine },
    );

    const editor = page.locator(`.cm-editor[data-language="${example.language}"]`);
    const role = `.cm-sem-${example.role}`;
    const bodyToken = editor.locator(".cm-content .cm-line").filter({ hasText: example.header }).locator(role);
    await expect(bodyToken).toHaveText(example.token);
    await expect(bodyToken).toHaveCSS("color", "rgb(183, 198, 133)");
    await expect(bodyToken).toHaveCSS("font-style", "italic");

    await editor.locator(".cm-scroller").evaluate((el) => {
      el.scrollTop = 1500;
    });
    const row = editor.locator(`.cm-openidea-stickyLine[data-line="${headerLine}"]`);
    await expect(row).toBeVisible();
    const pinnedToken = row.locator(role);
    await expect(pinnedToken).toHaveText(example.token);
    await expect(pinnedToken).toHaveCSS("color", "rgb(183, 198, 133)");
    await expect(pinnedToken).toHaveCSS("font-style", "italic");

    await page.evaluate(() => window.dispatchEvent(new Event("test:sticky-semantic-tokens")));
    await expect(row.locator(`${role}.cm-sem-deprecated`)).toHaveCSS("text-decoration-line", "line-through");
    await expect(pinnedToken).toHaveCSS("color", "rgb(183, 198, 133)");
    await row.screenshot({ path: info.outputPath("sticky-scroll.png"), animations: "disabled" });
  });
}
