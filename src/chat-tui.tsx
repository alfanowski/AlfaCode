import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import type { PermissionMode, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AlfaCodeConfig, ProviderRecord } from "./config.js";
import type { ModelDescriptor } from "./providers/foundation/types.js";
import { encodeModelId } from "./model-id.js";
import type { AgentSession, AgentSessionIdentity } from "./agent-session.js";
import type { PermissionBroker, PermissionRequest } from "./permission-broker.js";
import type { UsageSummary } from "./usage-ledger.js";

export type ChatAction =
  | { readonly type: "exit" }
  | { readonly type: "connect" }
  | { readonly type: "delete-provider"; readonly providerId: string }
  | { readonly type: "reconnect-provider"; readonly providerId: string }
  | { readonly type: "set-default-provider"; readonly providerId: string };

export interface ChatTuiOptions {
  readonly session: AgentSession;
  readonly identity: AgentSessionIdentity;
  readonly config: AlfaCodeConfig;
  readonly models: readonly ModelDescriptor[];
  readonly permissions: PermissionBroker;
  readonly loadUsage: () => Promise<UsageSummary>;
}

interface TranscriptItem {
  readonly id: string;
  readonly role: "user" | "assistant" | "tool" | "system";
  readonly text: string;
}

type Screen = "chat" | "models" | "providers" | "usage" | "permissions" | "help";
const modes: readonly PermissionMode[] = ["default", "acceptEdits", "plan", "dontAsk", "auto"];
const palette = { accent: "cyan", secondary: "magenta", muted: "gray", danger: "red", success: "green" } as const;

export async function runChatTui(options: ChatTuiOptions): Promise<ChatAction> {
  let resolveAction!: (action: ChatAction) => void;
  let settled = false;
  const action = new Promise<ChatAction>((resolve) => { resolveAction = resolve; });
  const settle = (value: ChatAction): void => { if (!settled) { settled = true; resolveAction(value); } };
  const instance = render(<ChatTui {...options} resolveAction={settle} />, { exitOnCtrlC: false, patchConsole: false });
  await instance.waitUntilExit();
  settle({ type: "exit" });
  return action;
}

function ChatTui({ session, identity, config, models, permissions, loadUsage, resolveAction }: ChatTuiOptions & { readonly resolveAction: (action: ChatAction) => void }): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [screen, setScreen] = useState<Screen>("chat");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<TranscriptItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [modelCursor, setModelCursor] = useState(0);
  const [modelFilter, setModelFilter] = useState("");
  const [providerCursor, setProviderCursor] = useState(0);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string>();
  const [usage, setUsage] = useState<UsageSummary>();
  const [contextUsage, setContextUsage] = useState<{ readonly totalTokens: number; readonly maxTokens: number; readonly percentage: number; readonly model: string }>();
  const [permissionCursor, setPermissionCursor] = useState(1);
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest>();
  const [permissionMode, setPermissionModeState] = useState<PermissionMode>(identity.compatibility.compatible ? "default" : "dontAsk");
  const [activeModel, setActiveModel] = useState(identity.model);

  useEffect(() => session.subscribe((message) => {
    setMessages((current) => reduceSdkMessage(current, message));
    const routedModel = routedModelFromMessage(message);
    if (routedModel !== undefined) setActiveModel(routedModel);
    if (message.type === "result") setBusy(false);
  }), [session]);
  useEffect(() => {
    let active = true;
    void session.identity().then((resolved) => {
      if (!active) return;
      setActiveModel(resolved.model);
      if (!resolved.compatibility.compatible) appendSystem(setMessages, resolved.compatibility.reason ?? "Unsupported Claude Code engine version.");
    }).catch((error: unknown) => {
      if (active) {
        setBusy(false);
        appendSystem(setMessages, error instanceof Error ? error.message : String(error));
      }
    });
    return () => { active = false; };
  }, [session]);
  useEffect(() => permissions.subscribe(setPendingPermission), [permissions]);

  const callableModels = useMemo(() => models.filter((model) => model.availability === "available" && model.capabilities.tools), [models]);
  const filteredModels = useMemo(() => {
    const query = modelFilter.toLowerCase();
    return callableModels.filter((model) => `${model.displayName} ${model.providerId} ${model.id}`.toLowerCase().includes(query));
  }, [callableModels, modelFilter]);
  const finish = (action: ChatAction): void => { resolveAction(action); exit(); };

  useInput((text, key) => {
    if (pendingPermission !== undefined) {
      if (key.leftArrow) setPermissionCursor((current) => Math.max(0, current - 1));
      else if (key.rightArrow) setPermissionCursor((current) => Math.min(pendingPermission.suggestions.length > 0 ? 2 : 1, current + 1));
      else if (key.return) {
        if (permissionCursor === 0) permissions.deny();
        else permissions.allow(permissionCursor === 2);
        setPermissionCursor(1);
      }
      return;
    }
    if (confirmDeleteId !== undefined) {
      if (text.toLowerCase() === "y") finish({ type: "delete-provider", providerId: confirmDeleteId });
      else if (text.toLowerCase() === "n" || key.escape) setConfirmDeleteId(undefined);
      return;
    }
    if (key.ctrl && text === "c") {
      if (busy) reportFailure("Interrupt", session.interrupt()); else finish({ type: "exit" });
      return;
    }
    if (key.escape && screen !== "chat") { setScreen("chat"); setInput(""); return; }
    if (screen === "models") {
      if (key.upArrow) setModelCursor((current) => Math.max(0, current - 1));
      else if (key.downArrow) setModelCursor((current) => Math.min(filteredModels.length - 1, current + 1));
      else if (key.backspace || key.delete) { setModelFilter((current) => current.slice(0, -1)); setModelCursor(0); }
      else if (key.return) {
        const selected = filteredModels[modelCursor];
        if (selected !== undefined) {
          const route = encodeModelId(selected.providerId, selected.id);
          reportFailure("Model switch", session.setModel(route), () => { setActiveModel(route); setScreen("chat"); appendSystem(setMessages, `Model switched to [${selected.providerId}] ${selected.displayName}`); });
        }
      } else if (!key.ctrl && !key.meta && text) { setModelFilter((current) => current + text); setModelCursor(0); }
      return;
    }
    if (screen === "providers") {
      const providers = config.providers;
      if (key.upArrow) setProviderCursor((current) => Math.max(0, current - 1));
      else if (key.downArrow) setProviderCursor((current) => Math.min(providers.length - 1, current + 1));
      else if (text === "a") finish({ type: "connect" });
      else if (text === "d" && providers[providerCursor] !== undefined) setConfirmDeleteId(providers[providerCursor]!.id);
      else if (text === "r" && providers[providerCursor] !== undefined) finish({ type: "reconnect-provider", providerId: providers[providerCursor]!.id });
      else if (key.return && providers[providerCursor] !== undefined) finish({ type: "set-default-provider", providerId: providers[providerCursor]!.id });
      return;
    }
    if (screen === "permissions") {
      const index = modes.indexOf(permissionMode);
      if (key.upArrow) setPermissionModeState(modes[Math.max(0, index - 1)] ?? "default");
      else if (key.downArrow) setPermissionModeState(modes[Math.min(modes.length - 1, index + 1)] ?? "default");
      else if (key.return) reportFailure("Permission mode", session.setPermissionMode(permissionMode), () => { setScreen("chat"); appendSystem(setMessages, `Permission mode: ${permissionMode}`); });
      return;
    }
    if (screen === "help") return;
    if (screen === "usage") return;
    if (key.tab && key.shift) {
      const index = modes.indexOf(permissionMode);
      const next = modes[(index + 1) % modes.length] ?? "default";
      setPermissionModeState(next); reportFailure("Permission mode", session.setPermissionMode(next));
      return;
    }
    if (key.backspace || key.delete) { setInput((current) => current.slice(0, -1)); return; }
    if (key.return) {
      const prompt = input.trim();
      if (!prompt) return;
      setInput("");
      if (prompt.startsWith("/")) { void handleCommand(prompt); return; }
      setMessages((current) => [...current, { id: `user-${Date.now()}`, role: "user", text: prompt }]);
      setBusy(true);
      try { session.sendPrompt(prompt); } catch (error: unknown) { setBusy(false); appendSystem(setMessages, error instanceof Error ? error.message : String(error)); }
      return;
    }
    if (!key.ctrl && !key.meta && text) setInput((current) => current + text);
  });

  async function handleCommand(command: string): Promise<void> {
    const name = command.split(/\s+/, 1)[0];
    if (name === "/connect") return finish({ type: "connect" });
    if (name === "/providers") { setScreen("providers"); return; }
    if (name === "/model") { setScreen("models"); return; }
    if (name === "/permissions") { setScreen("permissions"); return; }
    if (name === "/help") { setScreen("help"); return; }
    if (name === "/clear") { setMessages([]); return; }
    if (name === "/exit" || name === "/quit") return finish({ type: "exit" });
    if (name === "/usage") {
      try {
        const [ledger, context] = await Promise.all([loadUsage(), session.contextUsage()]);
        setUsage(ledger);
        setContextUsage(context);
        setScreen("usage");
      } catch (error: unknown) {
        appendSystem(setMessages, `Unable to load usage: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    if (name === "/agents") {
      try {
        const agents = await session.supportedAgents();
        appendSystem(setMessages, agents.length === 0 ? "No subagents configured." : `Subagents: ${agents.map((agent) => agent.name).join(", ")}`);
      } catch (error: unknown) { appendSystem(setMessages, `Unable to list subagents: ${error instanceof Error ? error.message : String(error)}`); }
      return;
    }
    setMessages((current) => [...current, { id: `user-${Date.now()}`, role: "user", text: command }]);
    setBusy(true);
    try { session.sendPrompt(command); } catch (error: unknown) { setBusy(false); appendSystem(setMessages, error instanceof Error ? error.message : String(error)); }
  }

  function reportFailure(label: string, promise: Promise<unknown>, onSuccess?: () => void): void {
    void promise.then(onSuccess).catch((error: unknown) => appendSystem(setMessages, `${label} failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  const transcriptRows = Math.max(6, (stdout.rows ?? 28) - 11);
  return <Box flexDirection="column" paddingX={1}>
    <Header model={activeModel} mode={permissionMode} providers={config.providers.length} compatible={identity.compatibility.compatible} />
    <Box flexDirection="column" minHeight={transcriptRows}>
      {screen === "chat" ? <Transcript items={messages.slice(-transcriptRows)} /> : null}
      {screen === "models" ? <ModelPicker models={filteredModels} cursor={modelCursor} filter={modelFilter} /> : null}
      {screen === "providers" ? confirmDeleteId === undefined
        ? <ProviderManager providers={config.providers} models={models} cursor={providerCursor} {...(config.defaultProviderId === undefined ? {} : { defaultId: config.defaultProviderId })} />
        : <DeleteConfirmation providerId={confirmDeleteId} /> : null}
      {screen === "usage" ? <UsagePanel usage={usage} context={contextUsage} /> : null}
      {screen === "permissions" ? <PermissionPicker selected={permissionMode} /> : null}
      {screen === "help" ? <Help /> : null}
    </Box>
    {pendingPermission === undefined ? <Composer value={input} busy={busy} screen={screen} /> : <PermissionCard request={pendingPermission} cursor={permissionCursor} />}
  </Box>;
}

export function reduceSdkMessage(current: readonly TranscriptItem[], message: SDKMessage): TranscriptItem[] {
  const items = [...current];
  if (message.type === "stream_event") {
    const event = message.event as unknown;
    if (!isRecord(event)) return items;
    const delta = isRecord(event.delta) ? event.delta : undefined;
    if (event.type === "content_block_delta" && typeof delta?.text === "string") return appendAssistantDelta(items, delta.text, message.parent_tool_use_id);
    if (event.type === "content_block_start" && isRecord(event.content_block) && event.content_block.type === "tool_use") {
      const name = typeof event.content_block.name === "string" ? event.content_block.name : "tool";
      return [...items, { id: `tool-${message.uuid}-${items.length}`, role: "tool", text: `${message.parent_tool_use_id ? "subagent · " : ""}${name}` }];
    }
  }
  if (message.type === "system" && message.subtype === "notification") return [...items, { id: message.uuid, role: "system", text: message.text }];
  if (message.type === "system" && message.subtype === "task_started") return [...items, { id: message.uuid, role: "tool", text: `Subagent started: ${message.description}` }];
  if (message.type === "system" && message.subtype === "task_progress" && message.summary) return [...items, { id: message.uuid, role: "tool", text: message.summary }];
  if (message.type === "system" && message.subtype === "task_notification") return [...items, { id: message.uuid, role: "tool", text: `Subagent ${message.status}: ${message.summary}` }];
  if (message.type === "result" && message.is_error) {
    const text = message.subtype === "success" ? message.result : message.errors.join(" · ");
    return [...items, { id: message.uuid, role: "system", text: text || "The engine stopped with an error." }];
  }
  return items;
}

function appendAssistantDelta(items: TranscriptItem[], text: string, parent: string | null): TranscriptItem[] {
  const last = items.at(-1);
  const id = parent === null ? "assistant-main" : `assistant-${parent}`;
  if (last?.role === "assistant" && last.id === id) return [...items.slice(0, -1), { ...last, text: last.text + text }];
  return [...items, { id, role: "assistant", text }];
}

function Header({ model, mode, providers, compatible }: { readonly model: string; readonly mode: PermissionMode; readonly providers: number; readonly compatible: boolean }): React.JSX.Element {
  return <Box justifyContent="space-between" borderStyle="single" borderColor={palette.accent} paddingX={1}>
    <Text bold color={palette.accent}>◆ AlfaCode</Text>
    <Text><Text color={palette.secondary}>{shortModel(model)}</Text><Text color={palette.muted}> · {providers} provider{providers === 1 ? "" : "s"} · {mode}{compatible ? "" : " · engine mismatch"}</Text></Text>
  </Box>;
}

function Transcript({ items }: { readonly items: readonly TranscriptItem[] }): React.JSX.Element {
  return <>{items.map((item, index) => <Box key={`${item.id}-${index}`} marginTop={item.role === "user" ? 1 : 0}>
    <Text {...(item.role === "user" ? { color: palette.secondary } : item.role === "tool" ? { color: palette.muted } : item.role === "system" ? { color: "yellow" } : {})}>
      {item.role === "user" ? "❯ " : item.role === "tool" ? "↳ " : item.role === "system" ? "! " : "  "}{item.text}
    </Text>
  </Box>)}</>;
}

function Composer({ value, busy, screen }: { readonly value: string; readonly busy: boolean; readonly screen: Screen }): React.JSX.Element {
  return <Box flexDirection="column">
    <Box borderStyle="round" borderColor={busy ? palette.secondary : palette.accent} paddingX={1}><Text>{screen === "chat" ? value : ""}</Text><Text color={palette.accent}>▌</Text></Box>
    <Text color={palette.muted}>{busy ? "working · ctrl+c interrupt" : screen === "chat" ? "/help · shift+tab permissions · ctrl+c exit" : "esc back"}</Text>
  </Box>;
}

function ModelPicker({ models, cursor, filter }: { readonly models: readonly ModelDescriptor[]; readonly cursor: number; readonly filter: string }): React.JSX.Element {
  const start = Math.max(0, Math.min(cursor - 5, models.length - 11));
  return <Box flexDirection="column"><Text bold>Models <Text color={palette.muted}>filter: {filter || "type to search"}</Text></Text>
    {models.slice(start, start + 11).map((model) => <Text key={`${model.providerId}/${model.id}`} {...(models[cursor] === model ? { color: palette.secondary } : {})}>{models[cursor] === model ? "❯ " : "  "}[{model.providerId}] {model.displayName}<Text color={palette.muted}> · {model.contextWindow ?? "?"} ctx</Text></Text>)}
    {models.length === 0 ? <Text color={palette.muted}>No verified tool-capable model matches this filter.</Text> : null}
  </Box>;
}

function ProviderManager({ providers, models, cursor, defaultId }: { readonly providers: readonly ProviderRecord[]; readonly models: readonly ModelDescriptor[]; readonly cursor: number; readonly defaultId?: string }): React.JSX.Element {
  return <Box flexDirection="column"><Text bold>Providers <Text color={palette.success}>automatic routing</Text></Text>{providers.map((provider, index) => {
    const available = models.filter((model) => model.providerId === provider.id && model.availability === "available" && model.capabilities.tools).length;
    return <Text key={provider.id} {...(cursor === index ? { color: palette.secondary } : {})}>{cursor === index ? "❯ " : "  "}{provider.id} <Text color={available > 0 ? palette.muted : palette.danger}>{provider.type} · {provider.apiKey === undefined ? "public" : provider.apiKey.kind} · {available > 0 ? `${available} callable model${available === 1 ? "" : "s"}` : "unavailable"}{provider.id === defaultId ? " · preferred" : ""}</Text></Text>;
  })}<Text color={palette.muted}>a add · d delete · r reconnect · enter preferred · esc back</Text></Box>;
}

function DeleteConfirmation({ providerId }: { readonly providerId: string }): React.JSX.Element {
  return <Box flexDirection="column" borderStyle="round" borderColor={palette.danger} paddingX={1}><Text bold color={palette.danger}>Delete provider “{providerId}”?</Text><Text>The configuration and its AlfaCode Keychain credential will be removed.</Text><Text color={palette.muted}>y delete permanently · n cancel</Text></Box>;
}

function UsagePanel({ usage, context }: { readonly usage: UsageSummary | undefined; readonly context: { readonly totalTokens: number; readonly maxTokens: number; readonly percentage: number; readonly model: string } | undefined }): React.JSX.Element {
  if (usage === undefined || context === undefined) return <Text color={palette.muted}>Loading usage…</Text>;
  const trackedTokens = usage.attempts.reduce((total, attempt) => total + attemptTokenCount(attempt), 0);
  const providers = [...new Set(usage.attempts.map((attempt) => attempt.providerId))].map((providerId) => {
    const attempts = usage.attempts.filter((attempt) => attempt.providerId === providerId);
    return { providerId, attempts: attempts.length, completed: attempts.filter((attempt) => attempt.outcome === "completed").length, failed: attempts.filter((attempt) => attempt.outcome === "failed").length, tokens: attempts.reduce((total, attempt) => total + attemptTokenCount(attempt), 0) };
  });
  return <Box flexDirection="column"><Text bold>Usage <Text color={palette.muted}>latest {usage.attempts.length} attempts</Text></Text><Text>Context <Text color={palette.secondary}>{formatNumber(context.totalTokens)} / {formatNumber(context.maxTokens)}</Text> · {context.percentage.toFixed(1)}% · {shortModel(context.model)}</Text><Text>Tracked tokens <Text color={palette.secondary}>{formatNumber(trackedTokens)}</Text> · input {formatNumber(usage.totals.inputTokens)} · output {formatNumber(usage.totals.outputTokens)}</Text><Box marginTop={1} flexDirection="column">{providers.map((provider) => <Text key={provider.providerId}>[{provider.providerId}] {formatNumber(provider.tokens)} tokens <Text color={palette.muted}>· {provider.completed}/{provider.attempts} completed{provider.failed > 0 ? ` · ${provider.failed} failed` : ""}</Text></Text>)}</Box><Box marginTop={1} flexDirection="column"><Text color={palette.muted}>Recent attempts</Text>{usage.attempts.slice(0, 6).map((attempt) => <Text key={attempt.id}>{attempt.outcome === "completed" ? "✓" : attempt.outcome === "failed" ? "×" : "·"} [{attempt.providerId}] {shortModel(attempt.upstreamModel)} <Text color={palette.muted}>{attemptHasUsage(attempt) ? `${formatNumber(attemptTokenCount(attempt))} tokens` : "usage unavailable"}{attempt.errorClass === undefined ? "" : ` · ${attempt.errorClass}`}</Text></Text>)}</Box><Text color={palette.muted}>esc back · accounting is local and content-free</Text></Box>;
}

function PermissionPicker({ selected }: { readonly selected: PermissionMode }): React.JSX.Element {
  return <Box flexDirection="column"><Text bold>Permission mode</Text>{modes.map((mode) => <Text key={mode} {...(selected === mode ? { color: palette.secondary } : {})}>{selected === mode ? "❯ " : "  "}{mode}</Text>)}</Box>;
}

function PermissionCard({ request, cursor }: { readonly request: PermissionRequest; readonly cursor: number }): React.JSX.Element {
  const options = request.suggestions.length > 0 ? ["Deny", "Allow once", "Always allow"] : ["Deny", "Allow once"];
  return <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}><Text bold>{request.title ?? `${request.toolName} requests permission`}</Text>{request.description ? <Text>{request.description}</Text> : null}<Text color={palette.muted}>{permissionInputSummary(request)}</Text>{request.reason ? <Text color={palette.muted}>{request.reason}</Text> : null}<Text>{options.map((option, index) => `${index === cursor ? "[" : " "}${option}${index === cursor ? "]" : " "}`).join("  ")}</Text></Box>;
}

function Help(): React.JSX.Element {
  return <Box flexDirection="column"><Text bold>Commands</Text><Text>/connect       add a provider</Text><Text>/providers     manage every configured provider</Text><Text>/model         switch across the aggregated live catalog</Text><Text>/usage         inspect context usage</Text><Text>/agents        list Claude Code subagents</Text><Text>/permissions   change tool permission mode</Text><Text>/clear         clear the visible transcript</Text><Text>/exit          close AlfaCode</Text></Box>;
}

function appendSystem(setter: React.Dispatch<React.SetStateAction<TranscriptItem[]>>, text: string): void {
  setter((current) => [...current, { id: `system-${Date.now()}`, role: "system", text }]);
}
function shortModel(model: string): string { return model.split("/").at(-1) ?? model; }
function formatNumber(value: number): string { return new Intl.NumberFormat("en-US").format(value); }
function attemptHasUsage(attempt: UsageSummary["attempts"][number]): boolean { return attempt.totalTokens !== undefined || attempt.inputTokens !== undefined || attempt.outputTokens !== undefined; }
function attemptTokenCount(attempt: UsageSummary["attempts"][number]): number { return attempt.totalTokens ?? (attempt.inputTokens ?? 0) + (attempt.outputTokens ?? 0); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function routedModelFromMessage(message: SDKMessage): string | undefined {
  if (message.type !== "stream_event" || !isRecord(message.event) || message.event.type !== "message_start" || !isRecord(message.event.message)) return undefined;
  return typeof message.event.message.model === "string" ? message.event.message.model : undefined;
}
function permissionInputSummary(request: PermissionRequest): string {
  const serialized = JSON.stringify(request.input);
  return sanitizeForTerminal(serialized.length > 500 ? `${serialized.slice(0, 497)}…` : serialized);
}
function sanitizeForTerminal(value: string): string { return value.replace(/[\u0000-\u001F\u007F-\u009F]/g, " "); }
