import { describe, expect, it, vi } from "vitest";
import { PermissionBroker } from "../src/permission-broker.js";

describe("PermissionBroker", () => {
  it("surfaces and resolves queued tool permission requests", async () => {
    const broker = new PermissionBroker();
    const listener = vi.fn();
    broker.subscribe(listener);
    const controller = new AbortController();
    const result = broker.canUseTool("Bash", { command: "pwd" }, {
      signal: controller.signal,
      suggestions: [],
      toolUseID: "tool-1",
      requestId: "request-1",
      decisionReason: "Requires approval",
    });

    expect(broker.current()).toMatchObject({ toolName: "Bash", input: { command: "pwd" }, reason: "Requires approval" });
    broker.allow();
    await expect(result).resolves.toEqual({ behavior: "allow" });
    expect(broker.current()).toBeUndefined();
    expect(listener).toHaveBeenLastCalledWith(undefined);
  });

  it("rejects pending requests when the permission surface closes", async () => {
    const broker = new PermissionBroker();
    const controller = new AbortController();
    const result = broker.canUseTool("Write", { file_path: "x" }, { signal: controller.signal, suggestions: [], toolUseID: "tool-2", requestId: "request-2" });
    broker.close();
    await expect(result).rejects.toThrow("Permission surface closed");
  });

  it("surfaces AskUserQuestion separately and returns the exact updated input contract", async () => {
    const broker = new PermissionBroker();
    const controller = new AbortController();
    const result = broker.canUseTool("AskUserQuestion", {
      questions: [{
        question: "Which features?",
        header: "Features",
        multiSelect: true,
        options: [
          { label: "Markdown", description: "Rich responses" },
          { label: "Motion", description: "Animated status" },
        ],
      }],
    }, { signal: controller.signal, suggestions: [], toolUseID: "tool-question", requestId: "request-question" });

    expect(broker.current()).toBeUndefined();
    expect(broker.currentQuestions()).toMatchObject({ questions: [{ header: "Features", multiSelect: true }] });
    broker.answerQuestions({ "Which features?": "Markdown, Motion" });
    await expect(result).resolves.toMatchObject({
      behavior: "allow",
      updatedInput: { answers: { "Which features?": "Markdown, Motion" } },
    });
  });

  it("rejects malformed question payloads instead of parking the engine", async () => {
    const broker = new PermissionBroker();
    const result = broker.canUseTool("AskUserQuestion", { questions: [] }, { signal: new AbortController().signal, suggestions: [], toolUseID: "tool-invalid", requestId: "request-invalid" });
    await expect(result).resolves.toEqual({ behavior: "deny", message: "AskUserQuestion received an invalid question payload" });
  });
});
