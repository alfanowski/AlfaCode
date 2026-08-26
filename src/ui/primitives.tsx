import React from "react";
import { Box, Text } from "ink";
import type { Theme } from "./theme.js";
import { useSpinner } from "./motion.js";
import { isScreenReaderMode } from "./screen-reader-mode.js";

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

function Starfield({ theme, width }: { readonly theme: Theme; readonly width?: number }): React.JSX.Element | null {
  if (width !== undefined && width < 30) return null;
  return <Box flexDirection="column" alignItems="center">
    <Text color={theme.faint}>·        ✧           ·</Text>
    <Text color={theme.faint}>    ✧         <Text color={theme.secondary}>✦</Text>       ·  </Text>
  </Box>;
}

export function EmptyState({ theme, width }: { readonly theme: Theme; readonly width?: number }): React.JSX.Element {
  return <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
    <Starfield theme={theme} {...(width === undefined ? {} : { width })} />
    <Box><Text bold color={theme.accent}>     ✦</Text></Box>
    <Box><Text bold color={theme.text}>ALFA</Text><Text bold color={theme.secondary}>CODE</Text></Box>
    <Box marginTop={1}><Text color={theme.muted}>One agent. Every model. Your terminal.</Text></Box>
    <Box marginTop={1} columnGap={2}>
      <KeyHint shortcut="/model" label="switch" theme={theme} />
      <KeyHint shortcut="/connect" label="add provider" theme={theme} />
      <KeyHint shortcut="/help" label="commands" theme={theme} />
    </Box>
  </Box>;
}
