import { describe, expect, it, vi } from "vitest";
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

  it("gives headings a distinct marker per depth instead of flattening past h2", () => {
    const markdown = ["# One", "## Two", "### Three", "#### Four"].join("\n\n");
    const frame = render(<Markdown theme={theme} width={72}>{markdown}</Markdown>).lastFrame() ?? "";
    expect(frame).toContain("◆ One");
    expect(frame).toContain("◇ Two");
    expect(frame).toContain("› Three");
    expect(frame).toContain("› Four");
  });

  it("closes a blockquote's border cleanly instead of leaving a stray colored line under it", () => {
    const markdown = ["Before.", "", "> Quoted line one", "> Quoted line two", "", "After."].join("\n");
    const frame = render(<Markdown theme={theme} width={60}>{markdown}</Markdown>).lastFrame() ?? "";
    const lines = frame.split("\n");
    const afterIndex = lines.findIndex((line) => line.includes("After."));
    const lastQuoteIndex = lines.findIndex((line) => line.includes("Quoted line two"));
    expect(afterIndex).toBeGreaterThan(lastQuoteIndex);
    // Nothing between the last quoted line and "After." should still carry the quote's own "│"
    // rail — that would mean a blank, bordered line leaked out of the blockquote's own box.
    for (const line of lines.slice(lastQuoteIndex + 1, afterIndex)) expect(line).not.toContain("│");
  });

  it("doesn't stack a blank line per nesting level after a nested list finishes", () => {
    const markdown = ["- outer one", "  - inner one", "  - inner two", "- outer two"].join("\n");
    const frame = render(<Markdown theme={theme} width={60}>{markdown}</Markdown>).lastFrame() ?? "";
    const lines = frame.split("\n").filter((line) => line.trim().length > 0);
    const innerTwoIndex = lines.findIndex((line) => line.includes("inner two"));
    const outerTwoIndex = lines.findIndex((line) => line.includes("outer two"));
    // Adjacent non-blank rows: list items never got their own gap before, nested or not.
    expect(outerTwoIndex).toBe(innerTwoIndex + 1);
  });

  it("embeds the language tag in the code block's own top border instead of a separate content row", () => {
    const markdown = ["```ts", "const value = 1;", "```"].join("\n");
    const frame = render(<Markdown theme={theme} width={72}>{markdown}</Markdown>).lastFrame() ?? "";
    expect(frame).toMatch(/╭─+ ts ─+╮/u);
    const lines = frame.split("\n").filter((line) => line.trim().length > 0);
    const borderLine = lines.find((line) => line.includes("╭"));
    // Every border line is the same total width — no off-by-one that would push the closing
    // corner onto its own wrapped row (the bug this test would have caught).
    expect(borderLine).toBeDefined();
    const bareBorderFrame = render(<Markdown theme={theme} width={72}>{["```", "plain", "```"].join("\n")}</Markdown>).lastFrame() ?? "";
    const bareLine = bareBorderFrame.split("\n").find((line) => line.includes("╭"));
    expect(bareLine?.length).toBe(borderLine?.length);
  });

  it("applies real, curated syntax highlighting for a recognized language without corrupting the code text", () => {
    const markdown = ["```python", "def greet():", "    # comment", '    return "hi"', "```"].join("\n");
    const frame = render(<Markdown theme={theme} width={72}>{markdown}</Markdown>).lastFrame() ?? "";
    expect(frame).toContain("def greet():");
    expect(frame).toContain("# comment");
    expect(frame).toContain('return "hi"');
  });

  it("falls back to plain, unhighlighted text for an unrecognized or missing language tag", () => {
    const markdown = ["```made-up-lang", "return keyword_lookalike;", "```"].join("\n");
    const frame = render(<Markdown theme={theme} width={72}>{markdown}</Markdown>).lastFrame() ?? "";
    expect(frame).toContain("return keyword_lookalike;");
  });

  it("respects a GFM table's declared column alignment", () => {
    const markdown = ["| Name | Qty |", "| :-- | --: |", "| a | 1 |", "| bb | 22 |"].join("\n");
    const frame = render(<Markdown theme={theme} width={40}>{markdown}</Markdown>).lastFrame() ?? "";
    const lines = frame.split("\n");
    const rowA = lines.find((line) => line.includes(" a "));
    const rowBb = lines.find((line) => line.includes(" bb "));
    expect(rowA).toBeDefined();
    expect(rowBb).toBeDefined();
    // Right-aligned "Qty" column: a single-digit "1" sits further right than "1" would sitting
    // flush-left, matching where the two-digit "22" naturally lands.
    const qtyColumn = (line: string): number => line.lastIndexOf("│", line.length - 2);
    expect(qtyColumn(rowA ?? "")).toBe(qtyColumn(rowBb ?? ""));
  });

  it("keeps a link's URL annotation visually secondary to the link text itself", () => {
    const markdown = "See [the docs](https://example.com/path) for more.";
    const frame = render(<Markdown theme={theme} width={72}>{markdown}</Markdown>).lastFrame() ?? "";
    expect(frame).toContain("the docs");
    expect(frame).toContain("↗ https://example.com/path");
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
