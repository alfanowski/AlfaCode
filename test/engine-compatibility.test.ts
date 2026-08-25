import { describe, expect, it } from "vitest";
import { PINNED_CLAUDE_CODE_VERSION, checkEngineCompatibility, pendingEngineCompatibility } from "../src/engine-compatibility.js";

describe("engine compatibility", () => {
  it("accepts only the pinned Claude Code engine", () => {
    expect(checkEngineCompatibility(PINNED_CLAUDE_CODE_VERSION)).toEqual({
      status: "compatible",
      compatible: true,
      expected: PINNED_CLAUDE_CODE_VERSION,
      actual: PINNED_CLAUDE_CODE_VERSION,
    });
    expect(checkEngineCompatibility("2.1.999")).toMatchObject({
      status: "incompatible",
      compatible: false,
      expected: PINNED_CLAUDE_CODE_VERSION,
      actual: "2.1.999",
    });
  });

  it("represents the pre-init engine state without self-validating the pin", () => {
    expect(pendingEngineCompatibility()).toEqual({
      status: "pending",
      compatible: false,
      expected: PINNED_CLAUDE_CODE_VERSION,
      actual: "pending",
      reason: `Claude Code ${PINNED_CLAUDE_CODE_VERSION} has not been verified yet`,
    });
  });
});
