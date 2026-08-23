import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { Markdown, plainText, sanitizeTerminalText } from "../src/ui/markdown.js";
import { resolveTheme } from "../src/ui/theme.js";
import { marked } from "marked";

const theme = resolveTheme({ ALFACODE_THEME: "dark" });

describe("terminal markdown", () => {
  it("renders rich GFM structures as native terminal content", () => {
    const markdown = [
      "# Result",
      "",
      "> **Safe** output",
      "",
      "- [x] tools",
      "- [ ] polish",
      "",
      "| Provider | Ready |",
      "| --- | --- |",
      "| Zen | yes |",
      "",
      "```ts",
      "const name = 'AlfaCode';",
      "```",
    ].join("\n");
    const view = render(<Markdown theme={theme} width={72}>{markdown}</Markdown>);
    const frame = view.lastFrame();
    expect(frame).toContain("◆ Result");
    expect(frame).toContain("✓");
    expect(frame).toContain("Provider");
    expect(frame).toContain("1 │ const name = 'AlfaCode';");
  });

  it("removes terminal control sequences and HTML tags", () => {
    expect(sanitizeTerminalText("ok\u001B[31mred\u001B[0m\u0007")).toBe("okred");
    const tokens = marked.lexer("Hello <b>world</b>");
    expect(plainText(tokens)).toBe("Hello world");
  });

  it("uses a stacked representation for tables in narrow terminals", () => {
    const view = render(<Markdown theme={theme} width={18}>{"| A | B |\n|---|---|\n| one | two |"}</Markdown>);
    expect(view.lastFrame()).toContain("A: one");
    expect(view.lastFrame()).toContain("B: two");
  });
});
