import React, { useMemo, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import type { ProviderDescriptor } from "./provider-descriptors.js";

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

const colors = { accent: "cyan", muted: "gray", success: "green", danger: "red", selected: "magenta" } as const;

export async function runProviderSetup(options: ProviderSetupOptions): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Provider setup requires an interactive terminal");
  const instance = render(<ProviderSetup {...options} />, { exitOnCtrlC: false, patchConsole: false });
  await instance.waitUntilExit();
}

function ProviderSetup({ descriptors, notice, connect }: ProviderSetupOptions): React.JSX.Element {
  const { exit } = useApp();
  const [stage, setStage] = useState<Stage>("provider");
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [authCursor, setAuthCursor] = useState(0);
  const [selected, setSelected] = useState<ProviderDescriptor>();
  const [baseUrl, setBaseUrl] = useState<string>();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string>();
  const [retryStage, setRetryStage] = useState<"auth" | "api-key">("api-key");
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle.length === 0 ? descriptors : descriptors.filter((item) => `${item.displayName} ${item.description} ${item.id}`.toLowerCase().includes(needle));
  }, [descriptors, query]);
  const visible = filtered.slice(Math.max(0, Math.min(cursor - 3, filtered.length - 7)), Math.max(0, Math.min(cursor - 3, filtered.length - 7)) + 7);

  useInput((input, key) => {
    if (key.ctrl && input === "c") { exit(new Error("Setup cancelled")); return; }
    if (stage === "connecting") return;
    if (stage === "error") {
      if (key.return) { setError(undefined); setValue(""); setStage(retryStage); }
      return;
    }
    if (stage === "provider") {
      if (key.upArrow) { setCursor((current) => Math.max(0, current - 1)); return; }
      if (key.downArrow) { setCursor((current) => Math.min(filtered.length - 1, current + 1)); return; }
      if (key.backspace || key.delete) { setQuery((current) => current.slice(0, -1)); setCursor(0); return; }
      if (key.return) {
        const descriptor = filtered[cursor];
        if (descriptor === undefined) return;
        setSelected(descriptor); setBaseUrl(undefined); setValue(descriptor.suggestedBaseUrl ?? "");
        setStage(descriptor.allowsAnonymous ? "auth" : descriptor.requiresBaseUrl ? "base-url" : "api-key");
        return;
      }
      if (!key.ctrl && !key.meta && input.length > 0) { setQuery((current) => current + input); setCursor(0); }
      return;
    }
    if (stage === "auth") {
      if (key.upArrow || key.downArrow) { setAuthCursor((current) => current === 0 ? 1 : 0); return; }
      if (key.escape) { setSelected(undefined); setStage("provider"); return; }
      if (key.return && selected !== undefined) {
        if (authCursor === 1) { setValue(""); setStage("api-key"); return; }
        setStage("connecting");
        setRetryStage("auth");
        void connect({ descriptor: selected })
          .then(() => exit())
          .catch((cause: unknown) => { setError(cause instanceof Error ? cause.message : String(cause)); setStage("error"); });
      }
      return;
    }
    if (key.escape) { setValue(""); setSelected(undefined); setStage("provider"); return; }
    if (key.backspace || key.delete) { setValue((current) => current.slice(0, -1)); return; }
    if (key.return) {
      if (value.trim().length === 0 || selected === undefined) return;
      if (stage === "base-url") { setBaseUrl(value.trim()); setValue(""); setStage("api-key"); return; }
      const apiKey = value.trim();
      setStage("connecting"); setValue("");
      setRetryStage("api-key");
      void connect({ descriptor: selected, apiKey, ...(baseUrl === undefined ? {} : { baseUrl }) })
        .then(() => exit())
        .catch((cause: unknown) => { setError(cause instanceof Error ? cause.message : String(cause)); setStage("error"); });
      return;
    }
    if (!key.ctrl && !key.meta && input.length > 0) setValue((current) => current + input);
  });

  return <Box flexDirection="column" paddingX={1}>
    <Box marginBottom={1}><Text bold color={colors.accent}>◆ AlfaCode</Text><Text color={colors.muted}>  Connect a provider</Text></Box>
    {notice === undefined ? null : <Box marginBottom={1}><Text color="yellow">{notice}</Text></Box>}
    {stage === "provider" ? <>
      <Text>Provider search  <Text color={colors.accent}>{query || "type to filter"}</Text></Text>
      <Box flexDirection="column" marginTop={1}>
        {visible.map((item) => {
          const active = filtered[cursor]?.id === item.id;
          return <Text key={item.id} {...(active ? { color: colors.selected } : {})}>{active ? "❯ " : "  "}<Text bold={active}>{item.displayName}</Text><Text color={colors.muted}>  {item.description}</Text></Text>;
        })}
      </Box>
      <Box marginTop={1}><Text color={colors.muted}>↑↓ navigate · enter select · ctrl+c cancel</Text></Box>
    </> : null}
    {stage === "auth" ? <Box flexDirection="column">
      <Text bold>How do you want to use {selected?.displayName}?</Text>
      <Text {...(authCursor === 0 ? { color: colors.selected } : {})}> {authCursor === 0 ? "❯" : " "} Free public models <Text color={colors.muted}>no account or API key</Text></Text>
      <Text {...(authCursor === 1 ? { color: colors.selected } : {})}> {authCursor === 1 ? "❯" : " "} Zen API key <Text color={colors.muted}>account models and billing limits</Text></Text>
    </Box> : null}
    {stage === "base-url" ? <Prompt title={`${selected?.displayName ?? "Provider"} base URL`} value={value} masked={false} /> : null}
    {stage === "api-key" ? <Prompt title={`Enter your ${selected?.displayName ?? "provider"} API key`} value={value} masked /> : null}
    {stage === "connecting" ? <Text color={colors.accent}>Connecting {selected?.displayName} and verifying available models…</Text> : null}
    {stage === "error" ? <><Text color={colors.danger}>Connection failed: {error}</Text><Text color={colors.muted}>Press enter to retry this connection method.</Text></> : null}
  </Box>;
}

function Prompt({ title, value, masked }: { readonly title: string; readonly value: string; readonly masked: boolean }): React.JSX.Element {
  const shown = masked ? "•".repeat(Math.min(value.length, 48)) : value;
  return <Box flexDirection="column">
    <Text bold>{title}</Text>
    <Box borderStyle="round" borderColor={colors.accent} paddingX={1}><Text>{shown}</Text><Text color={colors.accent}>▌</Text></Box>
    <Text color={colors.muted}>{masked ? "Stored in the system credential vault · never sent to the conversation" : "enter confirm · esc back"}</Text>
  </Box>;
}
