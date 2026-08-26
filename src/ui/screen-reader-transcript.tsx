import React from "react";
import { Box, Static, Text } from "ink";

/** Mirrors `TranscriptStage` from ../chat-tui.js without importing it, to keep this plain-text
 * path free of any dependency on the boxed UI's own module. */
type Stage = "idle" | "thinking" | "writing" | "tool";

/** Plain-text counterpart of the boxed UI's `ThinkingLine`/`ToolActivity` phrasing — same three
 * distinct busy states, no color or animation, just the words changing. */
function stageLabel(stage: Stage): string | undefined {
  if (stage === "thinking") return "Thinking…";
  if (stage === "writing") return "Writing…";
  if (stage === "tool") return "Running a tool…";
  return undefined;
}

/**
 * Renders an already-append-only transcript log (see `appendTranscriptLog` in
 * ./screen-reader-mode.js) through Ink's `<Static>`, so every line, once printed, is written to
 * the real terminal exactly once and never erased or rewritten by a later render — the
 * screen-reader-mode counterpart to the boxed UI's scrolling, redrawn `<Transcript>`.
 */
export function ScreenReaderTranscript({ lines, stage }: { readonly lines: readonly string[]; readonly stage: Stage }): React.JSX.Element {
  const label = stageLabel(stage);
  return <Box flexDirection="column">
    <Static items={[...lines]}>{(line, index) => <Text key={index}>{line}</Text>}</Static>
    {lines.length === 0 && stage === "idle" ? <Text>Ask AlfaCode anything, or type / for commands.</Text> : null}
    {label === undefined ? null : <Text>{label}</Text>}
  </Box>;
}
