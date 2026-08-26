import React, { useMemo, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout, type Key } from "ink";
import type { ProviderDescriptor } from "./provider-descriptors.js";
import { editInput, splitAtCursor, type EditorOperation, type EditorState } from "./ui/input-editor.js";
import { sanitizeTerminalText } from "./ui/markdown.js";
import { Brand, HintBar, LoadingLabel, SectionTitle, StatusBadge } from "./ui/primitives.js";
import { resolveTheme, type Theme } from "./ui/theme.js";
import { isScreenReaderMode, numberedLabel, parseNumberedSelection } from "./ui/screen-reader-mode.js";

export interface ProviderSetupResult {
  readonly descriptor: ProviderDescriptor;
  readonly apiKey?: string;
  readonly baseUrl?: string;
}

export interface ProviderSetupOptions {
  readonly descriptors: readonly ProviderDescriptor[];
  readonly notice?: string;
  readonly connect: (result: ProviderSetupResult) => Promise<void>;
}

type Stage = "provider" | "auth" | "base-url" | "api-key" | "connecting" | "error";

export async function runProviderSetup(options: ProviderSetupOptions): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Provider setup requires an interactive terminal");
  const instance = render(<ProviderSetup {...options} />, { exitOnCtrlC: false, patchConsole: false, isScreenReaderEnabled: isScreenReaderMode() });
  await instance.waitUntilExit();
}

/** Exported (in addition to `runProviderSetup`) so tests can drive it directly through ink-testing-library without a real TTY. */
export function ProviderSetup({ descriptors, notice, connect }: ProviderSetupOptions): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const theme = useMemo(() => resolveTheme(), []);
  const [stage, setStage] = useState<Stage>("provider");
  const [query, setQuery] = useState<EditorState>({ value: "", cursor: 0 });
  const [cursor, setCursor] = useState(0);
  const [authCursor, setAuthCursor] = useState(0);
  const [selected, setSelected] = useState<ProviderDescriptor>();
  const [baseUrl, setBaseUrl] = useState<string>();
  const [editor, setEditor] = useState<EditorState>({ value: "", cursor: 0 });
  const [error, setError] = useState<string>();
  const [retryStage, setRetryStage] = useState<"auth" | "api-key">("api-key");
  const filtered = useMemo(() => {
    const needle = query.value.trim().toLowerCase();
    return needle.length === 0 ? descriptors : descriptors.filter((item) => `${item.displayName} ${item.description} ${item.id}`.toLowerCase().includes(needle));
  }, [descriptors, query.value]);
  const height = Math.max(5, (stdout.rows ?? 24) - 11);
  const visibleRows = Math.min(7, Math.max(2, Math.floor(height / 5)));
  const start = Math.max(0, Math.min(cursor - Math.floor(visibleRows / 2), Math.max(0, filtered.length - visibleRows)));
  const visible = filtered.slice(start, start + visibleRows);

  useInput((input, key) => {
    if (key.ctrl && input === "c") { exit(new Error("Setup cancelled")); return; }
    if (stage === "connecting") return;
    if (stage === "error") {
      if (key.return) { setError(undefined); setEditor({ value: "", cursor: 0 }); setStage(retryStage); }
      if (key.escape) backToProviders();
      return;
    }
    if (stage === "provider") { handleProviderSearch(input, key); return; }
    if (stage === "auth") { handleAuthChoice(input, key); return; }
    if (key.escape) { backToProviders(); return; }
    if (applyEditorKey(input, key, setEditor)) return;
    if (key.return) submitCredentialStage();
  });

  function handleProviderSearch(input: string, key: Key): void {
    if (key.upArrow) { setCursor((current) => Math.max(0, current - 1)); return; }
    if (key.downArrow) { setCursor((current) => Math.min(Math.max(0, filtered.length - 1), current + 1)); return; }
    if (key.escape && query.value.length > 0) { setQuery({ value: "", cursor: 0 }); setCursor(0); return; }
    if (isScreenReaderMode() && !key.ctrl && !key.meta && !key.return) {
      // Screen-reader mode: a single typed digit picks a numbered-list entry (see ProviderList)
      // immediately, resolved against the *current* (pre-keystroke) filtered list. Resolving at
      // Enter time instead would be wrong: the digit itself also feeds the search box below via
      // applyEditorKey, narrowing/renumbering `filtered` before Enter is ever pressed, so the
      // number would end up picked against a list that's no longer the one the user saw it in.
      // Matches the (already-correct) CommandPalette pattern in chat-tui.tsx.
      const numbered = parseNumberedSelection(input, filtered.length);
      const descriptor = numbered === undefined ? undefined : filtered[numbered];
      if (descriptor !== undefined) { selectProvider(descriptor); return; }
    }
    if (key.return) {
      const descriptor = filtered[cursor];
      if (descriptor !== undefined) selectProvider(descriptor);
      return;
    }
    if (applyEditorKey(input, key, setQuery)) setCursor(0);
  }

  function selectProvider(descriptor: ProviderDescriptor): void {
    setSelected(descriptor);
    setBaseUrl(undefined);
    setEditor({ value: descriptor.suggestedBaseUrl ?? "", cursor: descriptor.suggestedBaseUrl?.length ?? 0 });
    setStage(descriptor.allowsAnonymous ? "auth" : descriptor.requiresBaseUrl ? "base-url" : "api-key");
  }

  function handleAuthChoice(input: string, key: Key): void {
    if (isScreenReaderMode() && (input === "1" || input === "2")) { setAuthCursor(input === "1" ? 0 : 1); return; }
    if (key.upArrow || key.downArrow) { setAuthCursor((current) => current === 0 ? 1 : 0); return; }
    if (key.escape) { backToProviders(); return; }
    if (!key.return || selected === undefined) return;
    if (authCursor === 1) { setEditor({ value: "", cursor: 0 }); setStage("api-key"); return; }
    beginConnection({ descriptor: selected }, "auth");
  }

  function submitCredentialStage(): void {
    if (editor.value.trim().length === 0 || selected === undefined) return;
    if (stage === "base-url") {
      setBaseUrl(editor.value.trim());
      setEditor({ value: "", cursor: 0 });
      setStage("api-key");
      return;
    }
    if (stage === "api-key") {
      const apiKey = editor.value.trim();
      setEditor({ value: "", cursor: 0 });
      beginConnection({ descriptor: selected, apiKey, ...(baseUrl === undefined ? {} : { baseUrl }) }, "api-key");
    }
  }

  function beginConnection(result: ProviderSetupResult, retry: "auth" | "api-key"): void {
    setStage("connecting");
    setRetryStage(retry);
    void connect(result).then(() => exit()).catch((cause: unknown) => {
      setError(sanitizeTerminalText(cause instanceof Error ? cause.message : String(cause)));
      setStage("error");
    });
  }

  function backToProviders(): void {
    setEditor({ value: "", cursor: 0 });
    setSelected(undefined);
    setError(undefined);
    setStage("provider");
  }

  return <Box flexDirection="column" paddingX={2} width={Math.max(52, stdout.columns ?? 92)}>
    <Box justifyContent="space-between" borderStyle="round" borderColor={theme.border} paddingX={1} marginBottom={1}>
      <Brand theme={theme} compact />
      <Text color={theme.muted}>Provider setup</Text>
    </Box>
    <StepRail stage={stage} theme={theme} />
    {notice === undefined ? null : <Box borderStyle="single" borderColor={theme.warning} paddingX={1} marginBottom={1}><Text color={theme.warning}>! </Text><Text>{notice}</Text></Box>}
    <Box flexDirection="column" minHeight={height}>
      {stage === "provider" ? <ProviderList filtered={filtered} visible={visible} cursor={cursor} query={query} theme={theme} /> : null}
      {stage === "auth" ? <AuthChoice selected={selected} cursor={authCursor} theme={theme} /> : null}
      {stage === "base-url" ? <Prompt title={`${selected?.displayName ?? "Provider"} endpoint`} description="The OpenAI-compatible base URL, including its API version path." editor={editor} masked={false} theme={theme} /> : null}
      {stage === "api-key" ? <Prompt title={`Connect ${selected?.displayName ?? "provider"}`} description="Paste the API key issued by this provider. This is not your account password." editor={editor} masked theme={theme} {...(selected?.environmentVariables === undefined ? {} : { environmentVariables: selected.environmentVariables })} /> : null}
      {stage === "connecting" ? <Connecting selected={selected} theme={theme} /> : null}
      {stage === "error" ? <ConnectionError message={error} theme={theme} /> : null}
    </Box>
  </Box>;
}

function ProviderList({ filtered, visible, cursor, query, theme }: { readonly filtered: readonly ProviderDescriptor[]; readonly visible: readonly ProviderDescriptor[]; readonly cursor: number; readonly query: EditorState; readonly theme: Theme }): React.JSX.Element {
  const numbered = isScreenReaderMode();
  const start = filtered.length === 0 ? 0 : filtered.indexOf(visible[0]!);
  return <Box flexDirection="column">
    <SectionTitle title="Choose a provider" detail={`${filtered.length} connector${filtered.length === 1 ? "" : "s"} available`} theme={theme} />
    <SearchBox editor={query} placeholder="Search Google, Zen, Anthropic, OpenAI…" theme={theme} />
    <Box flexDirection="column" marginTop={1}>{visible.map((item, index) => {
      const active = filtered[cursor]?.id === item.id;
      return <Box key={item.id} flexDirection="column" borderStyle="round" borderColor={active ? theme.accent : theme.border} paddingX={1} marginBottom={1}>
        <Box justifyContent="space-between"><Text bold color={active ? theme.accent : theme.text}>{active ? "◆ " : "◇ "}{numbered ? numberedLabel(start + index, item.displayName) : item.displayName}</Text>{item.allowsAnonymous ? <StatusBadge label="free option" tone="success" theme={theme} /> : null}</Box>
        <Text color={theme.muted}>{item.description}</Text>
      </Box>;
    })}</Box>
    {filtered.length === 0 ? <Text color={theme.muted}>No provider matches “{query.value}”. Press Esc to clear the search.</Text> : null}
    <HintBar theme={theme}>{numbered ? "type a number to select · " : ""}↑↓ navigate · enter select · ctrl+c cancel</HintBar>
  </Box>;
}

function AuthChoice({ selected, cursor, theme }: { readonly selected: ProviderDescriptor | undefined; readonly cursor: number; readonly theme: Theme }): React.JSX.Element {
  const numbered = isScreenReaderMode();
  const options = [
    { title: "Free public models", description: "No account, API key or billing setup required", badge: "recommended" },
    { title: "Zen API key", description: "Use account models, limits and billing", badge: "advanced" },
  ];
  return <Box flexDirection="column">
    <SectionTitle title={`Connect ${selected?.displayName ?? "provider"}`} detail="choose how AlfaCode should authenticate" theme={theme} />
    {options.map((option, index) => <Box key={option.title} flexDirection="column" borderStyle="round" borderColor={cursor === index ? theme.accent : theme.border} paddingX={2} paddingY={1} marginBottom={1}>
      <Box justifyContent="space-between"><Text bold color={cursor === index ? theme.accent : theme.text}>{cursor === index ? "◆ " : "◇ "}{numbered ? numberedLabel(index, option.title) : option.title}</Text><Text color={index === 0 ? theme.success : theme.muted}>{option.badge}</Text></Box>
      <Text color={theme.muted}>{option.description}</Text>
    </Box>)}
    <HintBar theme={theme}>{numbered ? "type 1 or 2 · " : ""}↑↓ choose · enter continue · esc back</HintBar>
  </Box>;
}

function Prompt({ title, description, editor, masked, theme, environmentVariables }: { readonly title: string; readonly description: string; readonly editor: EditorState; readonly masked: boolean; readonly theme: Theme; readonly environmentVariables?: readonly string[] }): React.JSX.Element {
  const shown = masked ? { before: "•".repeat(Math.min(editor.cursor, 48)), cursor: editor.value.length === 0 ? " " : "•", after: "•".repeat(Math.min(Math.max(0, editor.value.length - editor.cursor - 1), 48)) } : splitAtCursor(editor);
  return <Box flexDirection="column">
    <Text bold color={theme.text}>{title}</Text>
    <Text color={theme.muted}>{description}</Text>
    <Box borderStyle="round" borderColor={theme.accent} paddingX={1} minHeight={3} marginTop={1}><Text color={theme.text}>{shown.before}</Text><Text inverse color={theme.text}>{shown.cursor}</Text><Text color={theme.text}>{shown.after}</Text>{editor.value.length === 0 ? <Text color={theme.faint}>{masked ? " Paste your API key here" : " Enter the endpoint URL"}</Text> : null}</Box>
    <Box marginTop={1} flexDirection="column">
      {masked ? <Text color={theme.success}>◆ Will be stored in the system credential vault; never written to config or sent to the chat.</Text> : null}
      {environmentVariables === undefined || environmentVariables.length === 0 ? null : <Text color={theme.faint}>Provider variable: {environmentVariables.join(" or ")}</Text>}
      <Text color={theme.faint}>enter confirm · ←→ edit · ctrl+u clear · esc back</Text>
    </Box>
  </Box>;
}

function SearchBox({ editor, placeholder, theme }: { readonly editor: EditorState; readonly placeholder: string; readonly theme: Theme }): React.JSX.Element {
  const split = splitAtCursor(editor);
  return <Box borderStyle="round" borderColor={theme.border} paddingX={1}><Text color={theme.accent}>⌕ </Text>{editor.value.length === 0 ? <Text><Text inverse> </Text><Text color={theme.faint}>{placeholder}</Text></Text> : <Text><Text>{split.before}</Text><Text inverse>{split.cursor}</Text><Text>{split.after}</Text></Text>}</Box>;
}

function Connecting({ selected, theme }: { readonly selected: ProviderDescriptor | undefined; readonly theme: Theme }): React.JSX.Element {
  return <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}><LoadingLabel theme={theme}>Connecting {selected?.displayName}…</LoadingLabel><Text color={theme.muted}>Discovering live models and verifying tool support</Text><Text color={theme.faint}>This may take a few seconds</Text></Box>;
}

function ConnectionError({ message, theme }: { readonly message: string | undefined; readonly theme: Theme }): React.JSX.Element {
  return <Box flexDirection="column" borderStyle="double" borderColor={theme.danger} paddingX={2} paddingY={1}><Text bold color={theme.danger}>Connection failed</Text><Text color={theme.text}>{message ?? "The provider did not return a usable response."}</Text><Box marginTop={1}><Text color={theme.faint}>enter retry · esc choose another provider</Text></Box></Box>;
}

function StepRail({ stage, theme }: { readonly stage: Stage; readonly theme: Theme }): React.JSX.Element {
  const active = stage === "provider" ? 0 : stage === "connecting" || stage === "error" ? 2 : 1;
  const labels = ["Provider", "Credentials", "Verify"];
  return <Box marginBottom={1}>{labels.map((label, index) => <React.Fragment key={label}><Text bold={index === active} color={index < active ? theme.success : index === active ? theme.accent : theme.faint}>{index < active ? "✓" : index === active ? "◆" : "◇"} {label}</Text>{index < labels.length - 1 ? <Text color={theme.border}> ─── </Text> : null}</React.Fragment>)}</Box>;
}

function applyEditorKey(input: string, key: Key, setter: React.Dispatch<React.SetStateAction<EditorState>>): boolean {
  let operation: EditorOperation | undefined;
  if (key.leftArrow) operation = { type: "left" };
  else if (key.rightArrow) operation = { type: "right" };
  else if (key.home || (key.ctrl && input === "a")) operation = { type: "home" };
  else if (key.end || (key.ctrl && input === "e")) operation = { type: "end" };
  else if (key.ctrl && input === "u") operation = { type: "delete-to-start" };
  else if (key.ctrl && input === "k") operation = { type: "delete-to-end" };
  else if (key.ctrl && input === "w") operation = { type: "delete-word" };
  else if (key.backspace) operation = { type: "backspace" };
  else if (key.delete) operation = { type: "delete" };
  else if (!key.ctrl && !key.meta && !key.return && input.length > 0) operation = { type: "insert", text: sanitizeTerminalText(input).replace(/\r?\n/gu, "") };
  if (operation === undefined) return false;
  setter((current) => editInput(current, operation));
  return true;
}
