export const ALFACODE_CLIENT_ID = "alfacode/0.1.0";
export const PINNED_AGENT_SDK_VERSION = "0.3.241";
export const PINNED_CLAUDE_CODE_VERSION = "2.1.241";

export interface EngineCompatibility {
  readonly status: "pending" | "compatible" | "incompatible";
  readonly compatible: boolean;
  readonly expected: string;
  readonly actual: string;
  readonly reason?: string;
}

/** Native mode renders before the deferred SDK process reports its version. */
export function pendingEngineCompatibility(): EngineCompatibility {
  return {
    status: "pending",
    compatible: false,
    expected: PINNED_CLAUDE_CODE_VERSION,
    actual: "pending",
    reason: `Claude Code ${PINNED_CLAUDE_CODE_VERSION} has not been verified yet`,
  };
}

/** Exact pinning prevents a global Claude Code update from changing AlfaCode. */
export function checkEngineCompatibility(actualVersion: string): EngineCompatibility {
  if (actualVersion === PINNED_CLAUDE_CODE_VERSION) {
    return { status: "compatible", compatible: true, expected: PINNED_CLAUDE_CODE_VERSION, actual: actualVersion };
  }
  return {
    status: "incompatible",
    compatible: false,
    expected: PINNED_CLAUDE_CODE_VERSION,
    actual: actualVersion,
    reason: `AlfaCode expects Claude Code ${PINNED_CLAUDE_CODE_VERSION}, but the Agent SDK started ${actualVersion}`,
  };
}
