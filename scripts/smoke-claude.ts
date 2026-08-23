import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listenLocalGateway } from "../src/gateway.js";
import { launchClaude } from "../src/claude-launcher.js";
import { encodeModelId } from "../src/model-id.js";
import type { CanonicalStreamEvent, Provider } from "../src/provider-contract.js";

const upstreamModel = "gemini-smoke";
const routedModel = encodeModelId("smoke", upstreamModel);
const token = "alfacode-local-smoke-token";
const configDir = await mkdtemp(join(tmpdir(), "alfacode-claude-smoke-"));
const provider: Provider = {
  id: "smoke",
  models: [{ id: upstreamModel, displayName: "AlfaCode Smoke Model" }],
  async *streamMessage(): AsyncIterable<CanonicalStreamEvent> {
    yield {
      type: "message_start",
      message: {
        id: "msg_alfacode_smoke",
        type: "message",
        role: "assistant",
        model: routedModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    };
    yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
    yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ALFACODE_SMOKE_OK" } };
    yield { type: "content_block_stop", index: 0 };
    yield { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { input_tokens: 1, output_tokens: 1 } };
    yield { type: "message_stop" };
  },
  async countTokens() { return { input_tokens: 1, output_tokens: 0 }; },
  close() {},
};

const gateway = await listenLocalGateway({ token, providers: [provider], pingIntervalMs: 100 });
try {
  const exitCode = await launchClaude({
    claudeArgs: ["-p", "Return the smoke marker.", "--model", routedModel, "--output-format", "text"],
    baseUrl: gateway.address,
    authToken: token,
    configDir,
    defaultModelId: routedModel,
    contextWindowTokens: 1_000_000,
  });
  if (exitCode !== 0) throw new Error(`Claude Code smoke test exited with ${exitCode}`);
} finally {
  await gateway.app.close();
  await rm(configDir, { recursive: true, force: true });
}
