import React, { useEffect, useRef, useState } from "react";
import { Box, Text } from "ink";
import { marked, type Token, type Tokens } from "marked";
import stringWidth from "string-width";
import type { Theme } from "./theme.js";

const MARKDOWN_LEX_INTERVAL_MS = 80;

export function Markdown({ children, theme, width = 88 }: { readonly children: string; readonly theme: Theme; readonly width?: number }): React.JSX.Element {
  const tokens = useMarkdownTokens(children);
  return <Box flexDirection="column">{tokens.map((token, index) => <BlockToken key={`${token.type}-${index}`} token={token} theme={theme} width={width} />)}</Box>;
}

function useMarkdownTokens(source: string): Token[] {
  const latestSource = useRef(source);
  const parsedSource = useRef(source);
  const lastLexedAt = useRef(Date.now());
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [tokens, setTokens] = useState<Token[]>(() => lexMarkdown(source));
  latestSource.current = source;

  useEffect(() => {
    if (parsedSource.current === source) return;

    const flush = (): void => {
      timeout.current = undefined;
      const nextSource = latestSource.current;
      if (parsedSource.current === nextSource) return;
      parsedSource.current = nextSource;
      lastLexedAt.current = Date.now();
      setTokens(lexMarkdown(nextSource));
    };
    const elapsed = Date.now() - lastLexedAt.current;
    const delay = Math.max(0, MARKDOWN_LEX_INTERVAL_MS - elapsed);
    if (delay === 0) flush();
    else if (timeout.current === undefined) timeout.current = setTimeout(flush, delay);
  }, [source]);

  useEffect(() => () => {
    if (timeout.current !== undefined) clearTimeout(timeout.current);
  }, []);

  return tokens;
}

function lexMarkdown(source: string): Token[] {
  return marked.lexer(sanitizeTerminalText(source), { gfm: true, breaks: true });
}

/** Heading depth 1-6 mapped to a strictly descending weight: the two colors the rest of the
 * palette already treats as "boldest" (accent, then accentSoft) for the two levels a response is
 * actually likely to use as real section breaks, then secondary — visually quieter than either,
 * but still a clear step down — for every deeper level, so depth keeps reading as a hierarchy
 * instead of flattening out to indistinguishable bold text past h2. */
function headingColor(depth: number, theme: Theme): string {
  if (depth === 1) return theme.accent;
  if (depth === 2) return theme.accentSoft;
  return theme.secondary;
}
function headingMarker(depth: number): string {
  if (depth === 1) return "◆ ";
  if (depth === 2) return "◇ ";
  return "› ";
}

function BlockToken({ token, theme, width, trailingMargin = true }: { readonly token: Token; readonly theme: Theme; readonly width: number; readonly trailingMargin?: boolean }): React.JSX.Element | null {
  switch (token.type) {
    case "space": return null;
    case "heading": {
      const heading = token as Tokens.Heading;
      return <Box marginTop={heading.depth === 1 ? 1 : 0} marginBottom={trailingMargin && heading.depth <= 2 ? 1 : 0}>
        <Text bold color={headingColor(heading.depth, theme)}>{headingMarker(heading.depth)}<InlineTokens tokens={heading.tokens} theme={theme} /></Text>
      </Box>;
    }
    case "paragraph": return <Box marginBottom={trailingMargin ? 1 : 0}><Text color={theme.text} wrap="wrap"><InlineTokens tokens={(token as Tokens.Paragraph).tokens} theme={theme} /></Text></Box>;
    case "code": return <CodeBlock token={token as Tokens.Code} theme={theme} width={width} trailingMargin={trailingMargin} />;
    case "blockquote": return <Box marginBottom={trailingMargin ? 1 : 0} paddingLeft={1} borderStyle="single" borderLeft borderRight={false} borderTop={false} borderBottom={false} borderColor={theme.secondarySoft}>
      <Box flexDirection="column"><BlockTokensTrimmed tokens={(token as Tokens.Blockquote).tokens} theme={theme} width={Math.max(20, width - 3)} /></Box>
    </Box>;
    case "list": return <ListBlock token={token as Tokens.List} theme={theme} width={width} trailingMargin={trailingMargin} />;
    case "table": return <TableBlock token={token as Tokens.Table} theme={theme} width={width} trailingMargin={trailingMargin} />;
    case "hr": return <Box marginY={trailingMargin ? 1 : 0}><Text color={theme.border}>{"─".repeat(Math.max(8, Math.min(width, 72)))}</Text></Box>;
    case "html": return token.text.trim().length === 0 ? null : <Box marginBottom={trailingMargin ? 1 : 0}><Text color={theme.muted}>{stripHtml(token.text)}</Text></Box>;
    case "text": return <Box marginBottom={trailingMargin ? 1 : 0}><Text color={theme.text}><InlineTokens tokens={token.tokens ?? [token]} theme={theme} /></Text></Box>;
    default: {
      const generic = token as Tokens.Generic;
      return generic.tokens === undefined ? null : <BlockTokens tokens={generic.tokens} theme={theme} width={width} />;
    }
  }
}

function BlockTokens({ tokens, theme, width }: { readonly tokens: readonly Token[]; readonly theme: Theme; readonly width: number }): React.JSX.Element {
  return <>{tokens.map((token, index) => <BlockToken key={`${token.type}-${index}`} token={token} theme={theme} width={width} />)}</>;
}

/**
 * Same as `BlockTokens`, except the very last block in the list renders without its own trailing
 * bottom margin. Blank space after a block is invisible on its own, but a blockquote or a nested
 * list draws its left rail/border around that trailing blank row too — so without this, the last
 * line inside one of those reads as a stray colored bar hanging with nothing next to it. Used
 * anywhere block content is nested inside another block's own border/indent, not at the top level
 * (a trailing blank line after the very last block of a whole message is fine — it's outside any
 * border, so there's nothing for it to look like a glitch on).
 */
function BlockTokensTrimmed({ tokens, theme, width }: { readonly tokens: readonly Token[]; readonly theme: Theme; readonly width: number }): React.JSX.Element {
  return <>{tokens.map((token, index) => <BlockToken key={`${token.type}-${index}`} token={token} theme={theme} width={width} trailingMargin={index < tokens.length - 1} />)}</>;
}

function InlineTokens({ tokens, theme }: { readonly tokens: readonly Token[]; readonly theme: Theme }): React.JSX.Element {
  return <>{tokens.map((token, index) => <InlineToken key={`${token.type}-${index}`} token={token} theme={theme} />)}</>;
}

function InlineToken({ token, theme }: { readonly token: Token; readonly theme: Theme }): React.JSX.Element | string | null {
  switch (token.type) {
    case "text": return token.tokens === undefined ? sanitizeTerminalText(token.text) : <InlineTokens tokens={token.tokens} theme={theme} />;
    case "escape": return sanitizeTerminalText(token.text);
    case "strong": return <Text bold><InlineTokens tokens={(token as Tokens.Strong).tokens} theme={theme} /></Text>;
    case "em": return <Text italic><InlineTokens tokens={(token as Tokens.Em).tokens} theme={theme} /></Text>;
    case "del": return <Text strikethrough color={theme.muted}><InlineTokens tokens={(token as Tokens.Del).tokens} theme={theme} /></Text>;
    case "codespan": return <Text color={theme.code} backgroundColor={theme.surface}> {sanitizeTerminalText(token.text)} </Text>;
    case "link": {
      // Only the link text itself is underlined/accented — the appended URL is reference
      // material, not the emphasis, so it stays muted and plain rather than competing for the
      // same visual weight as the text a reader is actually meant to read.
      const link = token as Tokens.Link;
      return <Text><Text color={theme.accentSoft} underline><InlineTokens tokens={link.tokens} theme={theme} /></Text>{link.text === link.href ? "" : <Text color={theme.faint}> ↗ {sanitizeTerminalText(link.href).slice(0, 300)}</Text>}</Text>;
    }
    case "image": return <Text color={theme.secondary}>[image: {sanitizeTerminalText(token.text || token.href)}]</Text>;
    case "br": return "\n";
    case "html": return sanitizeTerminalText(stripHtml(token.text));
    default: return "text" in token && typeof token.text === "string" ? sanitizeTerminalText(token.text) : null;
  }
}

/**
 * A curated, deliberately modest set of languages get real (regex-tokenized, not a full lexer)
 * syntax highlighting: keywords, string/template literals, numbers, and line comments, each
 * mapped onto an existing theme token so it reads as "this palette's code style" rather than a
 * bolted-on scheme. Anything outside this set — including no language tag at all — falls back to
 * flat `theme.code`, exactly like before; there is no attempt at a generic/best-guess tokenizer,
 * since a wrong guess (e.g. treating a config file's bare words as keywords) is worse than plain.
 */
interface LanguageSpec { readonly keywords: readonly string[]; readonly lineComment?: string }

const CLIKE_KEYWORDS = ["break", "case", "catch", "class", "const", "continue", "default", "delete", "do", "else", "enum", "export", "extends", "false", "finally", "for", "function", "if", "import", "in", "instanceof", "let", "new", "null", "return", "static", "super", "switch", "this", "throw", "true", "try", "typeof", "undefined", "var", "void", "while", "yield", "async", "await", "of", "as"];
const languageSpecs: Record<string, LanguageSpec> = {
  javascript: { keywords: CLIKE_KEYWORDS, lineComment: "//" },
  typescript: { keywords: [...CLIKE_KEYWORDS, "interface", "type", "namespace", "declare", "readonly", "public", "private", "protected", "abstract", "is", "keyof", "infer", "satisfies", "implements"], lineComment: "//" },
  clike: { keywords: [...CLIKE_KEYWORDS, "int", "char", "float", "double", "long", "short", "unsigned", "signed", "struct", "union", "typedef", "sizeof", "include", "define", "namespace", "template", "public", "private", "protected", "virtual", "override", "final", "interface"], lineComment: "//" },
  python: { keywords: ["and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield", "None", "True", "False", "self"], lineComment: "#" },
  bash: { keywords: ["if", "then", "else", "elif", "fi", "for", "while", "do", "done", "case", "esac", "function", "return", "local", "export", "in", "echo", "exit", "break", "continue"], lineComment: "#" },
  go: { keywords: ["break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough", "for", "func", "go", "goto", "if", "import", "interface", "map", "package", "range", "return", "select", "struct", "switch", "type", "var", "true", "false", "nil"], lineComment: "//" },
  rust: { keywords: ["as", "break", "const", "continue", "crate", "else", "enum", "extern", "false", "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut", "pub", "ref", "return", "self", "Self", "static", "struct", "super", "trait", "true", "type", "unsafe", "use", "where", "while", "async", "await", "dyn"], lineComment: "//" },
  ruby: { keywords: ["def", "end", "if", "elsif", "else", "unless", "while", "until", "for", "in", "do", "class", "module", "return", "yield", "begin", "rescue", "ensure", "raise", "true", "false", "nil", "self", "then", "case", "when", "require"], lineComment: "#" },
  php: { keywords: ["function", "return", "if", "else", "elseif", "endif", "foreach", "as", "while", "do", "class", "public", "private", "protected", "static", "new", "echo", "print", "true", "false", "null", "use", "namespace", "try", "catch", "finally", "throw"], lineComment: "//" },
  sql: { keywords: ["select", "from", "where", "insert", "into", "values", "update", "set", "delete", "join", "inner", "left", "right", "outer", "on", "group", "by", "order", "having", "as", "and", "or", "not", "null", "is", "in", "like", "limit", "create", "table", "primary", "key", "foreign", "references", "alter", "drop", "distinct", "union", "case", "when", "then", "end"], lineComment: "--" },
  json: { keywords: ["true", "false", "null"] },
  yaml: { keywords: ["true", "false", "null"], lineComment: "#" },
};
const languageAliases: Record<string, string> = {
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript",
  py: "python", py3: "python",
  sh: "bash", shell: "bash", zsh: "bash",
  golang: "go", rs: "rust", rb: "ruby",
  c: "clike", h: "clike", cpp: "clike", "c++": "clike", cc: "clike", hpp: "clike", java: "clike", kotlin: "clike", kt: "clike", csharp: "clike", "c#": "clike", cs: "clike", swift: "clike",
  json5: "json", jsonc: "json",
  yml: "yaml",
};

function resolveLanguageSpec(lang: string | undefined): LanguageSpec | undefined {
  if (lang === undefined) return undefined;
  const key = lang.trim().toLowerCase();
  return languageSpecs[languageAliases[key] ?? key];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Built once per code block (not per line) — `String.matchAll` doesn't mutate the regex it's
 * given, so the same compiled pattern is safe to reuse across every line. */
function buildHighlightPattern(spec: LanguageSpec): RegExp {
  const parts: string[] = [];
  if (spec.lineComment !== undefined) parts.push(`(?<comment>${escapeRegExp(spec.lineComment)}.*$)`);
  parts.push('(?<string>"(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\'|`(?:\\\\.|[^`\\\\])*`)');
  parts.push("(?<number>\\b\\d+(?:\\.\\d+)?\\b)");
  if (spec.keywords.length > 0) parts.push(`(?<keyword>\\b(?:${spec.keywords.map(escapeRegExp).join("|")})\\b)`);
  return new RegExp(parts.join("|"), "gm");
}

type HighlightKind = "plain" | "comment" | "string" | "number" | "keyword";
interface HighlightSegment { readonly text: string; readonly kind: HighlightKind }

function highlightLine(line: string, pattern: RegExp | undefined): readonly HighlightSegment[] {
  if (pattern === undefined || line.length === 0) return [{ text: line, kind: "plain" }];
  const segments: HighlightSegment[] = [];
  let cursor = 0;
  for (const match of line.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) segments.push({ text: line.slice(cursor, index), kind: "plain" });
    const kind: HighlightKind = match.groups?.comment !== undefined ? "comment" : match.groups?.string !== undefined ? "string" : match.groups?.number !== undefined ? "number" : "keyword";
    segments.push({ text: match[0], kind });
    cursor = index + match[0].length;
  }
  if (cursor < line.length) segments.push({ text: line.slice(cursor), kind: "plain" });
  return segments.length === 0 ? [{ text: line, kind: "plain" }] : segments;
}

function highlightColor(kind: HighlightKind, theme: Theme): string {
  if (kind === "comment") return theme.faint;
  if (kind === "string") return theme.success;
  if (kind === "number") return theme.warning;
  if (kind === "keyword") return theme.secondary;
  return theme.code;
}

/**
 * Hand-drawn (like `TableBlock` below) rather than an Ink `borderStyle` box, so the language tag
 * can live in the top border itself — `╭─ ts ──…──╮` — instead of eating its own content row above
 * the code the way a plain label line above the border did before.
 */
function CodeBlock({ token, theme, width, trailingMargin = true }: { readonly token: Tokens.Code; readonly theme: Theme; readonly width: number; readonly trailingMargin?: boolean }): React.JSX.Element {
  const lines = sanitizeTerminalText(token.text).split("\n");
  const digits = String(lines.length).length;
  const innerWidth = Math.max(10, width - 2);
  const codeWidth = Math.max(8, innerWidth - digits - 5);
  const spec = resolveLanguageSpec(token.lang?.split(/\s+/u)[0]);
  const pattern = spec === undefined ? undefined : buildHighlightPattern(spec);
  const rawLabel = token.lang === undefined ? undefined : sanitizeTerminalText(token.lang.split(/\s+/u)[0] ?? "");
  const label = rawLabel === undefined || rawLabel.length === 0 ? undefined : truncate(rawLabel, Math.max(1, innerWidth - 6));
  const topFill = label === undefined ? innerWidth : Math.max(0, innerWidth - label.length - 3);
  return <Box flexDirection="column" marginBottom={trailingMargin ? 1 : 0}>
    <Text color={theme.border}>╭{label === undefined ? "" : "─"}{label === undefined ? null : <Text bold color={theme.secondary}> {label} </Text>}{"─".repeat(topFill)}╮</Text>
    {lines.map((line, index) => {
      const truncated = truncate(line, codeWidth);
      const segments = highlightLine(truncated, pattern);
      return <Text key={index} wrap="truncate-end">
        <Text color={theme.border}>│ </Text>
        <Text color={theme.faint}>{String(index + 1).padStart(digits)} │ </Text>
        {segments.map((segment, segmentIndex) => <Text key={segmentIndex} color={highlightColor(segment.kind, theme)} italic={segment.kind === "comment"}>{segment.text}</Text>)}
        <Text color={theme.border}>{" ".repeat(Math.max(0, codeWidth - stringWidth(truncated)))} │</Text>
      </Text>;
    })}
    <Text color={theme.border}>╰{"─".repeat(innerWidth)}╯</Text>
  </Box>;
}

function ListBlock({ token, theme, width, trailingMargin = true, nested = false }: { readonly token: Tokens.List; readonly theme: Theme; readonly width: number; readonly trailingMargin?: boolean; readonly nested?: boolean }): React.JSX.Element {
  const start = typeof token.start === "number" ? token.start : 1;
  // Nested lists (see ListItemTokens) skip their own trailing margin: only the outermost list in a
  // nesting chain should leave a blank line after it finishes, or every extra level of nesting
  // stacks another blank line on top regardless of how deep the list actually goes.
  return <Box flexDirection="column" marginBottom={nested || !trailingMargin ? 0 : 1}>{token.items.map((item, index) => {
    const marker = item.task ? (item.checked ? "✓" : "○") : token.ordered ? `${start + index}.` : "•";
    const tone = item.task && item.checked ? theme.success : theme.secondary;
    return <Box key={index} paddingLeft={1}><Box width={4}><Text bold color={tone}>{marker}</Text></Box><Box flexDirection="column" flexGrow={1}><ListItemTokens tokens={item.tokens} theme={theme} width={Math.max(16, width - 5)} /></Box></Box>;
  })}</Box>;
}

function TableBlock({ token, theme, width, trailingMargin = true }: { readonly token: Tokens.Table; readonly theme: Theme; readonly width: number; readonly trailingMargin?: boolean }): React.JSX.Element {
  const rows = [token.header, ...token.rows].map((row) => row.map((cell) => plainText(cell.tokens)));
  const columnCount = token.header.length;
  const align = token.header.map((cell) => cell.align);
  const minimumTableWidth = columnCount * 8 + columnCount + 1;
  if (columnCount === 0) return <></>;
  if (width < minimumTableWidth) {
    return <Box flexDirection="column" marginBottom={trailingMargin ? 1 : 0}>{token.rows.map((row, rowIndex) => <Box key={rowIndex} flexDirection="column" borderStyle="single" borderColor={theme.border} paddingX={1} marginBottom={1}>
      {row.map((cell, cellIndex) => <Text key={cellIndex}><Text bold color={theme.muted}>{plainText(token.header[cellIndex]?.tokens ?? [])}: </Text><InlineTokens tokens={cell.tokens} theme={theme} /></Text>)}
    </Box>)}</Box>;
  }
  const available = Math.max(columnCount * 6, width - columnCount - 1);
  const widths = distributeWidths(rows, available);
  const border = `├${widths.map((value) => "─".repeat(value + 2)).join("┼")}┤`;
  return <Box flexDirection="column" marginBottom={trailingMargin ? 1 : 0}>
    <Text color={theme.border}>{`┌${widths.map((value) => "─".repeat(value + 2)).join("┬")}┐`}</Text>
    <TableRow cells={rows[0] ?? []} widths={widths} align={align} theme={theme} header />
    <Text color={theme.border}>{border}</Text>
    {rows.slice(1).map((row, index) => <TableRow key={index} cells={row} widths={widths} align={align} theme={theme} />)}
    <Text color={theme.border}>{`└${widths.map((value) => "─".repeat(value + 2)).join("┴")}┘`}</Text>
  </Box>;
}

function TableRow({ cells, widths, align, theme, header = false }: { readonly cells: readonly string[]; readonly widths: readonly number[]; readonly align: readonly ("center" | "left" | "right" | null)[]; readonly theme: Theme; readonly header?: boolean }): React.JSX.Element {
  return <Text><Text color={theme.border}>│</Text>{widths.map((width, index) => {
    const cell = padAligned(truncate(cells[index] ?? "", width), width, align[index] ?? "left");
    return <React.Fragment key={index}><Text bold={header} color={header ? theme.accentSoft : theme.text}> {cell} </Text><Text color={theme.border}>│</Text></React.Fragment>;
  })}</Text>;
}

export function sanitizeTerminalText(value: string): string {
  return value
    .replace(/\u001B(?:\]|P|X|\^|_)[\s\S]*?(?:\u0007|\u001B\\)/gu, "")
    .replace(/(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\u001B[@-_]/gu, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, "");
}

export function plainText(tokens: readonly Token[]): string {
  return sanitizeTerminalText(tokens.map((token) => {
    if (token.type === "br") return " ";
    if (token.type === "image") return `[image: ${token.text || token.href}]`;
    if ("tokens" in token && Array.isArray(token.tokens)) return plainText(token.tokens);
    return "text" in token && typeof token.text === "string" ? stripHtml(token.text) : "";
  }).join(""));
}

function ListItemTokens({ tokens, theme, width }: { readonly tokens: readonly Token[]; readonly theme: Theme; readonly width: number }): React.JSX.Element {
  return <>{tokens.map((token, index) => {
    if (token.type === "text" || token.type === "paragraph") {
      const inline = token.type === "paragraph" ? (token as Tokens.Paragraph).tokens : token.tokens ?? [token];
      return <Text key={index} color={theme.text}><InlineTokens tokens={inline} theme={theme} /></Text>;
    }
    // Routed directly to ListBlock (rather than through the generic BlockToken switch) so it can
    // be told it's nested — see ListBlock's own note on why that matters for spacing.
    if (token.type === "list") return <ListBlock key={index} token={token as Tokens.List} theme={theme} width={width} nested />;
    return <BlockToken key={index} token={token} theme={theme} width={width} />;
  })}</>;
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/gu, "");
}

function truncate(value: string, width: number): string {
  if (stringWidth(value) <= width) return value;
  let output = "";
  for (const character of value) {
    if (stringWidth(output + character + "…") > width) break;
    output += character;
  }
  return `${output}…`;
}

/** Pads `value` to `width`, honoring a GFM table column's declared alignment (`| :-: |` etc.);
 * `null`/unset aligns left, matching how such columns render in every other markdown renderer. */
function padAligned(value: string, width: number, align: "center" | "left" | "right" | null): string {
  const gap = Math.max(0, width - stringWidth(value));
  if (align === "right") return " ".repeat(gap) + value;
  if (align === "center") {
    const left = Math.floor(gap / 2);
    return " ".repeat(left) + value + " ".repeat(gap - left);
  }
  return value + " ".repeat(gap);
}

function distributeWidths(rows: readonly (readonly string[])[], available: number): number[] {
  const columns = Math.max(0, ...rows.map((row) => row.length));
  const desired = Array.from({ length: columns }, (_, column) => Math.max(3, ...rows.map((row) => stringWidth(row[column] ?? ""))));
  const widths = [...desired];
  while (widths.reduce((total, value) => total + value, 0) > available) {
    const largest = widths.indexOf(Math.max(...widths));
    if ((widths[largest] ?? 0) <= 5) break;
    widths[largest] = (widths[largest] ?? 6) - 1;
  }
  return widths;
}
