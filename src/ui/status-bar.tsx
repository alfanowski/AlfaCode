import React from "react";
import { Box, Text } from "ink";
import { useFlash } from "./motion.js";
import type { Theme } from "./theme.js";

/**
 * A single-line, ephemeral notice rendered just below the composer — the dedicated home for
 * transient UI feedback (a keyboard hint, a settings-toggle confirmation) that must never pollute
 * the conversation transcript above it. See `chat-tui.tsx`'s `statusMessage`/`showStatus` for the
 * separate state channel this reads from, entirely independent of the `messages` array that feeds
 * `Transcript`/`appendSystem`.
 *
 * Deliberately styled to be mistaken for neither neighbor: italic and a plain "›" marker, never
 * the transcript's own system-row "!" marker or the composer's bold "❯" prompt marker, and no
 * panel border (so it doesn't read as another bordered box like the composer or a picker panel).
 *
 * Dismissal is owned entirely by the caller — `message` going back to `undefined`, typically on
 * the next keystroke (see the `useInput` handler in `chat-tui.tsx`) — rather than a timer in here.
 * The brief color pulse below is purely decorative, drawing the eye when a *new* notice replaces
 * an old one; it rides the shared animation clock (`useFlash`) rather than an ad-hoc timer of its
 * own, per this codebase's one-shared-clock rule for anything frame-based (see motion.ts).
 */
export function StatusBar({ message, theme }: { readonly message: string | undefined; readonly theme: Theme }): React.JSX.Element | null {
  const flash = useFlash(message);
  if (message === undefined) return null;
  return <Box paddingX={1}><Text italic color={flash ? theme.accent : theme.secondarySoft}>› {message}</Text></Box>;
}
