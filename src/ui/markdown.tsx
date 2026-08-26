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

function BlockToken({ token, theme, width }: { readonly token: Token; readonly theme: Theme; readonly width: number }): React.JSX.Element | null {
  switch (token.type) {
    case "space": return null;
    case "heading": {
      const heading = token as Tokens.Heading;
      return <Box marginTop={heading.depth === 1 ? 1 : 0} marginBottom={heading.depth <= 2 ? 1 : 0}>
        <Text bold color={heading.depth <= 2 ? theme.accentSoft : theme.text}>{heading.depth === 1 ? "◆ " : heading.depth === 2 ? "◇ " : "› "}<InlineTokens tokens={heading.tokens} theme={theme} /></Text>
      </Box>;
    }
    case "paragraph": return <Box marginBottom={1}><Text color={theme.text} wrap="wrap"><InlineTokens tokens={(token as Tokens.Paragraph).tokens} theme={theme} /></Text></Box>;
    case "code": return <CodeBlock token={token as Tokens.Code} theme={theme} width={width} />;
    case "blockquote": return <Box marginBottom={1} paddingLeft={1} borderStyle="single" borderLeft borderRight={false} borderTop={false} borderBottom={false} borderColor={theme.secondary}>
      <Box flexDirection="column"><BlockTokens tokens={(token as Tokens.Blockquote).tokens} theme={theme} width={Math.max(20, width - 3)} /></Box>
    </Box>;
    case "list": return <ListBlock token={token as Tokens.List} theme={theme} width={width} />;
    case "table": return <TableBlock token={token as Tokens.Table} theme={theme} width={width} />;
    case "hr": return <Box marginY={1}><Text color={theme.border}>{"─".repeat(Math.max(8, Math.min(width, 72)))}</Text></Box>;
    case "html": return token.text.trim().length === 0 ? null : <Box marginBottom={1}><Text color={theme.muted}>{stripHtml(token.text)}</Text></Box>;
    case "text": return <Box marginBottom={1}><Text color={theme.text}><InlineTokens tokens={token.tokens ?? [token]} theme={theme} /></Text></Box>;
    default: {
      const generic = token as Tokens.Generic;
      return generic.tokens === undefined ? null : <BlockTokens tokens={generic.tokens} theme={theme} width={width} />;
    }
  }
}

function BlockTokens({ tokens, theme, width }: { readonly tokens: readonly Token[]; readonly theme: Theme; readonly width: number }): React.JSX.Element {
  return <>{tokens.map((token, index) => <BlockToken key={`${token.type}-${index}`} token={token} theme={theme} width={width} />)}</>;
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
      const link = token as Tokens.Link;
      return <Text color={theme.accentSoft} underline><InlineTokens tokens={link.tokens} theme={theme} />{link.text === link.href ? "" : ` ↗ ${sanitizeTerminalText(link.href).slice(0, 300)}`}</Text>;
    }
    case "image": return <Text color={theme.secondary}>[image: {sanitizeTerminalText(token.text || token.href)}]</Text>;
    case "br": return "\n";
    case "html": return sanitizeTerminalText(stripHtml(token.text));
    default: return "text" in token && typeof token.text === "string" ? sanitizeTerminalText(token.text) : null;
  }
}

function CodeBlock({ token, theme, width }: { readonly token: Tokens.Code; readonly theme: Theme; readonly width: number }): React.JSX.Element {
  const lines = sanitizeTerminalText(token.text).split("\n");
  const digits = String(lines.length).length;
  const available = Math.max(12, width - digits - 5);
  return <Box flexDirection="column" marginBottom={1} borderStyle="round" borderColor={theme.border} paddingX={1}>
    {token.lang === undefined ? null : <Text bold color={theme.secondary}>{sanitizeTerminalText(token.lang.split(/\s+/u)[0] ?? "code")}</Text>}
    {lines.map((line, index) => <Text key={index} wrap="truncate-end"><Text color={theme.faint}>{String(index + 1).padStart(digits)} │ </Text><Text color={theme.code}>{truncate(line, available)}</Text></Text>)}
  </Box>;
}

function ListBlock({ token, theme, width }: { readonly token: Tokens.List; readonly theme: Theme; readonly width: number }): React.JSX.Element {
  const start = typeof token.start === "number" ? token.start : 1;
  return <Box flexDirection="column" marginBottom={1}>{token.items.map((item, index) => {
    const marker = item.task ? (item.checked ? "✓" : "○") : token.ordered ? `${start + index}.` : "•";
    const tone = item.task && item.checked ? theme.success : theme.secondary;
    return <Box key={index} paddingLeft={1}><Box width={4}><Text bold color={tone}>{marker}</Text></Box><Box flexDirection="column" flexGrow={1}><ListItemTokens tokens={item.tokens} theme={theme} width={Math.max(16, width - 5)} /></Box></Box>;
  })}</Box>;
}

function TableBlock({ token, theme, width }: { readonly token: Tokens.Table; readonly theme: Theme; readonly width: number }): React.JSX.Element {
  const rows = [token.header, ...token.rows].map((row) => row.map((cell) => plainText(cell.tokens)));
  const columnCount = token.header.length;
  const minimumTableWidth = columnCount * 8 + columnCount + 1;
  if (columnCount === 0) return <></>;
  if (width < minimumTableWidth) {
    return <Box flexDirection="column" marginBottom={1}>{token.rows.map((row, rowIndex) => <Box key={rowIndex} flexDirection="column" borderStyle="single" borderColor={theme.border} paddingX={1} marginBottom={1}>
      {row.map((cell, cellIndex) => <Text key={cellIndex}><Text bold color={theme.muted}>{plainText(token.header[cellIndex]?.tokens ?? [])}: </Text><InlineTokens tokens={cell.tokens} theme={theme} /></Text>)}
    </Box>)}</Box>;
  }
  const available = Math.max(columnCount * 6, width - columnCount - 1);
  const widths = distributeWidths(rows, available);
  const border = `├${widths.map((value) => "─".repeat(value + 2)).join("┼")}┤`;
  return <Box flexDirection="column" marginBottom={1}>
    <Text color={theme.border}>{`┌${widths.map((value) => "─".repeat(value + 2)).join("┬")}┐`}</Text>
    <TableRow cells={rows[0] ?? []} widths={widths} theme={theme} header />
    <Text color={theme.border}>{border}</Text>
    {rows.slice(1).map((row, index) => <TableRow key={index} cells={row} widths={widths} theme={theme} />)}
    <Text color={theme.border}>{`└${widths.map((value) => "─".repeat(value + 2)).join("┴")}┘`}</Text>
  </Box>;
}

function TableRow({ cells, widths, theme, header = false }: { readonly cells: readonly string[]; readonly widths: readonly number[]; readonly theme: Theme; readonly header?: boolean }): React.JSX.Element {
  return <Text><Text color={theme.border}>│</Text>{widths.map((width, index) => {
    const cell = pad(truncate(cells[index] ?? "", width), width);
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

/**
 * Converts markdown source into plain, readable prose — the same block/inline structure the
 * terminal renderer above understands (headings, lists, code blocks, tables, links, ...) but
 * without markdown syntax markers (`**`, backticks, `#`; table cells stay pipe-separated, which
 * reads fine as plain text). Used by chat-tui.tsx's `/copy` command so pasting an assistant
 * response elsewhere produces readable text instead of raw markdown source. Sanitizes the source
 * the same way `lexMarkdown` does before parsing — an assistant transcript row is stored raw and
 * only sanitized at render time, so this must sanitize on its own path too. Does not call or
 * modify `sanitizeTerminalText` itself beyond that reuse, and — unlike `plainText` above, which is
 * built for flattening short inline runs (e.g. table cells) — walks inline tokens with its own
 * `inlineToPlainText` so a link keeps its URL and inline code isn't run through `stripHtml`
 * (which would otherwise eat `<`/`>` out of things like `Array<string>`).
 */
export function markdownToPlainText(source: string): string {
  const tokens = marked.lexer(sanitizeTerminalText(source), { gfm: true, breaks: true });
  return blocksToPlainText(tokens).trim();
}

function blocksToPlainText(tokens: readonly Token[]): string {
  return tokens.map((token) => blockToPlainText(token)).filter((block) => block.length > 0).join("\n\n");
}

function blockToPlainText(token: Token): string {
  switch (token.type) {
    case "space": return "";
    case "heading": return inlineToPlainText((token as Tokens.Heading).tokens);
    case "paragraph": return inlineToPlainText((token as Tokens.Paragraph).tokens);
    case "text": return token.tokens === undefined ? sanitizeTerminalText(token.text) : inlineToPlainText(token.tokens);
    case "code": return sanitizeTerminalText((token as Tokens.Code).text);
    case "hr": return "---";
    case "html": return sanitizeTerminalText(stripHtml(token.text)).trim();
    case "blockquote": {
      const inner = blocksToPlainText((token as Tokens.Blockquote).tokens);
      return inner.split("\n").map((line) => (line.length === 0 ? ">" : `> ${line}`)).join("\n");
    }
    case "list": return listToPlainText(token as Tokens.List);
    case "table": return tableToPlainText(token as Tokens.Table);
    default: {
      const generic = token as Tokens.Generic;
      return generic.tokens === undefined ? "" : blocksToPlainText(generic.tokens);
    }
  }
}

/** Inline-token flattening for prose (paragraphs/headings/list items/table cells): drops formatting markers, keeps a link's URL, and — unlike `plainText` — never runs `stripHtml` over plain text/codespan content. */
function inlineToPlainText(tokens: readonly Token[]): string {
  return sanitizeTerminalText(tokens.map((token) => inlineTokenToPlainText(token)).join(""));
}

function inlineTokenToPlainText(token: Token): string {
  switch (token.type) {
    case "text": return token.tokens === undefined ? token.text : inlineToPlainText(token.tokens);
    case "escape": return token.text;
    case "strong": return inlineToPlainText((token as Tokens.Strong).tokens);
    case "em": return inlineToPlainText((token as Tokens.Em).tokens);
    case "del": return inlineToPlainText((token as Tokens.Del).tokens);
    case "codespan": return token.text;
    case "link": {
      const link = token as Tokens.Link;
      const label = inlineToPlainText(link.tokens);
      return label === link.href ? label : `${label} (${link.href})`;
    }
    case "image": return `[image: ${token.text || token.href}]`;
    case "br": return "\n";
    case "html": return stripHtml(token.text);
    default: return "text" in token && typeof token.text === "string" ? token.text : "";
  }
}

function listItemBodyToPlainText(tokens: readonly Token[]): string {
  return tokens.map((token) => {
    if (token.type === "text" || token.type === "paragraph") {
      const inline = token.type === "paragraph" ? (token as Tokens.Paragraph).tokens : token.tokens ?? [token];
      return inlineToPlainText(inline);
    }
    return blockToPlainText(token);
  }).filter((line) => line.length > 0).join("\n");
}

function listToPlainText(token: Tokens.List): string {
  const start = typeof token.start === "number" ? token.start : 1;
  return token.items.map((item, index) => {
    const marker = item.task ? (item.checked ? "[x] " : "[ ] ") : token.ordered ? `${start + index}. ` : "- ";
    const body = listItemBodyToPlainText(item.tokens);
    const [firstLine = "", ...rest] = body.split("\n");
    return [`${marker}${firstLine}`, ...rest.map((line) => (line.length === 0 ? "" : `  ${line}`))].join("\n");
  }).join("\n");
}

function tableToPlainText(token: Tokens.Table): string {
  const rows = [token.header, ...token.rows].map((row) => row.map((cell) => inlineToPlainText(cell.tokens)));
  return rows.map((row) => row.join(" | ")).join("\n");
}

function ListItemTokens({ tokens, theme, width }: { readonly tokens: readonly Token[]; readonly theme: Theme; readonly width: number }): React.JSX.Element {
  return <>{tokens.map((token, index) => {
    if (token.type === "text" || token.type === "paragraph") {
      const inline = token.type === "paragraph" ? (token as Tokens.Paragraph).tokens : token.tokens ?? [token];
      return <Text key={index} color={theme.text}><InlineTokens tokens={inline} theme={theme} /></Text>;
    }
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

function pad(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - stringWidth(value)));
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
