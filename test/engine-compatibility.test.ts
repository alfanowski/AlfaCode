import { describe, expect, it } from "vitest";
import { PINNED_CLAUDE_CODE_VERSION, checkEngineCompatibility } from "../src/engine-compatibility.js";

describe("engine compatibility", () => {
  it("accepts only the pinned Claude Code engine", () => {
    expect(checkEngineCompatibility(PINNED_CLAUDE_CODE_VERSION)).toEqual({
      compatible: true,
      expected: PINNED_CLAUDE_CODE_VERSION,
      actual: PINNED_CLAUDE_CODE_VERSION,
    });
    expect(checkEngineCompatibility("2.1.999")).toMatchObject({
      compatible: false,
      expected: PINNED_CLAUDE_CODE_VERSION,
      actual: "2.1.999",
    });
  });
});
