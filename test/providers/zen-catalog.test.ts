import { describe, expect, it } from "vitest";
import { classifyZenModel, discoverZenModels } from "../../src/providers/zen/index.js";
import { CAPABILITIES, selectDefaultModel, type ModelDescriptor } from "../../src/providers/foundation/index.js";

describe("OpenCode Zen catalog", () => {
  it("classifies dynamic catalog models by explicit protocol hints before model names", async () => {
    const seen: { url?: string; authorization?: string } = {};
    const models = await discoverZenModels({
      apiKey: "zen-secret",
      baseUrl: "https://zen.example/v1/",
      fetch: async (input, init) => {
        seen.url = String(input);
        const authorization = new Headers(init?.headers).get("authorization");
        if (authorization !== null) seen.authorization = authorization;
        return Response.json({ data: [
          { id: "gpt-5", endpoint: "/responses" },
          { id: "claude-tool", npm: "@ai-sdk/anthropic" },
          { id: "gemini-fast", protocol: "google" },
          { id: "unknown-proxy" },
        ] });
      },
    });
    expect(seen).toEqual({ url: "https://zen.example/v1/models", authorization: "Bearer zen-secret" });
    expect(models.map((model) => [model.id, model.wireProtocol, model.support])).toEqual([
      ["gpt-5", "openai-responses", "best-effort"],
      ["claude-tool", "anthropic-messages", "best-effort"],
      ["gemini-fast", "gemini-generate-content", "best-effort"],
      ["unknown-proxy", "openai-chat", "best-effort"],
    ]);
    expect(classifyZenModel({ id: "qwen3" })).toBe("anthropic-messages");
  });

  it("does not expose the API key in discovery errors", async () => {
    await expect(discoverZenModels({
      apiKey: "zen-secret",
      fetch: async () => new Response("upstream failed api_key=zen-secret", { status: 401 }),
    })).rejects.toThrow("[REDACTED]");
    await expect(discoverZenModels({
      apiKey: "zen-secret",
      fetch: async () => new Response("upstream failed api_key=zen-secret", { status: 401 }),
    })).rejects.not.toThrow("zen-secret");
  });

  it("does not make deprecated or account-validated catalog entries implicit defaults", () => {
    const entries: readonly ModelDescriptor[] = [
      { providerId: "google", id: "old", displayName: "Old", wireProtocol: "gemini-generate-content", capabilities: CAPABILITIES["gemini-generate-content"], availability: "deprecated", support: "contract-tested" },
      { providerId: "google", id: "needs-access", displayName: "Needs access", wireProtocol: "gemini-generate-content", capabilities: CAPABILITIES["gemini-generate-content"], availability: "account-validation-required", support: "contract-tested" },
      { providerId: "google", id: "new", displayName: "New", wireProtocol: "gemini-generate-content", capabilities: CAPABILITIES["gemini-generate-content"], availability: "available", support: "contract-tested" },
    ];
    expect(selectDefaultModel(entries)?.id).toBe("new");
    expect(selectDefaultModel(entries, "old")).toBeUndefined();
  });
});
