import { afterEach, describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { encodeModelId } from "../src/model-id.js";
import { ModelPicker } from "../src/chat-tui.js";
import { CAPABILITIES, type ModelDescriptor } from "../src/providers/foundation/types.js";
import { getTheme } from "../src/ui/theme.js";

const theme = getTheme("nova");

function model(overrides: Partial<ModelDescriptor> & Pick<ModelDescriptor, "providerId" | "id" | "displayName" | "wireProtocol">): ModelDescriptor {
  return {
    availability: "available",
    capabilities: CAPABILITIES[overrides.wireProtocol],
    support: "contract-tested",
    ...overrides,
  };
}

const anthropicModel = model({ providerId: "anthropic", id: "claude-sonnet-5", displayName: "Claude Sonnet 5", wireProtocol: "anthropic-messages", contextWindow: 200_000 });
const geminiModel = model({ providerId: "google", id: "gemini-2.5-pro", displayName: "Gemini 2.5 Pro", wireProtocol: "gemini-generate-content", support: "best-effort", contextWindow: 1_000_000 });
const zenModel = model({ providerId: "zen", id: "free-model", displayName: "Free Model", wireProtocol: "openai-chat" });

const baseProps = { filter: "", theme, height: 20, width: 90 };

afterEach(() => {
  delete process.env.ALFACODE_SCREEN_READER;
});

describe("ModelPicker", () => {
  it("groups models by provider with a per-group header and model count", () => {
    const frame = render(<ModelPicker {...baseProps} models={[anthropicModel, geminiModel, zenModel]} cursor={0} activeRoute="" effortLevel={undefined} />).lastFrame() ?? "";
    expect(frame).toContain("anthropic");
    expect(frame).toContain("google");
    expect(frame).toContain("zen");
    expect(frame).toContain("1 model");
  });

  it("marks the currently routed model with a distinct 'current' indicator, separate from the cursor", () => {
    const activeRoute = encodeModelId(geminiModel.providerId, geminiModel.id);
    // Cursor sits on the first (anthropic) row while a different model (gemini) is actually routed.
    const frame = render(<ModelPicker {...baseProps} models={[anthropicModel, geminiModel, zenModel]} cursor={0} activeRoute={activeRoute} effortLevel={undefined} />).lastFrame() ?? "";
    expect(frame).toContain("❯");
    expect(frame).toContain("current");
  });

  it("shows a verified badge for contract-tested models and best-effort for the rest", () => {
    const frame = render(<ModelPicker {...baseProps} models={[anthropicModel, geminiModel]} cursor={0} activeRoute="" effortLevel={undefined} />).lastFrame() ?? "";
    expect(frame).toContain("verified");
    expect(frame).toContain("best-effort");
  });

  it("shows the effort segmented control, with the active level bracketed, for an Anthropic-wire model at the cursor", () => {
    const frame = render(<ModelPicker {...baseProps} models={[anthropicModel, geminiModel]} cursor={0} activeRoute="" effortLevel="high" />).lastFrame() ?? "";
    expect(frame).toContain("Effort");
    expect(frame).toContain("[high]");
    expect(frame).toContain("low");
    expect(frame).toContain("max");
  });

  it("shows 'default' as the active pip when no explicit effort level is set", () => {
    const frame = render(<ModelPicker {...baseProps} models={[anthropicModel]} cursor={0} activeRoute="" effortLevel={undefined} />).lastFrame() ?? "";
    expect(frame).toContain("[default]");
  });

  it("shows a clear 'not available' message instead of the effort control for a non-Anthropic-wire model, never a silently inert control", () => {
    const frame = render(<ModelPicker {...baseProps} models={[geminiModel, anthropicModel]} cursor={0} activeRoute="" effortLevel="high" />).lastFrame() ?? "";
    expect(frame).toContain("not available for this model");
    expect(frame).not.toContain("[high]");
  });

  it("prefixes numbered labels in screen-reader mode", () => {
    process.env.ALFACODE_SCREEN_READER = "1";
    const frame = render(<ModelPicker {...baseProps} models={[anthropicModel, geminiModel]} cursor={0} activeRoute="" effortLevel={undefined} />).lastFrame() ?? "";
    expect(frame).toContain("1) Claude Sonnet 5");
    expect(frame).toContain("2) Gemini 2.5 Pro");
  });

  it("shows an empty-state message when no model matches the filter", () => {
    const frame = render(<ModelPicker {...baseProps} models={[]} cursor={0} activeRoute="" effortLevel={undefined} />).lastFrame() ?? "";
    expect(frame).toContain("No verified tool-capable model matches this filter.");
  });
});
