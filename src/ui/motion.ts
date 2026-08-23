import { useEffect, useState } from "react";
import { supportsMotion } from "./theme.js";

const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const pulseFrames = ["·", "•", "●", "•"] as const;

export function useAnimationFrame(frameCount: number, interval = 90): number {
  const [frame, setFrame] = useState(0);
  const enabled = supportsMotion() && frameCount > 1;
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
