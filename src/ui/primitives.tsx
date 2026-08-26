import React from "react";
import { Box, Text } from "ink";
import type { Theme } from "./theme.js";
import { useSpinner, useTwinkle } from "./motion.js";
import { isScreenReaderMode } from "./screen-reader-mode.js";

/**
 * Reusable panel chrome: rounded corners read as considered/premium rather than Ink's plain
 * default box, and border color signals state at a glance (accent = active/focused, otherwise a
 * quiet neutral border). One place to keep every panel visually consistent as more of them adopt
 * it.
 */
export function panelBorder(theme: Theme, emphasis: "active" | "quiet" = "quiet"): { readonly borderStyle: "round"; readonly borderColor: string } {
  return { borderStyle: "round", borderColor: emphasis === "active" ? theme.accent : theme.border };
}

export function Brand({ theme, compact = false }: { readonly theme: Theme; readonly compact?: boolean }): React.JSX.Element {
  return <Text bold><Text color={theme.accent}>✦</Text><Text color={theme.text}> Alfa</Text><Text color={theme.secondary}>Code</Text>{compact ? null : <Text color={theme.faint}> / agent terminal</Text>}</Text>;
}

export function KeyHint({ shortcut, label, theme }: { readonly shortcut: string; readonly label: string; readonly theme: Theme }): React.JSX.Element {
  return <Text><Text bold color={theme.muted}>{shortcut}</Text><Text color={theme.faint}> {label}</Text></Text>;
}

export function HintBar({ theme, children }: React.PropsWithChildren<{ readonly theme: Theme }>): React.JSX.Element {
  return <Box marginTop={1} columnGap={2}><Text color={theme.faint}>{children}</Text></Box>;
}

export function SectionTitle({ title, detail, theme }: { readonly title: string; readonly detail?: string; readonly theme: Theme }): React.JSX.Element {
  return <Box marginBottom={1} columnGap={1}>
    <Text bold color={theme.text}>{title}</Text>
    {detail === undefined ? null : <Text color={theme.faint}>— {detail}</Text>}
  </Box>;
}

export function StatusBadge({ label, tone, theme }: { readonly label: string; readonly tone: "accent" | "success" | "warning" | "danger" | "muted"; readonly theme: Theme }): React.JSX.Element {
  const color = tone === "accent" ? theme.accent : tone === "success" ? theme.success : tone === "warning" ? theme.warning : tone === "danger" ? theme.danger : theme.muted;
  return <Text color={color}>● <Text bold>{label}</Text></Text>;
}

export function LoadingLabel({ children, theme }: React.PropsWithChildren<{ readonly theme: Theme }>): React.JSX.Element {
  const spinner = useSpinner();
  // Screen-reader mode disables the animation itself (see ui/motion.ts), but the glyph would
  // still render as one static, meaningless braille character; a plain label reads better.
  if (isScreenReaderMode()) return <Text color={theme.text}>{children}</Text>;
  return <Text color={theme.accent}>{spinner} <Text color={theme.text}>{children}</Text></Text>;
}

function hexToRgb(hex: string): readonly [number, number, number] {
  const value = hex.replace("#", "");
  return [Number.parseInt(value.slice(0, 2), 16), Number.parseInt(value.slice(2, 4), 16), Number.parseInt(value.slice(4, 6), 16)];
}

/** Linear RGB interpolation between two hex colors; no perceptual color space math needed here. */
export function mixHex(from: string, to: string, ratio: number): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const [fr, fg, fb] = hexToRgb(from);
  const [tr, tg, tb] = hexToRgb(to);
  const mix = (a: number, b: number): number => Math.round(a + (b - a) * clamped);
  return `#${[mix(fr, tr), mix(fg, tg), mix(fb, tb)].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

export function ProgressBar({ value, width, theme }: { readonly value: number; readonly width: number; readonly theme: Theme }): React.JSX.Element {
  const safeWidth = Math.max(4, width);
  const clamped = Math.max(0, Math.min(1, value));
  const filled = Math.round(safeWidth * clamped);
  // Below the warning threshold, the filled portion gradients from accent to secondary
  // (a supernova-style glow under the nova theme). At warning/danger thresholds a flat,
  // unambiguous color communicates urgency better than a gradient would.
  const urgent = clamped >= 0.9 ? theme.danger : clamped >= 0.7 ? theme.warning : undefined;
  const fill = Array.from({ length: filled }, (_, index) => {
    const color = urgent ?? mixHex(theme.accent, theme.secondary, filled <= 1 ? 0 : index / (filled - 1));
    return <Text key={index} color={color}>━</Text>;
  });
  return <Text>{fill}<Text color={theme.surfaceRaised}>{"━".repeat(safeWidth - filled)}</Text></Text>;
}

interface BurstPoint {
  /** Row offset from the burst's center (negative = above). */
  readonly row: number;
  /** Column offset from the burst's center (negative = left). */
  readonly col: number;
  readonly glyph: string;
  /** 0 = pure accent, 1 = pure secondary; where this point sits in the red→gold blend. */
  readonly mix: number;
  /** Outer scattered points twinkle independently; the structural core stays steady. */
  readonly twinkle?: boolean;
}

// A compact radial starburst: a steady, fully-blended accent→secondary core (the "nova" itself —
// a bright center with rays in every direction) surrounded by a handful of independently
// twinkling distant points. Coordinates are relative offsets from the center, not hand-aligned
// strings, so the shape can't drift out of alignment when edited.
const burstPoints: readonly BurstPoint[] = [
  // Horizontal ray through the core, left to right, sweeping the full accent→secondary blend.
  { row: 0, col: -6, glyph: "─", mix: 0 },
  { row: 0, col: -5, glyph: "─", mix: 0.08 },
  { row: 0, col: -4, glyph: "─", mix: 0.17 },
  { row: 0, col: -3, glyph: "─", mix: 0.25 },
  { row: 0, col: -2, glyph: "─", mix: 0.33 },
  { row: 0, col: -1, glyph: "─", mix: 0.42 },
  { row: 0, col: 0, glyph: "✦", mix: 0.5 },
  { row: 0, col: 1, glyph: "─", mix: 0.58 },
  { row: 0, col: 2, glyph: "─", mix: 0.67 },
  { row: 0, col: 3, glyph: "─", mix: 0.75 },
  { row: 0, col: 4, glyph: "─", mix: 0.83 },
  { row: 0, col: 5, glyph: "─", mix: 0.92 },
  { row: 0, col: 6, glyph: "─", mix: 1 },
  // Vertical ray through the core.
  { row: -1, col: 0, glyph: "│", mix: 0.3 },
  { row: 1, col: 0, glyph: "│", mix: 0.7 },
  // Diagonal rays (2 columns per row of rise — monospace glyphs read roughly twice as tall as
  // wide, so a shallower run than a true 1:1 slope is what actually looks diagonal on screen).
  { row: -1, col: -2, glyph: "╲", mix: 0.2 },
  { row: -1, col: 2, glyph: "╱", mix: 0.8 },
  { row: 1, col: -2, glyph: "╱", mix: 0.2 },
  { row: 1, col: 2, glyph: "╲", mix: 0.8 },
  // An outer ring at the 8 compass points (N/S/E/W/NE/NW/SE/SW), a consistent step past where the
  // core rays end — row offsets are roughly half the matching column offsets so every point reads
  // as equidistant despite monospace glyphs being about twice as tall as they are wide. All
  // twinkle independently of the steady core, so the ring shimmers rather than the whole piece
  // blinking as one unit.
  { row: -3, col: 0, glyph: "✧", mix: 0.5, twinkle: true },
  { row: 3, col: 0, glyph: "✧", mix: 0.5, twinkle: true },
  { row: 0, col: -9, glyph: "✧", mix: 0, twinkle: true },
  { row: 0, col: 9, glyph: "✧", mix: 1, twinkle: true },
  { row: -2, col: -6, glyph: "·", mix: 0.1, twinkle: true },
  { row: -2, col: 6, glyph: "·", mix: 0.9, twinkle: true },
  { row: 2, col: -6, glyph: "·", mix: 0.1, twinkle: true },
  { row: 2, col: 6, glyph: "·", mix: 0.9, twinkle: true },
  // A few genuinely irregular far-background stars for depth, off the compass lines.
  { row: -3, col: -8, glyph: "·", mix: 0.15, twinkle: true },
  { row: 3, col: 8, glyph: "·", mix: 0.85, twinkle: true },
  { row: -1, col: 11, glyph: "·", mix: 0.75, twinkle: true },
  { row: 1, col: -11, glyph: "·", mix: 0.25, twinkle: true },
];

const twinklingBurstPoints = burstPoints.filter((point) => point.twinkle === true);

function Starburst({ theme, width }: { readonly theme: Theme; readonly width?: number }): React.JSX.Element | null {
  const twinkle = useTwinkle(twinklingBurstPoints.length, { interval: 260 });
  if (width !== undefined && width < 36) return null;
  const minCol = Math.min(...burstPoints.map((point) => point.col));
  const maxCol = Math.max(...burstPoints.map((point) => point.col));
  const minRow = Math.min(...burstPoints.map((point) => point.row));
  const maxRow = Math.max(...burstPoints.map((point) => point.row));
  const rows = Array.from({ length: maxRow - minRow + 1 }, (_, rowIndex) => rowIndex + minRow);
  return <Box flexDirection="column" alignItems="center">
    {rows.map((row) => {
      const pointsInRow = burstPoints.filter((point) => point.row === row).sort((left, right) => left.col - right.col);
      const cells: React.JSX.Element[] = [];
      let cursor = minCol;
      for (const point of pointsInRow) {
        if (point.col > cursor) cells.push(<Text key={`gap-${cursor}`}>{" ".repeat(point.col - cursor)}</Text>);
        const level = point.twinkle === true ? (twinkle[twinklingBurstPoints.indexOf(point)] ?? 2) / 2 : 1;
        const color = mixHex(theme.faint, mixHex(theme.accent, theme.secondary, point.mix), level);
        cells.push(<Text key={`glyph-${point.col}`} color={color}>{point.glyph}</Text>);
        cursor = point.col + 1;
      }
      if (cursor <= maxCol) cells.push(<Text key={`gap-tail-${row}`}>{" ".repeat(maxCol - cursor + 1)}</Text>);
      return <Text key={row}>{cells}</Text>;
    })}
    <Text> </Text>
  </Box>;
}

export function EmptyState({ theme, width }: { readonly theme: Theme; readonly width?: number }): React.JSX.Element {
  return <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
    <Starburst theme={theme} {...(width === undefined ? {} : { width })} />
    <Box><Text bold color={theme.text}>ALFA</Text><Text bold color={theme.secondary}>CODE</Text></Box>
    <Box marginTop={1}><Text color={theme.muted}>One agent. Every model. Your terminal.</Text></Box>
    <Box marginTop={1} columnGap={2}>
      <KeyHint shortcut="/model" label="switch" theme={theme} />
      <KeyHint shortcut="/connect" label="add provider" theme={theme} />
      <KeyHint shortcut="/help" label="commands" theme={theme} />
    </Box>
  </Box>;
}
