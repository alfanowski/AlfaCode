import { useEffect, useState } from "react";
import { supportsMotion } from "./theme.js";
import { isScreenReaderMode } from "./screen-reader-mode.js";

const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const pulseFrames = ["·", "•", "●", "•"] as const;

/**
 * Whether frame-based animation should run at all. Extends `supportsMotion` (CI, `TERM=dumb`,
 * `ALFACODE_REDUCED_MOTION=1`) rather than replacing it: screen-reader mode implies reduced
 * motion too, since its whole point is a linear, non-repainting output that a spinner ticking
 * every frame would fight against — even outside the dedicated screen-reader render path (e.g.
 * shared primitives like `LoadingLabel` during provider setup).
 */
export function shouldAnimate(environment: NodeJS.ProcessEnv = process.env): boolean {
  return supportsMotion(environment) && !isScreenReaderMode(environment);
}

export function useAnimationFrame(frameCount: number, interval = 90): number {
  const [frame, setFrame] = useState(0);
  const enabled = shouldAnimate() && frameCount > 1;
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setFrame((current) => (current + 1) % frameCount), interval);
    return () => clearInterval(timer);
  }, [enabled, frameCount, interval]);
  return enabled ? frame : 0;
}

export function useSpinner(active = true): string {
  const frame = useAnimationFrame(active ? spinnerFrames.length : 1);
  return active ? (spinnerFrames[frame] ?? spinnerFrames[0]) : "✓";
}

export function usePulse(active = true): string {
  const frame = useAnimationFrame(active ? pulseFrames.length : 1, 180);
  return active ? (pulseFrames[frame] ?? pulseFrames[0]) : "·";
}
