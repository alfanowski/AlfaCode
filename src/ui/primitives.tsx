import React from "react";
import { Box, Text } from "ink";
import type { Theme } from "./theme.js";
import { useSpinner } from "./motion.js";

export function Brand({ theme, compact = false }: { readonly theme: Theme; readonly compact?: boolean }): React.JSX.Element {
  return <Text bold><Text color={theme.accent}>◆</Text><Text color={theme.text}> Alfa</Text><Text color={theme.secondary}>Code</Text>{compact ? null : <Text color={theme.faint}> / agent terminal</Text>}</Text>;
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
  return <Text color={theme.accent}>{spinner} <Text color={theme.text}>{children}</Text></Text>;
}

export function ProgressBar({ value, width, theme }: { readonly value: number; readonly width: number; readonly theme: Theme }): React.JSX.Element {
  const safeWidth = Math.max(4, width);
  const clamped = Math.max(0, Math.min(1, value));
  const filled = Math.round(safeWidth * clamped);
  const tone = clamped >= 0.9 ? theme.danger : clamped >= 0.7 ? theme.warning : theme.accent;
  return <Text><Text color={tone}>{"━".repeat(filled)}</Text><Text color={theme.surfaceRaised}>{"━".repeat(safeWidth - filled)}</Text></Text>;
}

export function EmptyState({ theme }: { readonly theme: Theme }): React.JSX.Element {
  return <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
    <Box><Text bold color={theme.accent}>     ◆</Text></Box>
    <Box><Text bold color={theme.text}>ALFA</Text><Text bold color={theme.secondary}>CODE</Text></Box>
    <Box marginTop={1}><Text color={theme.muted}>One agent. Every model. Your terminal.</Text></Box>
    <Box marginTop={1} columnGap={2}>
      <KeyHint shortcut="/model" label="switch" theme={theme} />
      <KeyHint shortcut="/connect" label="add provider" theme={theme} />
      <KeyHint shortcut="/help" label="commands" theme={theme} />
    </Box>
  </Box>;
}
