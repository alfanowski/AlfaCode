import React, { useMemo } from "react";
import { Box, Text } from "ink";
import { marked, type Token, type Tokens } from "marked";
import stringWidth from "string-width";
import type { Theme } from "./theme.js";

export function Markdown({ children, theme, width = 88 }: { readonly children: string; readonly theme: Theme; readonly width?: number }): React.JSX.Element {
  const tokens = useMemo(() => marked.lexer(sanitizeTerminalText(children), { gfm: true, breaks: true }), [children]);
  return <Box flexDirection="column">{tokens.map((token, index) => <BlockToken key={`${token.type}-${index}`} token={token} theme={theme} width={width} />)}</Box>;
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
