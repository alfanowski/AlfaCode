import React from "react";
import { Box, Static, Text } from "ink";

/**
 * Renders an already-append-only transcript log (see `appendTranscriptLog` in
 * ./screen-reader-mode.js) through Ink's `<Static>`, so every line, once printed, is written to
 * the real terminal exactly once and never erased or rewritten by a later render — the
 * screen-reader-mode counterpart to the boxed UI's scrolling, redrawn `<Transcript>`.
 */
export function ScreenReaderTranscript({ lines, busy }: { readonly lines: readonly string[]; readonly busy: boolean }): React.JSX.Element {
  return <Box flexDirection="column">
    <Static items={[...lines]}>{(line, index) => <Text key={index}>{line}</Text>}</Static>
    {lines.length === 0 && !busy ? <Text>Ask AlfaCode anything, or type / for commands.</Text> : null}
    {busy ? <Text>Working…</Text> : null}
  </Box>;
}
