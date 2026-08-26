import { stat as statFile, readFile as readFileBytes } from "node:fs/promises";
import { relative as relativePath } from "node:path";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import type { Key } from "ink";
import type { McpServerStatus, PermissionMode, SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AlfaCodeConfig, ProviderRecord } from "./config.js";
import type { ModelDescriptor } from "./providers/foundation/types.js";
import { decodeModelId, encodeModelId } from "./model-id.js";
import type { AgentSession, AgentSessionIdentity, PromptImageAttachment } from "./agent-session.js";
import { notifyTurnComplete, resolveNotificationSettings } from "./notifications.js";
import type { PermissionBroker, PermissionRequest, UserQuestionRequest } from "./permission-broker.js";
import { formatRelativeTime } from "./session-history.js";
import { exportTranscript } from "./transcript-export.js";
import type { UsageSummary } from "./usage-ledger.js";
import { mediaTypeForExtension, readClipboardImage } from "./ui/clipboard-image.js";
import { detectDroppedPaths, resolveDroppedPaths, type DroppedPathCandidate } from "./ui/dropped-paths.js";
import { editInput, splitAtCursor, type EditorState } from "./ui/input-editor.js";
import { Markdown, sanitizeTerminalText } from "./ui/markdown.js";
import { activeMentionQuery, filterMentionEntries, insertMention, listMentionEntries, type MentionEntry } from "./ui/mentions.js";
import { usePulse, useSpinner } from "./ui/motion.js";
import { Brand, EmptyState, HintBar, KeyHint, ProgressBar, SectionTitle, StatusBadge } from "./ui/primitives.js";
import { getTheme, resolveThemeName, themeCatalog, type Theme, type ThemeName } from "./ui/theme.js";
import { createVimState, resetVimStateForNewBuffer, stepVim, type VimState } from "./ui/vim-mode.js";

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

export interface TranscriptItem {
  readonly id: string;
  readonly role: "user" | "assistant" | "tool" | "system";
  readonly text: string;
  readonly status?: "running" | "completed" | "failed";
  readonly detail?: string;
  readonly streamId?: string | null;
}

type Screen = "chat" | "models" | "providers" | "usage" | "permissions" | "help" | "rewind" | "theme" | "mcp";
type ContextUsage = {
  readonly totalTokens: number;
  readonly maxTokens: number;
  readonly percentage: number;
  readonly model: string;
  readonly categories?: readonly { readonly name: string; readonly tokens: number; readonly isDeferred?: boolean }[];
  /** Usage percentage at which the engine auto-compacts, when it reports one. */
  readonly autoCompactThreshold?: number;
  readonly isAutoCompactEnabled?: boolean;
};
interface Command { readonly name: string; readonly description: string; readonly shortcut?: string }
interface Checkpoint { readonly uuid: string; readonly text: string; readonly transcriptItemId: string; readonly at: number }
/** A pasted/dropped image pending on the next submitted prompt, referenced in the composer text as `[Image #id]`. */
interface ImageAttachment { readonly id: number; readonly mediaType: PromptImageAttachment["mediaType"]; readonly base64: string }

const modes: readonly PermissionMode[] = ["default", "acceptEdits", "plan", "dontAsk", "auto"];
const compactNumberFormatter = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
let transcriptItemSequence = 0;
const commands: readonly Command[] = [
  { name: "/model", description: "Switch across every live model", shortcut: "⌘M" },
  { name: "/providers", description: "Manage connected providers" },
  { name: "/connect", description: "Connect another provider" },
  { name: "/usage", description: "Inspect context and token usage" },
  { name: "/context", description: "Inspect context window usage" },
  { name: "/compact", description: "Summarize the conversation to free up context", shortcut: "[instructions]" },
  { name: "/agents", description: "List available subagents" },
  { name: "/mcp", description: "Inspect configured MCP servers" },
  { name: "/permissions", description: "Change tool permission mode" },
  { name: "/vim", description: "Toggle vim-style modal editing in the composer" },
  { name: "/theme", description: "Switch the color theme" },
  { name: "/export", description: "Export this transcript to a file" },
  { name: "/clear", description: "Clear this transcript" },
  { name: "/help", description: "Show commands and shortcuts" },
  { name: "/exit", description: "Close AlfaCode" },
];
/** Usage percentage at which we nudge toward /compact, when the engine doesn't report its own. */
const defaultContextWarningThreshold = 80;

/** `src/config.ts` (persisted settings) is out of scope for this composer work, so the "config setting" toggle for vim mode is an environment variable, matching the existing `ALFACODE_THEME`/`ALFACODE_REDUCED_MOTION` convention in `src/ui/theme.ts`. `/vim` toggles it for the rest of the session either way. */
export function resolveInitialVimMode(environment: NodeJS.ProcessEnv = process.env): boolean {
  const requested = environment.ALFACODE_VIM_MODE?.trim().toLowerCase();
  return requested === "1" || requested === "true" || requested === "yes" || requested === "on";
}

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
  const [themeName, setThemeName] = useState<ThemeName>(() => resolveThemeName());
  const theme = useMemo(() => getTheme(themeName), [themeName]);
  const notificationSettings = useMemo(() => resolveNotificationSettings(), []);
  const [screen, setScreen] = useState<Screen>("chat");
  const [editor, setEditor] = useState<EditorState>({ value: "", cursor: 0 });
  const [messages, setMessages] = useState<TranscriptItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [modelCursor, setModelCursor] = useState(0);
  const [modelFilter, setModelFilter] = useState("");
  const [providerCursor, setProviderCursor] = useState(0);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string>();
  const [usage, setUsage] = useState<UsageSummary>();
  const [lastTurnTokens, setLastTurnTokens] = useState<number>();
  const [lastTurnCostUsd, setLastTurnCostUsd] = useState<number>();
  const [sessionCostUsd, setSessionCostUsd] = useState<number>();
  const [contextUsage, setContextUsage] = useState<ContextUsage>();
  const [mcpServers, setMcpServers] = useState<readonly McpServerStatus[]>([]);
  const [permissionCursor, setPermissionCursor] = useState(1);
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest>();
  const [pendingQuestion, setPendingQuestion] = useState<UserQuestionRequest>();
  const [questionIndex, setQuestionIndex] = useState(0);
  const [questionCursor, setQuestionCursor] = useState(0);
  const [questionSelections, setQuestionSelections] = useState<Readonly<Record<number, readonly string[]>>>({});
  const [questionOtherMode, setQuestionOtherMode] = useState(false);
  const [questionOtherEditor, setQuestionOtherEditor] = useState<EditorState>({ value: "", cursor: 0 });
  const [permissionMode, setPermissionModeState] = useState<PermissionMode>(identity.compatibility.compatible ? "default" : "dontAsk");
  const [activeModel, setActiveModel] = useState(identity.model);
  const [commandCursor, setCommandCursor] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [historyCursor, setHistoryCursor] = useState(-1);
  const [promptSuggestion, setPromptSuggestion] = useState<string>();
  const [engineCommands, setEngineCommands] = useState<readonly Command[]>([]);
  const [checkpoints, setCheckpoints] = useState<readonly Checkpoint[]>([]);
  const [rewindCursor, setRewindCursor] = useState(0);
  const [rewindBusy, setRewindBusy] = useState(false);
  const [historySearch, setHistorySearch] = useState<{ readonly query: string; readonly index: number }>();
  const [vimEnabled, setVimEnabled] = useState(resolveInitialVimMode);
  const [vim, setVim] = useState<VimState>(createVimState);
  const [mentionEntries, setMentionEntries] = useState<readonly MentionEntry[]>([]);
  const [mentionCursor, setMentionCursor] = useState(0);
  const [attachments, setAttachments] = useState<readonly ImageAttachment[]>([]);
  const pendingTurns = useRef(0);
  const contextWarnedRef = useRef(false);
  const previousSessionCostRef = useRef(0);
  const lastEscapeAtRef = useRef(0);
  const imageSequence = useRef(0);

  const callableModels = useMemo(() => models.filter((model) => model.availability === "available" && model.capabilities.tools), [models]);
  const filteredModels = useMemo(() => {
    const query = modelFilter.toLowerCase();
    return callableModels.filter((model) => `${model.displayName} ${model.providerId} ${model.id}`.toLowerCase().includes(query));
  }, [callableModels, modelFilter]);
  const availableCommands = useMemo(() => mergeCommands(commands, engineCommands), [engineCommands]);
  const commandMatches = useMemo(() => commandSuggestions(editor.value, availableCommands), [availableCommands, editor.value]);
  const historyMatches = useMemo(() => historySearch === undefined ? [] : historySearchMatches(history, historySearch.query), [history, historySearch]);
  const visibleCheckpoints = useMemo(() => checkpoints.slice(-20), [checkpoints]);
  const mentionQuery = useMemo(() => commandMatches.length > 0 ? undefined : activeMentionQuery(editor.value, editor.cursor), [commandMatches, editor.cursor, editor.value]);
  const mentionMatches = useMemo(() => mentionQuery === undefined ? [] : filterMentionEntries(mentionEntries, mentionQuery.query), [mentionEntries, mentionQuery]);
  const width = Math.max(48, stdout.columns ?? 100);
  const blockingPanelRows = pendingQuestion === undefined ? pendingPermission === undefined ? 0 : 8 : 16;
  const transcriptRows = Math.max(blockingPanelRows > 0 ? 3 : 8, (stdout.rows ?? 30) - (commandMatches.length > 0 || mentionMatches.length > 0 ? 17 : 11) - blockingPanelRows);
  const visibleMessages = useMemo(() => tailItemsByRows(messages, transcriptRows, width - 6), [messages, transcriptRows, width]);
  const finish = (action: ChatAction): void => { resolveAction(action); exit(); };

  useEffect(() => session.subscribe((message) => {
    setMessages((current) => reduceSdkMessage(current, message));
    const routedModel = routedModelFromMessage(message);
    if (routedModel !== undefined) setActiveModel(routedModel);
    if (message.type === "prompt_suggestion") setPromptSuggestion(sanitizeTerminalText(message.suggestion));
    if (message.type === "system" && message.subtype === "commands_changed") setEngineCommands(toCommands(message.commands));
    if (message.type === "result") {
      pendingTurns.current = Math.max(0, pendingTurns.current - 1);
      setBusy(pendingTurns.current > 0);
      const cost = turnCostFromResult(message, previousSessionCostRef.current);
      if (cost !== undefined) {
        previousSessionCostRef.current = cost.cumulativeCostUsd;
        setLastTurnCostUsd(cost.turnCostUsd);
        setSessionCostUsd(cost.cumulativeCostUsd);
      }
      void refreshTelemetry(session, loadUsage, setContextUsage, setUsage, setLastTurnTokens, (context) => {
        const warning = contextFullWarning(context, contextWarnedRef.current);
        if (warning !== undefined) { contextWarnedRef.current = true; appendSystem(setMessages, warning); }
        else if (context.percentage < contextFullThreshold(context)) contextWarnedRef.current = false;
      });
    }
  }), [loadUsage, session]);

  useEffect(() => {
    let active = true;
    void session.identity().then((resolved) => {
      if (!active) return;
      setActiveModel(resolved.model);
      if (!resolved.compatibility.compatible) appendSystem(setMessages, resolved.compatibility.reason ?? "Unsupported Claude Code engine version.");
      void refreshTelemetry(session, loadUsage, setContextUsage, setUsage);
      void session.supportedCommands().then((supported) => setEngineCommands(toCommands(supported))).catch(() => undefined);
    }).catch((error: unknown) => {
      if (active) {
        setBusy(false);
        appendSystem(setMessages, error instanceof Error ? error.message : String(error));
      }
    });
    return () => { active = false; };
  }, [loadUsage, session]);

  useEffect(() => permissions.subscribe((request) => {
    setPendingPermission(request);
    if (request !== undefined) setPermissionCursor(1);
  }), [permissions]);

  useEffect(() => permissions.subscribeQuestions((request) => {
    setPendingQuestion(request);
    if (request !== undefined) {
      setQuestionIndex(0);
      setQuestionCursor(0);
      setQuestionSelections({});
      setQuestionOtherMode(false);
      setQuestionOtherEditor({ value: "", cursor: 0 });
    }
  }), [permissions]);

  useEffect(() => {
    let active = true;
    void listMentionEntries(process.cwd()).then((entries) => { if (active) setMentionEntries(entries); }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  // Turn-completion / permission-wait notifications. Independent of the
  // subscriptions above: it only observes state they already set, so it
  // never changes when a response finishes or a permission prompt starts.
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy) notifyTurnComplete({ settings: notificationSettings, title: "AlfaCode", body: "Turn finished — back to you." });
    wasBusy.current = busy;
  }, [busy, notificationSettings]);
  const hadPendingPermission = useRef(pendingPermission !== undefined);
  useEffect(() => {
    const pending = pendingPermission !== undefined;
    if (!hadPendingPermission.current && pending) notifyTurnComplete({ settings: notificationSettings, title: "AlfaCode", body: "Waiting on a permission decision." });
    hadPendingPermission.current = pending;
  }, [pendingPermission, notificationSettings]);

  useInput((text, key) => {
    if (pendingQuestion !== undefined) { handleQuestionInput(text, key, pendingQuestion); return; }
    if (pendingPermission !== undefined) {
      if (key.leftArrow) setPermissionCursor((current) => Math.max(0, current - 1));
      else if (key.rightArrow) setPermissionCursor((current) => Math.min(pendingPermission.suggestions.length > 0 ? 2 : 1, current + 1));
      else if (key.return) {
        if (permissionCursor === 0) permissions.deny();
        else permissions.allow(permissionCursor === 2);
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
    if (key.escape && screen !== "chat") { setScreen("chat"); clearEditor(); return; }
    if (screen === "models") { handleModelInput(text, key); return; }
    if (screen === "providers") { handleProviderInput(text, key); return; }
    if (screen === "permissions") { handlePermissionModeInput(key); return; }
    if (screen === "rewind") { handleRewindInput(key); return; }
    if (screen === "theme") { handleThemeInput(key); return; }
    if (screen === "help" || screen === "usage" || screen === "mcp") return;

    // Image paste (Ctrl+V always reaches the terminal; Cmd+V only surfaces as key.super under the
    // kitty keyboard protocol — see clipboard-image.ts for why this can't just read stdin) and
    // drag-and-drop (delivered by most terminals as a plain pasted path) are handled ahead of
    // everything else so they work the same regardless of vim mode or an open palette.
    if ((key.ctrl || key.super) && text.toLowerCase() === "v") { handleImagePasteShortcut(); return; }
    if (!key.ctrl && !key.meta && text.length > 1) {
      const dropped = detectDroppedPaths(text);
      if (dropped !== undefined) { void handleDroppedPaste(text, dropped); return; }
    }

    if (historySearch !== undefined) { handleHistorySearchInput(text, key); return; }
    if (key.ctrl && text === "r") { setHistorySearch({ query: "", index: 0 }); return; }
    if (key.escape && editor.value.length === 0 && !busy && checkpoints.length > 0) {
      const now = Date.now();
      if (now - lastEscapeAtRef.current < 900) {
        lastEscapeAtRef.current = 0;
        setRewindCursor(Math.max(0, visibleCheckpoints.length - 1));
        setScreen("rewind");
      } else {
        lastEscapeAtRef.current = now;
      }
      return;
    }
    if (key.tab && key.shift) {
      const index = modes.indexOf(permissionMode);
      const next = modes[(index + 1) % modes.length] ?? "default";
      setPermissionModeState(next);
      reportFailure("Permission mode", session.setPermissionMode(next));
      return;
    }
    if (commandMatches.length > 0 && key.upArrow) { setCommandCursor((current) => Math.max(0, current - 1)); return; }
    if (commandMatches.length > 0 && key.downArrow) { setCommandCursor((current) => Math.min(commandMatches.length - 1, current + 1)); return; }
    if (commandMatches.length > 0 && key.tab) {
      const completion = commandMatches[commandCursor]?.name;
      if (completion !== undefined) setEditor({ value: completion, cursor: completion.length });
      return;
    }
    if (mentionQuery !== undefined && mentionMatches.length > 0 && key.upArrow) { setMentionCursor((current) => Math.max(0, current - 1)); return; }
    if (mentionQuery !== undefined && mentionMatches.length > 0 && key.downArrow) { setMentionCursor((current) => Math.min(mentionMatches.length - 1, current + 1)); return; }
    if (mentionQuery !== undefined && mentionMatches.length > 0 && key.tab) {
      const entry = mentionMatches[mentionCursor];
      if (entry !== undefined) setEditor(insertMention(editor.value, mentionQuery, entry));
      setMentionCursor(0);
      return;
    }
    if (key.tab && editor.value.length === 0 && promptSuggestion !== undefined) {
      setEditor({ value: promptSuggestion, cursor: promptSuggestion.length });
      setPromptSuggestion(undefined);
      return;
    }
    if (vimEnabled) {
      const step = stepVim(editor, vim, text, key);
      if (step.handled) {
        setEditor(step.editor);
        setVim(step.vim);
        setCommandCursor(0);
        setMentionCursor(0);
        return;
      }
    }
    if (key.upArrow) { navigateHistory(1); return; }
    if (key.downArrow) { navigateHistory(-1); return; }
    if (key.leftArrow) { applyEdit({ type: "left" }); return; }
    if (key.rightArrow) { applyEdit({ type: "right" }); return; }
    if (key.home || (key.ctrl && text === "a")) { applyEdit({ type: "home" }); return; }
    if (key.end || (key.ctrl && text === "e")) { applyEdit({ type: "end" }); return; }
    if (key.ctrl && text === "u") { applyEdit({ type: "delete-to-start" }); return; }
    if (key.ctrl && text === "k") { applyEdit({ type: "delete-to-end" }); return; }
    if (key.ctrl && text === "w") { applyEdit({ type: "delete-word" }); return; }
    if (key.backspace) { applyEdit({ type: "backspace" }); setCommandCursor(0); setMentionCursor(0); return; }
    if (key.delete) { applyEdit({ type: "delete" }); setCommandCursor(0); setMentionCursor(0); return; }
    if (key.escape && editor.value.length > 0) { clearEditor(); return; }
    if (key.return && key.shift) { applyEdit({ type: "insert", text: "\n" }); return; }
    if (key.return) { submitEditor(); return; }
    if (!key.ctrl && !key.meta && text) {
      setPromptSuggestion(undefined);
      applyEdit({ type: "insert", text: sanitizeTerminalText(text) });
      setCommandCursor(0);
      setMentionCursor(0);
      setHistoryCursor(-1);
    }
  });

  function applyEdit(operation: Parameters<typeof editInput>[1]): void { setEditor((current) => editInput(current, operation)); }
  function clearEditor(): void { setEditor({ value: "", cursor: 0 }); setCommandCursor(0); setMentionCursor(0); setHistoryCursor(-1); setVim(resetVimStateForNewBuffer); }
  function navigateHistory(direction: 1 | -1): void {
    if (history.length === 0) return;
    const next = Math.max(-1, Math.min(history.length - 1, historyCursor + direction));
    setHistoryCursor(next);
    const value = next === -1 ? "" : (history[next] ?? "");
    setEditor({ value, cursor: value.length });
  }
  function submitEditor(): void {
    const prompt = editor.value.trim();
    if (!prompt) return;
    clearEditor();
    setHistory((current) => [prompt, ...current.filter((item) => item !== prompt)].slice(0, 100));
    if (prompt.startsWith("/")) { void handleCommand(prompt); return; }
    sendPrompt(prompt);
  }
  function sendPrompt(prompt: string): void {
    setPromptSuggestion(undefined);
    const relevantAttachments = attachments.filter((attachment) => prompt.includes(`[Image #${attachment.id}]`));
    setAttachments([]);
    const itemId = createTranscriptItemId("user");
    setMessages((current) => [...current, { id: itemId, role: "user", text: prompt }]);
    pendingTurns.current += 1;
    setBusy(true);
    try {
      const uuid = session.sendPrompt(prompt, relevantAttachments.map((attachment) => ({ mediaType: attachment.mediaType, base64: attachment.base64 })));
      setCheckpoints((current) => [...current, { uuid, text: prompt, transcriptItemId: itemId, at: Date.now() }]);
    } catch (error: unknown) {
      pendingTurns.current = Math.max(0, pendingTurns.current - 1);
      setBusy(pendingTurns.current > 0);
      appendSystem(setMessages, error instanceof Error ? error.message : String(error));
    }
  }
  /** Reserves the `[Image #N]` index synchronously so two rapid pastes can't collide, then resolves the OS clipboard read (see clipboard-image.ts) before inserting the placeholder and queuing the attachment. */
  function handleImagePasteShortcut(): void {
    imageSequence.current += 1;
    const id = imageSequence.current;
    void readClipboardImage().then((image) => {
      if (image === undefined) { appendSystem(setMessages, "Clipboard doesn't contain an image."); return; }
      setAttachments((current) => [...current, { id, mediaType: image.mediaType, base64: image.base64 }]);
      applyEdit({ type: "insert", text: `[Image #${id}] ` });
    });
  }
  /** Verifies the paste's candidate paths actually exist (see dropped-paths.ts) before treating them as a drop; falls back to inserting the raw pasted text otherwise. Dropped images are read and attached exactly like a clipboard paste; other paths become @-mentions. */
  async function handleDroppedPaste(rawText: string, candidates: readonly DroppedPathCandidate[]): Promise<void> {
    const resolved = await resolveDroppedPaths(candidates, async (path) => statFile(path));
    if (resolved.length === 0) { applyEdit({ type: "insert", text: sanitizeTerminalText(rawText) }); return; }
    const parts: string[] = [];
    for (const entry of resolved) {
      const mediaType = entry.isDirectory ? undefined : mediaTypeForExtension(entry.absolutePath);
      if (mediaType !== undefined) {
        try {
          const bytes = await readFileBytes(entry.absolutePath);
          imageSequence.current += 1;
          const id = imageSequence.current;
          setAttachments((current) => [...current, { id, mediaType, base64: bytes.toString("base64") }]);
          parts.push(`[Image #${id}]`);
          continue;
        } catch { /* unreadable — fall back to a plain @mention below */ }
      }
      parts.push(`@${toMentionPath(entry.absolutePath)}${entry.isDirectory ? "/" : ""}`);
    }
    applyEdit({ type: "insert", text: `${parts.join(" ")} ` });
  }
  function handleModelInput(text: string, key: Key): void {
    if (key.upArrow) setModelCursor((current) => Math.max(0, current - 1));
    else if (key.downArrow) setModelCursor((current) => Math.min(Math.max(0, filteredModels.length - 1), current + 1));
    else if (key.backspace || key.delete) { setModelFilter((current) => current.slice(0, -1)); setModelCursor(0); }
    else if (key.return) {
      const selected = filteredModels[modelCursor];
      if (selected !== undefined) {
        const route = encodeModelId(selected.providerId, selected.id);
        reportFailure("Model switch", session.setModel(route), () => { setActiveModel(route); setScreen("chat"); appendSystem(setMessages, `Model switched to [${selected.providerId}] ${selected.displayName}`); });
      }
    } else if (!key.ctrl && !key.meta && text) { setModelFilter((current) => current + sanitizeTerminalText(text)); setModelCursor(0); }
  }
  function handleProviderInput(text: string, key: Key): void {
    const providers = config.providers;
    if (key.upArrow) setProviderCursor((current) => Math.max(0, current - 1));
    else if (key.downArrow) setProviderCursor((current) => Math.min(Math.max(0, providers.length - 1), current + 1));
    else if (text === "a") finish({ type: "connect" });
    else if (text === "d" && providers[providerCursor] !== undefined) setConfirmDeleteId(providers[providerCursor]!.id);
    else if (text === "r" && providers[providerCursor] !== undefined) finish({ type: "reconnect-provider", providerId: providers[providerCursor]!.id });
    else if (key.return && providers[providerCursor] !== undefined) finish({ type: "set-default-provider", providerId: providers[providerCursor]!.id });
  }
  function handlePermissionModeInput(key: Key): void {
    const index = modes.indexOf(permissionMode);
    if (key.upArrow) setPermissionModeState(modes[Math.max(0, index - 1)] ?? "default");
    else if (key.downArrow) setPermissionModeState(modes[Math.min(modes.length - 1, index + 1)] ?? "default");
    else if (key.return) reportFailure("Permission mode", session.setPermissionMode(permissionMode), () => { setScreen("chat"); appendSystem(setMessages, `Permission mode: ${permissionMode}`); });
  }
  function handleHistorySearchInput(text: string, key: Key): void {
    if (key.escape) { setHistorySearch(undefined); return; }
    if (key.return) {
      const match = historyMatches[historySearch!.index % Math.max(1, historyMatches.length)];
      setHistorySearch(undefined);
      if (match !== undefined) { setEditor({ value: match, cursor: match.length }); setHistoryCursor(-1); }
      return;
    }
    if (key.ctrl && text === "r") { setHistorySearch((current) => current === undefined ? current : { ...current, index: historyMatches.length === 0 ? 0 : (current.index + 1) % historyMatches.length }); return; }
    if (key.backspace || key.delete) { setHistorySearch((current) => current === undefined ? current : { query: current.query.slice(0, -1), index: 0 }); return; }
    if (!key.ctrl && !key.meta && text) { setHistorySearch((current) => current === undefined ? current : { query: current.query + sanitizeTerminalText(text).replace(/\r?\n/gu, " "), index: 0 }); }
  }
  function handleRewindInput(key: Key): void {
    if (rewindBusy) return;
    if (key.upArrow) { setRewindCursor((current) => Math.max(0, current - 1)); return; }
    if (key.downArrow) { setRewindCursor((current) => Math.min(Math.max(0, visibleCheckpoints.length - 1), current + 1)); return; }
    if (key.return) void performRewind(visibleCheckpoints[rewindCursor]);
  }
  async function performRewind(checkpoint: Checkpoint | undefined): Promise<void> {
    if (checkpoint === undefined) return;
    setRewindBusy(true);
    try {
      try {
        await session.rewindFiles(checkpoint.uuid);
      } catch (error: unknown) {
        appendSystem(setMessages, `File rewind unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
      setMessages((current) => truncateTranscriptAt(current, checkpoint.transcriptItemId));
      setCheckpoints((current) => truncateCheckpointsAt(current, checkpoint.uuid));
      setEditor({ value: checkpoint.text, cursor: checkpoint.text.length });
      setScreen("chat");
    } finally {
      setRewindBusy(false);
    }
  }
  function handleThemeInput(key: Key): void {
    const index = themeCatalog.findIndex((entry) => entry.name === themeName);
    // Up/down apply the theme immediately (live preview across the whole
    // TUI, including this picker); enter just confirms and returns to chat.
    if (key.upArrow) setThemeName(themeCatalog[Math.max(0, index - 1)]?.name ?? themeName);
    else if (key.downArrow) setThemeName(themeCatalog[Math.min(themeCatalog.length - 1, index + 1)]?.name ?? themeName);
    else if (key.return) { setScreen("chat"); appendSystem(setMessages, `Theme: ${themeCatalog.find((entry) => entry.name === themeName)?.label ?? themeName}`); }
  }
  function handleQuestionInput(text: string, key: Key, request: UserQuestionRequest): void {
    const question = request.questions[questionIndex];
    if (question === undefined) return;
    if (questionOtherMode) {
      if (key.escape) { setQuestionOtherMode(false); setQuestionOtherEditor({ value: "", cursor: 0 }); return; }
      if (key.return) {
        const answer = questionOtherEditor.value.trim();
        if (answer.length === 0) return;
        const current = question.multiSelect ? (questionSelections[questionIndex] ?? []) : [];
        completeQuestion(request, [...current, answer]);
        return;
      }
      applyQuestionEditorKey(text, key);
      return;
    }
    const otherIndex = question.options.length;
    if (key.escape) { permissions.cancelQuestions(); return; }
    if (key.upArrow) { setQuestionCursor((current) => Math.max(0, current - 1)); return; }
    if (key.downArrow) { setQuestionCursor((current) => Math.min(otherIndex, current + 1)); return; }
    if (key.tab) { setQuestionCursor((current) => (current + 1) % (otherIndex + 1)); return; }
    if (text === " " && questionCursor < question.options.length) {
      const label = question.options[questionCursor]?.label;
      if (label === undefined) return;
      if (!question.multiSelect) setQuestionSelections((current) => ({ ...current, [questionIndex]: [label] }));
      else setQuestionSelections((current) => {
        const selected = current[questionIndex] ?? [];
        return { ...current, [questionIndex]: selected.includes(label) ? selected.filter((item) => item !== label) : [...selected, label] };
      });
      return;
    }
    if (!key.return) return;
    if (questionCursor === otherIndex) { setQuestionOtherMode(true); setQuestionOtherEditor({ value: "", cursor: 0 }); return; }
    const focused = question.options[questionCursor]?.label;
    if (focused === undefined) return;
    if (question.multiSelect) {
      const selected = questionSelections[questionIndex] ?? [];
      if (selected.length === 0) completeQuestion(request, [focused]);
      else completeQuestion(request, selected);
    } else completeQuestion(request, [focused]);
  }
  function applyQuestionEditorKey(text: string, key: Key): void {
    let operation: Parameters<typeof editInput>[1] | undefined;
    if (key.leftArrow) operation = { type: "left" };
    else if (key.rightArrow) operation = { type: "right" };
    else if (key.home || (key.ctrl && text === "a")) operation = { type: "home" };
    else if (key.end || (key.ctrl && text === "e")) operation = { type: "end" };
    else if (key.ctrl && text === "u") operation = { type: "delete-to-start" };
    else if (key.ctrl && text === "k") operation = { type: "delete-to-end" };
    else if (key.ctrl && text === "w") operation = { type: "delete-word" };
    else if (key.backspace) operation = { type: "backspace" };
    else if (key.delete) operation = { type: "delete" };
    else if (!key.ctrl && !key.meta && text.length > 0) operation = { type: "insert", text: sanitizeTerminalText(text).replace(/\r?\n/gu, " ") };
    if (operation !== undefined) setQuestionOtherEditor((current) => editInput(current, operation));
  }
  function completeQuestion(request: UserQuestionRequest, values: readonly string[]): void {
    const nextSelections = { ...questionSelections, [questionIndex]: values };
    setQuestionSelections(nextSelections);
    if (questionIndex < request.questions.length - 1) {
      setQuestionIndex((current) => current + 1);
      setQuestionCursor(0);
      setQuestionOtherMode(false);
      setQuestionOtherEditor({ value: "", cursor: 0 });
      return;
    }
    const answers = Object.fromEntries(request.questions.map((question, index) => [question.question, (nextSelections[index] ?? []).join(", ")]));
    permissions.answerQuestions(answers);
  }
  async function handleCommand(command: string): Promise<void> {
    const name = command.split(/\s+/, 1)[0];
    if (name === "/connect") return finish({ type: "connect" });
    if (name === "/providers") { setScreen("providers"); return; }
    if (name === "/model") { setScreen("models"); return; }
    if (name === "/permissions") { setScreen("permissions"); return; }
    if (name === "/vim") {
      const next = !vimEnabled;
      setVimEnabled(next);
      setVim(createVimState());
      appendSystem(setMessages, `Vim mode ${next ? "enabled (starting in NORMAL — press i to insert)" : "disabled"}.`);
      return;
    }
    if (name === "/help") { setScreen("help"); return; }
    if (name === "/clear") { setMessages([]); return; }
    if (name === "/exit" || name === "/quit") return finish({ type: "exit" });
    if (name === "/usage" || name === "/context") { await refreshTelemetry(session, loadUsage, setContextUsage, setUsage); setScreen("usage"); return; }
    if (name === "/agents") {
      try {
        const agents = await session.supportedAgents();
        appendSystem(setMessages, agents.length === 0 ? "No subagents configured." : `Subagents: ${agents.map((agent) => agent.name).join(", ")}`);
      } catch (error: unknown) { appendSystem(setMessages, `Unable to list subagents: ${error instanceof Error ? error.message : String(error)}`); }
      return;
    }
    if (name === "/mcp") {
      try {
        setMcpServers(await session.mcpServerStatus());
        setScreen("mcp");
      } catch (error: unknown) { appendSystem(setMessages, `Unable to inspect MCP servers: ${error instanceof Error ? error.message : String(error)}`); }
      return;
    }
    if (name === "/theme") { setScreen("theme"); return; }
    if (name === "/export") {
      try {
        const path = await exportTranscript(messages, { model: activeModel });
        appendSystem(setMessages, `Transcript exported to ${path}`);
      } catch (error: unknown) { appendSystem(setMessages, `Export failed: ${error instanceof Error ? error.message : String(error)}`); }
      return;
    }
    sendPrompt(command);
  }
  function reportFailure(label: string, promise: Promise<unknown>, onSuccess?: () => void): void {
    void promise.then(onSuccess).catch((error: unknown) => appendSystem(setMessages, `${label} failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  return <Box flexDirection="column" paddingX={1} width={width}>
    <Header model={activeModel} mode={permissionMode} providers={config.providers.length} compatible={identity.compatibility.compatible} busy={busy} theme={theme} width={width} />
    <Box flexDirection="column" minHeight={transcriptRows} paddingX={1}>
      {screen === "chat" ? <Transcript items={visibleMessages} theme={theme} width={width - 6} busy={busy} /> : null}
      {screen === "models" ? <ModelPicker models={filteredModels} cursor={modelCursor} filter={modelFilter} theme={theme} height={transcriptRows} /> : null}
      {screen === "providers" ? confirmDeleteId === undefined ? <ProviderManager providers={config.providers} models={models} cursor={providerCursor} theme={theme} {...(config.defaultProviderId === undefined ? {} : { defaultId: config.defaultProviderId })} /> : <DeleteConfirmation providerId={confirmDeleteId} theme={theme} /> : null}
      {screen === "usage" ? <UsagePanel usage={usage} context={contextUsage} sessionCostUsd={sessionCostUsd} theme={theme} width={width - 6} /> : null}
      {screen === "permissions" ? <PermissionPicker selected={permissionMode} theme={theme} /> : null}
      {screen === "theme" ? <ThemePicker selected={themeName} theme={theme} /> : null}
      {screen === "mcp" ? <McpPanel servers={mcpServers} theme={theme} /> : null}
      {screen === "help" ? <Help theme={theme} commands={availableCommands} /> : null}
      {screen === "rewind" ? <RewindMenu checkpoints={visibleCheckpoints} cursor={rewindCursor} busy={rewindBusy} theme={theme} /> : null}
    </Box>
    {screen === "chat" && pendingPermission === undefined && pendingQuestion === undefined && historySearch === undefined && commandMatches.length > 0 ? <CommandPalette commands={commandMatches} cursor={commandCursor} theme={theme} />
      : screen === "chat" && pendingPermission === undefined && pendingQuestion === undefined && historySearch === undefined && mentionQuery !== undefined && mentionMatches.length > 0 ? <MentionPalette entries={mentionMatches} cursor={mentionCursor} theme={theme} /> : null}
    {pendingQuestion !== undefined
      ? <QuestionCard request={pendingQuestion} questionIndex={questionIndex} cursor={questionCursor} selections={questionSelections} otherMode={questionOtherMode} otherEditor={questionOtherEditor} theme={theme} width={width - 4} />
      : pendingPermission === undefined ? <Composer editor={editor} busy={busy} screen={screen} context={contextUsage} lastTurnTokens={lastTurnTokens} lastTurnCostUsd={lastTurnCostUsd} checkpointCount={checkpoints.length} historySearch={historySearch} historyMatches={historyMatches} messages={messages} suggestion={promptSuggestion} vim={vimEnabled ? vim : undefined} attachmentCount={attachments.length} theme={theme} width={width} /> : <PermissionCard request={pendingPermission} cursor={permissionCursor} theme={theme} />}
  </Box>;
}

export function reduceSdkMessage(current: readonly TranscriptItem[], message: SDKMessage): TranscriptItem[] {
  let items = [...current];
  if (message.type === "stream_event") {
    const event = message.event as unknown;
    if (!isRecord(event)) return items;
    const delta = isRecord(event.delta) ? event.delta : undefined;
    if (event.type === "content_block_delta" && typeof delta?.text === "string") return appendAssistantDelta(items, sanitizeTerminalText(delta.text), message.parent_tool_use_id);
    if (event.type === "content_block_start" && isRecord(event.content_block) && event.content_block.type === "tool_use") {
      const name = typeof event.content_block.name === "string" ? event.content_block.name : "tool";
      return [...items, { id: `tool-${message.uuid}-${items.length}`, role: "tool", text: name, status: "running", ...(message.parent_tool_use_id === null ? {} : { detail: "subagent" }) }];
    }
  }
  if (message.type === "system" && message.subtype === "notification") return [...items, { id: message.uuid, role: "system", text: sanitizeTerminalText(message.text) }];
  if (message.type === "system" && message.subtype === "task_started") return [...items, { id: `task-${message.task_id}`, role: "tool", text: sanitizeTerminalText(message.description), detail: "subagent", status: "running" }];
  if (message.type === "system" && message.subtype === "task_progress" && message.summary) return upsertTool(items, `task-${message.task_id}`, sanitizeTerminalText(message.summary), "running", "subagent");
  if (message.type === "system" && message.subtype === "task_notification") return upsertTool(items, `task-${message.task_id}`, sanitizeTerminalText(message.summary), message.status === "completed" ? "completed" : "failed", "subagent");
  if (message.type === "result") {
    items = items.map((item) => item.role === "tool" && item.status === "running" ? { ...item, status: message.is_error ? "failed" as const : "completed" as const } : item);
    if (message.is_error) {
      const text = message.subtype === "success" ? message.result : message.errors.join(" · ");
      return [...items, { id: message.uuid, role: "system", text: sanitizeTerminalText(text || "The engine stopped with an error.") }];
    }
  }
  return items;
}

function appendAssistantDelta(items: TranscriptItem[], text: string, parent: string | null): TranscriptItem[] {
  const last = items.at(-1);
  const streamId = parent;
  if (last?.role === "assistant" && last.streamId === streamId) return [...items.slice(0, -1), { ...last, text: last.text + text }];
  return [...items, { id: createTranscriptItemId("assistant"), role: "assistant", text, streamId }];
}
function upsertTool(items: TranscriptItem[], id: string, text: string, status: "running" | "completed" | "failed", detail: string): TranscriptItem[] {
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) return [...items, { id, role: "tool", text, status, detail }];
  return items.map((item, itemIndex) => itemIndex === index ? { ...item, text, status, detail } : item);
}

function Header({ model, mode, providers, compatible, busy, theme, width }: { readonly model: string; readonly mode: PermissionMode; readonly providers: number; readonly compatible: boolean; readonly busy: boolean; readonly theme: Theme; readonly width: number }): React.JSX.Element {
  const pulse = usePulse(busy);
  const modelWidth = Math.max(16, Math.min(34, width - 48));
  return <Box justifyContent="space-between" borderStyle="round" borderColor={busy ? theme.secondary : theme.border} paddingX={1} marginBottom={1}>
    <Box width={12}><Brand theme={theme} compact /></Box>
    <Box columnGap={2} justifyContent="flex-end" flexGrow={1}>
      <Text color={busy ? theme.secondary : theme.success}>{busy ? pulse : "●"} <Text bold>{busy ? "working" : "ready"}</Text></Text>
      <Box width={modelWidth}><Text color={theme.muted} wrap="truncate-middle">{providerFromRoute(model)} / <Text color={theme.secondarySoft}>{shortModel(model)}</Text></Text></Box>
      <Text color={theme.faint} wrap="truncate-end">{providers}P · {mode}{compatible ? "" : " · mismatch"}</Text>
    </Box>
  </Box>;
}

function Transcript({ items, theme, width, busy }: { readonly items: readonly TranscriptItem[]; readonly theme: Theme; readonly width: number; readonly busy: boolean }): React.JSX.Element {
  if (items.length === 0) return <EmptyState theme={theme} />;
  return <>{items.map((item) => {
    if (item.role === "assistant") return <Box key={item.id} marginTop={1} paddingLeft={2}><Markdown theme={theme} width={width - 2}>{item.text}</Markdown></Box>;
    if (item.role === "user") return <Box key={item.id} marginTop={1}><Box width={2}><Text bold color={theme.secondary}>❯</Text></Box><Text color={theme.text}>{item.text}</Text></Box>;
    if (item.role === "tool") return <ToolActivity key={item.id} item={item} theme={theme} />;
    return <Box key={item.id} marginTop={1}><Text color={theme.warning}>! </Text><Text color={theme.muted}>{item.text}</Text></Box>;
  })}{busy && items.at(-1)?.role !== "tool" ? <ThinkingLine theme={theme} /> : null}</>;
}
function ToolActivity({ item, theme }: { readonly item: TranscriptItem; readonly theme: Theme }): React.JSX.Element {
  const spinner = useSpinner(item.status === "running");
  const icon = item.status === "running" ? spinner : item.status === "failed" ? "×" : "✓";
  const color = item.status === "running" ? theme.accent : item.status === "failed" ? theme.danger : theme.success;
  return <Box paddingLeft={2}><Text color={color}>{icon}</Text><Text color={theme.muted}> {item.detail === undefined ? "tool" : item.detail} · </Text><Text color={theme.text}>{item.text}</Text></Box>;
}
function ThinkingLine({ theme }: { readonly theme: Theme }): React.JSX.Element { const spinner = useSpinner(); return <Box paddingLeft={2}><Text color={theme.accent}>{spinner}</Text><Text color={theme.muted}> Thinking…</Text></Box>; }

function Composer({ editor, busy, screen, context, lastTurnTokens, lastTurnCostUsd, checkpointCount, historySearch, historyMatches, messages, suggestion, vim, attachmentCount, theme, width }: { readonly editor: EditorState; readonly busy: boolean; readonly screen: Screen; readonly context: ContextUsage | undefined; readonly lastTurnTokens: number | undefined; readonly lastTurnCostUsd: number | undefined; readonly checkpointCount: number; readonly historySearch: { readonly query: string; readonly index: number } | undefined; readonly historyMatches: readonly string[]; readonly messages: readonly TranscriptItem[]; readonly suggestion: string | undefined; readonly vim: VimState | undefined; readonly attachmentCount: number; readonly theme: Theme; readonly width: number }): React.JSX.Element {
  if (historySearch !== undefined) {
    const match = historyMatches[historySearch.index % Math.max(1, historyMatches.length)];
    return <Box flexDirection="column" marginTop={1}>
      <Box borderStyle="round" borderColor={theme.accent} paddingX={1} minHeight={3}>
        <Text bold color={theme.accent}>history ❯ </Text>
        <Text color={theme.muted}>(reverse-i-search)`</Text><Text color={theme.text}>{historySearch.query}</Text><Text color={theme.muted}>': </Text>
        <Text color={theme.text} wrap="truncate-end">{match ?? ""}</Text>
      </Box>
      <Box paddingX={1} columnGap={2}><Text color={theme.faint}>{historyMatches.length} match{historyMatches.length === 1 ? "" : "es"} · ctrl+r next · enter accept · esc cancel</Text></Box>
    </Box>;
  }
  const split = splitAtCursor(editor);
  const promptTokens = estimateTokens(editor.value);
  const contextLeft = context === undefined ? undefined : Math.max(0, context.maxTokens - context.totalTokens);
  const compact = width < 96;
  const canRewind = screen === "chat" && !busy && editor.value.length === 0 && checkpointCount > 0;
  const vimHint = vim === undefined ? undefined : vim.mode === "insert" ? "esc normal mode" : vim.mode === "visual" ? "y/d/c act on selection · esc cancel" : "i insert · hjkl/w/b/e move · dd/dw/cc/cw/yy/p/u edit";
  const leftHint = screen !== "chat" ? "esc back" : vimHint !== undefined ? vimHint : suggestion !== undefined && editor.value.length === 0 ? "tab accept · type dismisses" : busy ? "ctrl+c stop · type to queue" : compact ? `↵ send · ⇧↵ newline · / commands${canRewind ? " · esc esc rewind" : ""}` : `enter send · shift+enter newline · / commands${canRewind ? " · esc esc rewind" : ""}`;
  const rightHint = `${attachmentCount > 0 ? `${attachmentCount} image${attachmentCount === 1 ? "" : "s"} · ` : ""}${promptTokens > 0 ? `~${formatCompact(promptTokens)} draft · ` : ""}${lastTurnTokens === undefined ? "" : `${formatCompact(lastTurnTokens)} turn · `}${lastTurnCostUsd === undefined ? "" : `${formatCostUsd(lastTurnCostUsd)} turn · `}${contextLeft === undefined ? "ctx —" : `${formatCompact(contextLeft)} ctx left`}`;
  return <Box flexDirection="column" marginTop={1}>
    <Box borderStyle="round" borderColor={busy ? theme.secondary : screen === "chat" ? theme.accent : theme.border} paddingX={1} minHeight={3}>
      {vim === undefined ? null : <Text bold color={vim.mode === "insert" ? theme.success : vim.mode === "visual" ? theme.secondary : theme.warning}>{vim.mode.toUpperCase()} </Text>}
      <Text bold color={theme.accent}>❯ </Text>
      {screen !== "chat" ? <Text color={theme.faint}>Press Esc to return to chat</Text> : editor.value.length === 0 ? <Text><Text inverse color={theme.text}> </Text><Text color={suggestion === undefined ? theme.faint : theme.muted}>{suggestion ?? contextualHint(messages, busy)}</Text></Text> : <Text wrap="wrap"><Text color={theme.text}>{split.before}</Text><Text inverse color={theme.text}>{split.cursor}</Text><Text color={theme.text}>{split.after}</Text></Text>}
    </Box>
    <Box paddingX={1} columnGap={2}><Box flexGrow={1}><Text color={theme.faint} wrap="truncate-end">{leftHint}</Text></Box><Text color={theme.faint}>{rightHint}</Text></Box>
  </Box>;
}

function CommandPalette({ commands: matches, cursor, theme }: { readonly commands: readonly Command[]; readonly cursor: number; readonly theme: Theme }): React.JSX.Element {
  const start = Math.max(0, Math.min(cursor - 2, Math.max(0, matches.length - 6)));
  return <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1} marginX={1}><Text bold color={theme.muted}>COMMANDS <Text color={theme.faint}>↑↓ navigate · tab complete · enter run</Text></Text>{matches.slice(start, start + 6).map((command, index) => { const active = start + index === cursor; return <Box key={command.name} justifyContent="space-between"><Text color={active ? theme.accent : theme.text}>{active ? "❯ " : "  "}<Text bold={active}>{command.name}</Text><Text color={theme.muted}>  {command.description}</Text></Text>{command.shortcut === undefined ? null : <Text color={theme.faint}>{command.shortcut}</Text>}</Box>; })}</Box>;
}

/** Mirrors CommandPalette's navigate/tab/accept interaction on purpose — see mentions.ts. */
function MentionPalette({ entries, cursor, theme }: { readonly entries: readonly MentionEntry[]; readonly cursor: number; readonly theme: Theme }): React.JSX.Element {
  const start = Math.max(0, Math.min(cursor - 2, Math.max(0, entries.length - 6)));
  return <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1} marginX={1}><Text bold color={theme.muted}>FILES <Text color={theme.faint}>↑↓ navigate · tab insert</Text></Text>{entries.slice(start, start + 6).map((entry, index) => { const active = start + index === cursor; return <Box key={entry.relativePath}><Text color={active ? theme.accent : theme.text}>{active ? "❯ " : "  "}<Text bold={active}>{entry.relativePath}{entry.isDirectory ? "/" : ""}</Text></Text></Box>; })}{entries.length === 0 ? <Text color={theme.muted}>No matching files.</Text> : null}</Box>;
}

function ModelPicker({ models, cursor, filter, theme, height }: { readonly models: readonly ModelDescriptor[]; readonly cursor: number; readonly filter: string; readonly theme: Theme; readonly height: number }): React.JSX.Element {
  const visibleRows = Math.max(5, height - 4);
  const start = Math.max(0, Math.min(cursor - Math.floor(visibleRows / 2), Math.max(0, models.length - visibleRows)));
  return <Box flexDirection="column"><SectionTitle title="Models" detail={`${models.length} live, tool-capable matches`} theme={theme} /><Box borderStyle="round" borderColor={theme.border} paddingX={1} marginBottom={1}><Text color={theme.accent}>⌕ </Text><Text>{filter}</Text><Text inverse> </Text>{filter.length === 0 ? <Text color={theme.faint}> type to search provider, model or id</Text> : null}</Box>{models.slice(start, start + visibleRows).map((model) => { const active = models[cursor] === model; const capabilities = [model.capabilities.reasoningState !== "none" ? "reasoning" : undefined, model.capabilities.vision ? "vision" : undefined, model.support === "contract-tested" ? "verified" : "best effort"].filter(Boolean).join(" · "); return <Box key={`${model.providerId}/${model.id}`} flexDirection="column" paddingLeft={active ? 0 : 2}><Text color={active ? theme.accent : theme.text}>{active ? "❯ " : ""}<Text bold={active}>{model.displayName}</Text><Text color={theme.muted}>  [{model.providerId}]</Text></Text>{active ? <Text color={theme.faint}>  {formatCompact(model.contextWindow)} context · {capabilities}</Text> : null}</Box>; })}{models.length === 0 ? <Text color={theme.muted}>No verified tool-capable model matches this filter.</Text> : null}<HintBar theme={theme}>↑↓ navigate · enter switch · esc back</HintBar></Box>;
}

function ProviderManager({ providers, models, cursor, defaultId, theme }: { readonly providers: readonly ProviderRecord[]; readonly models: readonly ModelDescriptor[]; readonly cursor: number; readonly defaultId?: string; readonly theme: Theme }): React.JSX.Element {
  return <Box flexDirection="column"><SectionTitle title="Providers" detail="all active simultaneously · routing is automatic" theme={theme} />{providers.map((provider, index) => { const available = models.filter((model) => model.providerId === provider.id && model.availability === "available" && model.capabilities.tools).length; const active = cursor === index; return <Box key={provider.id} flexDirection="column" borderStyle="round" borderColor={active ? theme.accent : theme.border} paddingX={1} marginBottom={1}><Box justifyContent="space-between"><Text bold color={active ? theme.accent : theme.text}>{active ? "◆ " : "◇ "}{provider.id}</Text><StatusBadge label={available > 0 ? "ready" : "unavailable"} tone={available > 0 ? "success" : "danger"} theme={theme} /></Box><Text color={theme.muted}>{provider.type} · {provider.apiKey === undefined ? "public access" : provider.apiKey.kind === "keychain" ? "Keychain" : `env ${provider.apiKey.name}`} · {available} callable model{available === 1 ? "" : "s"}{provider.id === defaultId ? " · preferred tie-breaker" : ""}</Text></Box>; })}{providers.length === 0 ? <Text color={theme.muted}>No provider connected. Press a to add one.</Text> : null}<HintBar theme={theme}>a add · d delete · r reconnect · enter prefer · esc back</HintBar></Box>;
}
function DeleteConfirmation({ providerId, theme }: { readonly providerId: string; readonly theme: Theme }): React.JSX.Element { return <Box flexDirection="column" borderStyle="double" borderColor={theme.danger} paddingX={2} paddingY={1}><Text bold color={theme.danger}>Delete “{providerId}”?</Text><Text color={theme.text}>Its AlfaCode configuration and Keychain credential will be removed.</Text><Box marginTop={1} columnGap={2}><KeyHint shortcut="y" label="delete permanently" theme={theme} /><KeyHint shortcut="n" label="cancel" theme={theme} /></Box></Box>; }

function UsagePanel({ usage, context, sessionCostUsd, theme, width }: { readonly usage: UsageSummary | undefined; readonly context: ContextUsage | undefined; readonly sessionCostUsd: number | undefined; readonly theme: Theme; readonly width: number }): React.JSX.Element {
  if (usage === undefined || context === undefined) return <Text color={theme.muted}>Usage is not available yet. Send a prompt first.</Text>;
  const trackedTokens = usage.attempts.reduce((total, attempt) => total + attemptTokenCount(attempt), 0);
  const providers = [...new Set(usage.attempts.map((attempt) => attempt.providerId))].map((providerId) => { const attempts = usage.attempts.filter((attempt) => attempt.providerId === providerId); return { providerId, attempts: attempts.length, completed: attempts.filter((attempt) => attempt.outcome === "completed").length, failed: attempts.filter((attempt) => attempt.outcome === "failed").length, tokens: attempts.reduce((total, attempt) => total + attemptTokenCount(attempt), 0) }; });
  const categories = (context.categories ?? []).filter((category) => category.tokens > 0).slice(0, 6);
  return <Box flexDirection="column">
    <SectionTitle title="Usage" detail="local, content-free accounting" theme={theme} />
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1} marginBottom={1}>
      <Box justifyContent="space-between"><Text bold>Context window</Text><Text color={theme.secondarySoft}>{formatCompact(context.totalTokens)} / {formatCompact(context.maxTokens)} · {context.percentage.toFixed(1)}%</Text></Box>
      <ProgressBar value={context.percentage / 100} width={Math.max(10, Math.min(64, width - 4))} theme={theme} />
      <Text color={theme.faint}>{formatCompact(Math.max(0, context.maxTokens - context.totalTokens))} tokens left · {shortModel(context.model)}</Text>
      {categories.length === 0 ? null : <Box flexDirection="column" marginTop={1}>{categories.map((category) => <Box key={category.name} justifyContent="space-between"><Text color={theme.muted}>{category.name}{category.isDeferred ? " · deferred" : ""}</Text><Text color={theme.text}>{formatCompact(category.tokens)}</Text></Box>)}</Box>}
    </Box>
    <Box columnGap={3} marginBottom={1}><Metric label="tracked" value={trackedTokens} theme={theme} /><Metric label="input" value={usage.totals.inputTokens} theme={theme} /><Metric label="output" value={usage.totals.outputTokens} theme={theme} /><Metric label="cache" value={usage.totals.cachedInputTokens} theme={theme} />{sessionCostUsd === undefined ? null : <Metric label="session est." value={sessionCostUsd} format={formatCostUsd} theme={theme} />}</Box>
    {providers.map((provider) => <Box key={provider.providerId} justifyContent="space-between"><Text bold>[{provider.providerId}]</Text><Text>{formatCompact(provider.tokens)} tokens <Text color={theme.faint}>· {provider.completed}/{provider.attempts} completed{provider.failed > 0 ? ` · ${provider.failed} failed` : ""}</Text></Text></Box>)}
    <Box marginTop={1} flexDirection="column"><Text bold color={theme.muted}>RECENT ATTEMPTS</Text>{usage.attempts.slice(0, 6).map((attempt) => <Text key={attempt.id} color={attempt.outcome === "failed" ? theme.danger : theme.text}>{attempt.outcome === "completed" ? "✓" : attempt.outcome === "failed" ? "×" : "·"} [{attempt.providerId}] {shortModel(attempt.upstreamModel)} <Text color={theme.faint}>{attemptHasUsage(attempt) ? `${formatCompact(attemptTokenCount(attempt))} tokens` : "usage unavailable"}{attempt.errorClass === undefined ? "" : ` · ${attempt.errorClass}`}</Text></Text>)}</Box>
    <HintBar theme={theme}>esc back · no prompt or response content is stored{sessionCostUsd === undefined ? "" : " · cost is the engine's own estimate, not a bill"}</HintBar>
  </Box>;
}
function Metric({ label, value, format, theme }: { readonly label: string; readonly value: number; readonly format?: (value: number) => string; readonly theme: Theme }): React.JSX.Element { return <Box flexDirection="column"><Text bold color={theme.secondarySoft}>{format === undefined ? formatCompact(value) : format(value)}</Text><Text color={theme.faint}>{label}</Text></Box>; }
function PermissionPicker({ selected, theme }: { readonly selected: PermissionMode; readonly theme: Theme }): React.JSX.Element {
  const descriptions: Partial<Record<PermissionMode, string>> = { default: "Ask before sensitive actions", acceptEdits: "Accept file edits", plan: "Read-only planning", dontAsk: "Deny unapproved actions", bypassPermissions: "Bypass every prompt", auto: "Engine evaluates risk automatically" };
  return <Box flexDirection="column"><SectionTitle title="Permission mode" detail="controls how tools are approved" theme={theme} />{modes.map((mode) => <Box key={mode} flexDirection="column" paddingLeft={selected === mode ? 0 : 2}><Text color={selected === mode ? theme.accent : theme.text}>{selected === mode ? "❯ " : ""}<Text bold={selected === mode}>{mode}</Text></Text>{selected === mode ? <Text color={theme.faint}>  {descriptions[mode] ?? "Custom engine permission mode"}</Text> : null}</Box>)}<HintBar theme={theme}>↑↓ select · enter apply · esc back</HintBar></Box>;
}
function ThemePicker({ selected, theme }: { readonly selected: ThemeName; readonly theme: Theme }): React.JSX.Element {
  return <Box flexDirection="column"><SectionTitle title="Theme" detail="dark, light, and colorblind-friendly variants" theme={theme} />{themeCatalog.map((entry) => {
    const active = selected === entry.name;
    return <Box key={entry.name} flexDirection="column" paddingLeft={active ? 0 : 2}>
      <Text color={active ? entry.theme.accent : theme.text}>{active ? "❯ " : ""}<Text bold={active}>{entry.label}</Text>{entry.theme.colorblindSafe ? <Text color={theme.faint}> · daltonized</Text> : null}</Text>
      {active ? <Text color={theme.faint}>  {entry.description}</Text> : null}
    </Box>;
  })}<HintBar theme={theme}>↑↓ preview live · enter confirm · esc back</HintBar></Box>;
}

function McpPanel({ servers, theme }: { readonly servers: readonly McpServerStatus[]; readonly theme: Theme }): React.JSX.Element {
  if (servers.length === 0) return <Box flexDirection="column"><SectionTitle title="MCP servers" detail="0 configured" theme={theme} /><Text color={theme.muted}>No MCP servers are configured for this session.</Text><HintBar theme={theme}>esc back</HintBar></Box>;
  return <Box flexDirection="column"><SectionTitle title="MCP servers" detail={`${servers.length} configured`} theme={theme} />{servers.map((server) => {
    const toolCount = server.tools?.length ?? 0;
    const tone = server.status === "connected" ? "success" : server.status === "pending" || server.status === "needs-auth" ? "warning" : server.status === "disabled" ? "muted" : "danger";
    return <Box key={server.name} flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1} marginBottom={1}>
      <Box justifyContent="space-between"><Text bold color={theme.text}>{server.name}</Text><StatusBadge label={server.status} tone={tone} theme={theme} /></Box>
      <Text color={theme.muted}>{toolCount} tool{toolCount === 1 ? "" : "s"}{server.scope === undefined ? "" : ` · ${server.scope}`}</Text>
      {server.error === undefined ? null : <Text color={theme.danger} wrap="truncate-end">{sanitizeTerminalText(server.error)}</Text>}
    </Box>;
  })}<HintBar theme={theme}>esc back</HintBar></Box>;
}

function QuestionCard({ request, questionIndex, cursor, selections, otherMode, otherEditor, theme, width }: { readonly request: UserQuestionRequest; readonly questionIndex: number; readonly cursor: number; readonly selections: Readonly<Record<number, readonly string[]>>; readonly otherMode: boolean; readonly otherEditor: EditorState; readonly theme: Theme; readonly width: number }): React.JSX.Element {
  const question = request.questions[questionIndex];
  if (question === undefined) return <></>;
  const selected = selections[questionIndex] ?? [];
  const focused = question.options[cursor];
  const preview = focused?.preview === undefined ? undefined : truncatePreview(focused.preview);
  const split = splitAtCursor(otherEditor);
  return <Box flexDirection="column" borderStyle="double" borderColor={theme.secondary} paddingX={2} paddingY={1} marginTop={1}>
    <Box justifyContent="space-between"><Text bold color={theme.secondarySoft}>◆ {question.header.toUpperCase()}</Text><Text color={theme.faint}>{questionIndex + 1} / {request.questions.length} · {question.multiSelect ? "multiple choice" : "single choice"}</Text></Box>
    <Box marginTop={1}><Text bold color={theme.text}>{question.question}</Text></Box>
    <Box flexDirection="column" marginTop={1}>{question.options.map((option, index) => {
      const active = cursor === index && !otherMode;
      const checked = selected.includes(option.label);
      return <Box key={option.label} flexDirection="column" paddingLeft={active ? 0 : 2}>
        <Text color={active ? theme.accent : checked ? theme.success : theme.text}>{active ? "❯ " : ""}{question.multiSelect ? checked ? "[✓] " : "[ ] " : checked ? "◉ " : "○ "}<Text bold={active || checked}>{option.label}</Text></Text>
        {active ? <Text color={theme.muted}>    {option.description}</Text> : null}
      </Box>;
    })}
      <Box flexDirection="column" paddingLeft={cursor === question.options.length && !otherMode ? 0 : 2}>
        <Text color={cursor === question.options.length || otherMode ? theme.accent : theme.text}>{cursor === question.options.length && !otherMode ? "❯ " : ""}○ <Text bold={otherMode}>Other</Text><Text color={theme.faint}>  type a custom answer</Text></Text>
      </Box>
    </Box>
    {preview === undefined || otherMode ? null : <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1} marginTop={1}><Text bold color={theme.faint}>PREVIEW</Text><Markdown theme={theme} width={Math.max(20, width - 8)}>{preview}</Markdown></Box>}
    {otherMode ? <Box flexDirection="column" marginTop={1}><Text bold color={theme.muted}>YOUR ANSWER</Text><Box borderStyle="round" borderColor={theme.accent} paddingX={1}><Text>{split.before}</Text><Text inverse>{split.cursor}</Text><Text>{split.after}</Text></Box><Text color={theme.faint}>enter confirm · esc return to choices</Text></Box> : <Text color={theme.faint}>{question.multiSelect ? "space toggle · enter confirm · " : "enter select · "}↑↓ navigate · tab next · esc dismiss</Text>}
  </Box>;
}
function PermissionCard({ request, cursor, theme }: { readonly request: PermissionRequest; readonly cursor: number; readonly theme: Theme }): React.JSX.Element {
  const options = request.suggestions.length > 0 ? ["Deny", "Allow once", "Always allow"] : ["Deny", "Allow once"];
  return <Box flexDirection="column" borderStyle="double" borderColor={theme.warning} paddingX={2} paddingY={1} marginTop={1}><Text bold color={theme.warning}>⚠ {request.title ?? `${request.toolName} requests permission`}</Text>{request.description ? <Text color={theme.text}>{request.description}</Text> : null}<Text color={theme.muted} wrap="truncate-end">{permissionInputSummary(request)}</Text>{request.reason ? <Text color={theme.faint}>{request.reason}</Text> : null}<Box marginTop={1} columnGap={2}>{options.map((option, index) => <Text key={option} bold={index === cursor} inverse={index === cursor} color={index === 0 ? theme.danger : theme.success}> {option} </Text>)}</Box><Text color={theme.faint}>←→ choose · enter confirm</Text></Box>;
}
function Help({ theme, commands: available }: { readonly theme: Theme; readonly commands: readonly Command[] }): React.JSX.Element { return <Box flexDirection="column"><SectionTitle title="Commands & shortcuts" detail={`${available.length} AlfaCode and engine commands available`} theme={theme} />{available.slice(0, 12).map((command) => <Box key={command.name}><Box width={18}><Text bold color={theme.accent}>{command.name}</Text></Box><Text color={theme.muted}>{command.description}</Text></Box>)}{available.length > 12 ? <Text color={theme.faint}>Type / and search to browse all {available.length} commands.</Text> : null}<Box marginTop={1} flexDirection="column"><Text bold color={theme.muted}>COMPOSER</Text><Text>↑↓ history · ctrl+r search history · ←→ cursor · home/end · ctrl+u/k/w · shift+enter newline</Text><Text>esc esc on an empty prompt rewinds · shift+tab cycles permission mode · ctrl+c interrupts or exits</Text><Text>@ mentions a file · ctrl+v pastes a clipboard image · /vim toggles modal editing</Text></Box><HintBar theme={theme}>esc back</HintBar></Box>; }
function RewindMenu({ checkpoints: entries, cursor, busy, theme }: { readonly checkpoints: readonly Checkpoint[]; readonly cursor: number; readonly busy: boolean; readonly theme: Theme }): React.JSX.Element {
  if (entries.length === 0) return <Text color={theme.muted}>Nothing to rewind to yet.</Text>;
  return <Box flexDirection="column">
    <SectionTitle title="Rewind" detail="restore the conversation, and tracked file edits, to an earlier prompt" theme={theme} />
    {entries.map((checkpoint, index) => {
      const active = index === cursor;
      return <Box key={checkpoint.uuid} flexDirection="column" paddingLeft={active ? 0 : 2}>
        <Text color={active ? theme.accent : theme.text}>{active ? "❯ " : ""}<Text bold={active}>{truncateOneLine(checkpoint.text, 76)}</Text></Text>
        {active ? <Text color={theme.faint}>  {formatRelativeTime(checkpoint.at)}</Text> : null}
      </Box>;
    })}
    <HintBar theme={theme}>{busy ? "restoring…" : "↑↓ select · enter rewind · esc cancel"}</HintBar>
  </Box>;
}

export function commandSuggestions(value: string, available: readonly Command[] = commands): readonly Command[] { if (!value.startsWith("/") || value.includes(" ") || value.includes("\n")) return []; const needle = value.toLowerCase(); return available.filter((command) => command.name.startsWith(needle)); }
function mergeCommands(local: readonly Command[], engine: readonly Command[]): readonly Command[] { const merged = new Map(engine.map((command) => [command.name, command])); for (const command of local) merged.set(command.name, command); return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name)); }
function toCommands(supported: readonly { readonly name: string; readonly description: string; readonly argumentHint: string; readonly aliases?: readonly string[] }[]): readonly Command[] { return supported.flatMap((command) => { const name = safeCommandName(command.name); if (name === undefined) return []; const primary: Command = { name, description: sanitizeTerminalText(command.description).slice(0, 240), ...(command.argumentHint.length === 0 ? {} : { shortcut: sanitizeTerminalText(command.argumentHint).slice(0, 80) }) }; return [primary, ...(command.aliases ?? []).flatMap((alias) => { const aliasName = safeCommandName(alias); return aliasName === undefined ? [] : [{ name: aliasName, description: `Alias for ${name}` }]; })]; }); }
export function tailItemsByRows(items: readonly TranscriptItem[], rows: number, width: number): readonly TranscriptItem[] {
  let used = 0; const output: TranscriptItem[] = [];
  for (let index = items.length - 1; index >= 0; index -= 1) { const item = items[index]; if (item === undefined) continue; const estimated = Math.max(1, item.text.split("\n").reduce((total, line) => total + Math.max(1, Math.ceil(line.length / Math.max(12, width))), 0)) + 1; if (output.length > 0 && used + estimated > rows) break; output.unshift(item); used += estimated; }
  return output;
}
async function refreshTelemetry(session: AgentSession, loadUsage: () => Promise<UsageSummary>, setContext: React.Dispatch<React.SetStateAction<ContextUsage | undefined>>, setUsage: React.Dispatch<React.SetStateAction<UsageSummary | undefined>>, setLatestTurn?: React.Dispatch<React.SetStateAction<number | undefined>>, onContext?: (context: ContextUsage) => void): Promise<void> { const [contextResult, usageResult] = await Promise.allSettled([session.contextUsage(), loadUsage()]); if (contextResult.status === "fulfilled") { setContext(contextResult.value); onContext?.(contextResult.value); } if (usageResult.status === "fulfilled") { setUsage(usageResult.value); const latest = usageResult.value.attempts[0]; if (setLatestTurn !== undefined) setLatestTurn(latest === undefined || !attemptHasUsage(latest) ? undefined : attemptTokenCount(latest)); } }
/** Usage percentage at which we nudge toward /compact: the engine's own auto-compact point when it's a sane percentage, else a static fallback. */
export function contextFullThreshold(context: Pick<ContextUsage, "autoCompactThreshold">): number {
  const { autoCompactThreshold } = context;
  return autoCompactThreshold !== undefined && autoCompactThreshold > 0 && autoCompactThreshold <= 100 ? autoCompactThreshold : defaultContextWarningThreshold;
}
/** A one-shot "context is getting full" nudge, or undefined when below threshold or already shown for this crossing. */
export function contextFullWarning(context: ContextUsage, alreadyWarned: boolean): string | undefined {
  if (alreadyWarned || context.percentage < contextFullThreshold(context)) return undefined;
  const auto = context.isAutoCompactEnabled === true ? " before the engine compacts it for you" : "";
  return `Context is ${Math.round(context.percentage)}% full. Run /compact [instructions] to summarize and free up space${auto}.`;
}
/** This turn's estimated cost (USD), derived from the engine's cumulative session total. Undefined when the engine didn't report a cost. */
export function turnCostFromResult(message: SDKResultMessage, previousCumulativeUsd: number): { readonly turnCostUsd: number; readonly cumulativeCostUsd: number } | undefined {
  const cumulative = message.total_cost_usd;
  if (typeof cumulative !== "number" || !Number.isFinite(cumulative)) return undefined;
  return { turnCostUsd: Math.max(0, cumulative - previousCumulativeUsd), cumulativeCostUsd: cumulative };
}
export function historySearchMatches(history: readonly string[], query: string): readonly string[] {
  if (query.length === 0) return history;
  const needle = query.toLowerCase();
  return history.filter((item) => item.toLowerCase().includes(needle));
}
/** Drops `itemId` and everything after it from the transcript (used to restore the view to an earlier checkpoint). */
export function truncateTranscriptAt(items: readonly TranscriptItem[], itemId: string): TranscriptItem[] {
  const index = items.findIndex((item) => item.id === itemId);
  return index < 0 ? [...items] : items.slice(0, index);
}
export function truncateCheckpointsAt(checkpoints: readonly Checkpoint[], uuid: string): Checkpoint[] {
  const index = checkpoints.findIndex((item) => item.uuid === uuid);
  return index < 0 ? [...checkpoints] : checkpoints.slice(0, index);
}
export function truncateOneLine(value: string, max: number): string {
  const line = value.replace(/\s+/gu, " ").trim();
  return line.length > max ? `${line.slice(0, Math.max(0, max - 1))}…` : line;
}
/** Formats a USD estimate with enough precision to not always read as "$0.00" for a cheap turn. */
export function formatCostUsd(value: number): string {
  if (value <= 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}
function contextualHint(messages: readonly TranscriptItem[], busy: boolean): string { if (busy) return "Queue your next request…"; const last = messages.at(-1); if (last === undefined) return "Ask AlfaCode anything, or type / for commands"; if (last.role === "system") return "Retry, switch /model, or inspect /usage"; if (last.role === "tool") return "Follow up on the tool result…"; return "Ask a follow-up, request a change, or type /"; }
function truncatePreview(value: string): string { const lines = value.split("\n"); const visible = lines.slice(0, 8).join("\n").slice(0, 1_200); return visible.length < value.length ? `${visible}\n\n_…preview truncated_` : visible; }
function safeCommandName(value: string): string | undefined { const sanitized = sanitizeTerminalText(value).trim().replace(/^\/+/, ""); return sanitized.length === 0 || /\s/u.test(sanitized) ? undefined : `/${sanitized.slice(0, 100)}`; }
export function createTranscriptItemId(prefix: "user" | "assistant" | "system"): string { transcriptItemSequence += 1; return `${prefix}-${transcriptItemSequence}`; }
function appendSystem(setter: React.Dispatch<React.SetStateAction<TranscriptItem[]>>, text: string): void { setter((current) => [...current, { id: createTranscriptItemId("system"), role: "system", text: sanitizeTerminalText(text) }]); }
function shortModel(model: string): string { return decodeModelId(model)?.upstreamModel ?? model.split("/").at(-1) ?? model; }
function providerFromRoute(model: string): string { return decodeModelId(model)?.providerId ?? model.split("/")[0] ?? "auto"; }
function toMentionPath(absolutePath: string): string { const relative = relativePath(process.cwd(), absolutePath); return relative.startsWith("..") ? absolutePath : relative; }
function formatCompact(value: number | undefined): string { if (value === undefined) return "—"; return compactNumberFormatter.format(value); }
function estimateTokens(value: string): number { return value.length === 0 ? 0 : Math.max(1, Math.ceil(value.length / 4)); }
function attemptHasUsage(attempt: UsageSummary["attempts"][number]): boolean { return attempt.totalTokens !== undefined || attempt.inputTokens !== undefined || attempt.outputTokens !== undefined; }
function attemptTokenCount(attempt: UsageSummary["attempts"][number]): number { return attempt.totalTokens ?? (attempt.inputTokens ?? 0) + (attempt.outputTokens ?? 0); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function routedModelFromMessage(message: SDKMessage): string | undefined { if (message.type !== "stream_event" || !isRecord(message.event) || message.event.type !== "message_start" || !isRecord(message.event.message)) return undefined; return typeof message.event.message.model === "string" ? message.event.message.model : undefined; }
function permissionInputSummary(request: PermissionRequest): string { const serialized = JSON.stringify(request.input); return sanitizeTerminalText(serialized.length > 500 ? `${serialized.slice(0, 497)}…` : serialized); }
