import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { Markdown, markdownToPlainText, plainText, sanitizeTerminalText } from "../src/ui/markdown.js";
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

  it("coalesces rapid streamed updates and fully renders the settled content", async () => {
    vi.useFakeTimers();
    const lexer = vi.spyOn(marked, "lexer");
    let view: ReturnType<typeof render> | undefined;
    try {
      const chunks = ["# Result", "\n\nFirst", " paragraph", "\n\n- one", "\n- two", "\n\n**Done**"];
      let streamed = "";
      view = render(<Markdown theme={theme}>{streamed}</Markdown>);
      for (const chunk of chunks) {
        streamed += chunk;
        view.rerender(<Markdown theme={theme}>{streamed}</Markdown>);
      }

      expect(lexer).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(80);
      await vi.advanceTimersByTimeAsync(40);

      expect(lexer).toHaveBeenCalledTimes(2);
      expect(view.lastFrame()).toContain("◆ Result");
      expect(view.lastFrame()).toContain("First paragraph");
      expect(view.lastFrame()).toContain("two");
      expect(view.lastFrame()).toContain("Done");
    } finally {
      view?.unmount();
      lexer.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("markdown-to-plain-text conversion (used by /copy)", () => {
  it("strips inline formatting markers while keeping the text", () => {
    expect(markdownToPlainText("**bold** and _em_ and `code` and ~~gone~~")).toBe("bold and em and code and gone");
  });

  it("drops heading/list/table syntax but keeps readable structure", () => {
    const markdown = ["# Title", "", "- one", "- two", "", "1. first", "2. second"].join("\n");
    expect(markdownToPlainText(markdown)).toBe("Title\n\n- one\n- two\n\n1. first\n2. second");
  });

  it("renders task list items with checkbox markers", () => {
    expect(markdownToPlainText("- [x] done\n- [ ] todo")).toBe("[x] done\n[ ] todo");
  });

  it("keeps code block content verbatim, including angle brackets stripHtml would otherwise eat", () => {
    const markdown = ["```ts", "const items: Array<string> = [];", "```"].join("\n");
    expect(markdownToPlainText(markdown)).toBe("const items: Array<string> = [];");
  });

  it("keeps a link's visible text and appends its URL", () => {
    expect(markdownToPlainText("[AlfaCode](https://example.test)")).toBe("AlfaCode (https://example.test)");
  });

  it("renders a table as pipe-separated plain rows", () => {
    const markdown = ["| Provider | Ready |", "| --- | --- |", "| Zen | yes |"].join("\n");
    expect(markdownToPlainText(markdown)).toBe("Provider | Ready\nZen | yes");
  });

  it("strips terminal control sequences embedded in unsanitized source before parsing", () => {
    expect(markdownToPlainText("safe[31mred[0m text")).toBe("safered text");
  });

  it("collapses blank/space-only blocks instead of emitting empty paragraphs", () => {
    expect(markdownToPlainText("first\n\n\n\nsecond")).toBe("first\n\nsecond");
  });
});
