# Thin Launcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace AlfaCode's Ink/React TUI + embedded `@anthropic-ai/claude-agent-sdk` engine with a thin launcher that starts the existing gateway and spawns the real `claude` CLI interactively, so the actual Claude Code TUI is what the user sees, with Ollama (local + cloud) and OpenCode Zen (real account) reachable through it.

**Architecture:** `alfacode` becomes a config/gateway manager plus one spawn call: it merges configured providers (plus an auto-detected local Ollama), starts the existing loopback gateway, and execs the real `claude` binary with `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`/`CLAUDE_CONFIG_DIR` pointed at it. No embedded engine, no custom rendering.

**Tech Stack:** TypeScript, Node 24, Fastify (gateway, unchanged), commander (CLI), vitest, `@napi-rs/keyring` (Keychain, unchanged).

**Spec:** `docs/superpowers/specs/2026-09-10-thin-launcher-design.md`

## Global Constraints

- No AI co-author trailer in any commit message on this repo (Andrea's standing rule).
- Never write real API keys or secrets to disk outside macOS Keychain / env var references (`config.ts`/`secrets.ts` conventions, unchanged).
- Every task must leave `pnpm typecheck` and `pnpm test` passing before its commit.
- Work happens on branch `feat/thin-launcher`; PR against `main` only after Task 5.

## Corrections found while mapping files (spec assumed less than the code actually does)

The approved spec listed some files as "kept unmodified" or "removed" based on filenames/README claims. Reading the full source turned up three corrections, applied below instead of re-opening brainstorming (implementation detail, not architecture):

1. **`terminal-ui.ts` is NOT Ink-based** — it's a plain `node:readline/promises` wrapper (`write`/`ask`/`select`). It stays, unmodified. The spec's "removed" list was wrong about it.
2. **`engine-compatibility.ts` is SDK-embedding-specific** (pins `PINNED_CLAUDE_CODE_VERSION` against what the embedded Agent SDK reports) — meaningless once nothing embeds the SDK. Added to the removal list (was mistakenly listed as kept).
3. **`gateway.ts` needs a small trim, not zero changes** — its retry/fallback loop and `usageLedger`/`onProviderOutcome`/`selectFallback` options exist solely to serve the `AutomaticModelSelector`'s failover feature the approved spec already dropped. Removing dead code your own approved design orphaned isn't "unrelated refactoring" — it's finishing the removal. Scoped into Task 3 below.
4. **No new `launcher.ts` file, no new `providers add/list/remove` commands** — the spec assumed the CLI had no way to configure providers without the Ink wizard. It already does: `alfacode connect <type> --keychain|--api-key-env` and `alfacode providers list|remove` are existing, non-Ink commands. Task 1 only needs to delete the Ink-only fallback branches inside `connect`/`classicLaunch`, not build new commands. This makes the actual diff smaller than the spec implied, in the plan's favor.

---

### Task 1: Remove the Ink/SDK chat engine, promote the raw launcher to the default action

**Files:**
- Delete: `src/chat-tui.tsx`, `src/setup-tui.tsx`, `src/agent-session.ts`, `src/notifications.ts`, `src/session-history.ts`, `src/transcript-export.ts`, `src/spellcheck.ts`, `src/engine-compatibility.ts`
- Delete: `src/ui/background-tasks-panel.tsx`, `src/ui/clipboard-copy.ts`, `src/ui/clipboard-image.ts`, `src/ui/dropped-paths.ts`, `src/ui/input-editor.ts`, `src/ui/markdown.tsx`, `src/ui/mentions.ts`, `src/ui/motion.ts`, `src/ui/mouse-select.ts`, `src/ui/primitives.tsx`, `src/ui/screen-reader-mode.ts`, `src/ui/screen-reader-transcript.tsx`, `src/ui/status-bar.tsx`, `src/ui/theme.ts`, `src/ui/todo-panel.tsx`, `src/ui/tool-output.ts`, `src/ui/vim-mode.ts`
- Delete tests: `test/chat-tui.test.ts`, `test/chat-tui-header.test.tsx`, `test/chat-tui-resize.test.tsx`, `test/chat-tui-subagent-focus.test.tsx`, `test/setup-tui.test.tsx`, `test/agent-session.test.ts`, `test/notifications.test.ts`, `test/session-history.test.ts`, `test/transcript-export.test.ts`, `test/spellcheck.test.ts`, `test/engine-compatibility.test.ts`, `test/background-tasks-panel.test.tsx`, `test/clipboard-copy.test.ts`, `test/clipboard-image.test.ts`, `test/dropped-paths.test.ts`, `test/input-editor.test.ts`, `test/markdown.test.tsx`, `test/mentions.test.ts`, `test/motion.test.tsx`, `test/mouse-select.test.ts`, `test/primitives.test.tsx`, `test/screen-reader-mode.test.ts`, `test/screen-reader-transcript.test.tsx`, `test/status-bar.test.tsx`, `test/todo-panel.test.tsx`, `test/tool-output.test.ts`, `test/vim-mode.test.ts`, `test/model-picker.test.tsx`
- Modify: `src/cli.ts`
- Modify: `test/cli.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `createCli(options: CreateCliOptions): Command` keeps its export shape, but `CreateCliOptions` drops `providerSetup`, `startAgentSession`, `chatTui`, `sessionsBackend`. The root `program` action becomes the function formerly named `classicLaunch` (kept name: `launch`).

- [ ] **Step 1: Delete the dead files**

```bash
git rm src/chat-tui.tsx src/setup-tui.tsx src/agent-session.ts src/notifications.ts \
  src/session-history.ts src/transcript-export.ts src/spellcheck.ts src/engine-compatibility.ts
git rm -r src/ui
git rm test/chat-tui.test.ts test/chat-tui-header.test.tsx test/chat-tui-resize.test.tsx \
  test/chat-tui-subagent-focus.test.tsx test/setup-tui.test.tsx test/agent-session.test.ts \
  test/notifications.test.ts test/session-history.test.ts test/transcript-export.test.ts \
  test/spellcheck.test.ts test/engine-compatibility.test.ts test/background-tasks-panel.test.tsx \
  test/clipboard-copy.test.ts test/clipboard-image.test.ts test/dropped-paths.test.ts \
  test/input-editor.test.ts test/markdown.test.tsx test/mentions.test.ts test/motion.test.tsx \
  test/mouse-select.test.ts test/primitives.test.tsx test/screen-reader-mode.test.ts \
  test/screen-reader-transcript.test.tsx test/status-bar.test.tsx test/todo-panel.test.tsx \
  test/tool-output.test.ts test/vim-mode.test.ts test/model-picker.test.tsx
```

- [ ] **Step 2: Confirm the expected breakage**

Run: `pnpm typecheck`
Expected: FAILS, only in `src/cli.ts` — errors about missing modules `./chat-tui.js`, `./agent-session.js`, `./setup-tui.js`, `./session-history.js`, `./engine-compatibility.js`. If any other file errors, stop and re-check the deletion list above before continuing.

- [ ] **Step 3: Rewrite `src/cli.ts`**

Remove these imports (lines 8, 16-21 in the current file):
```ts
import { createTerminalUi, requireInteractive, type TerminalUi } from "./terminal-ui.js";
```
stays — only remove the ones below it:
```ts
import { runProviderSetup, type ProviderSetupOptions, type ProviderSetupResult } from "./setup-tui.js";
import { AgentSession, type AgentSessionIdentity } from "./agent-session.js";
import { PermissionBroker } from "./permission-broker.js";
import { runChatTui, type ChatAction } from "./chat-tui.js";
import { pendingEngineCompatibility } from "./engine-compatibility.js";
import { describeSessionPickerEntry, listRecentSessions, resolveResumeTarget, type SessionPickerEntry, type SessionsBackend } from "./session-history.js";
```

Remove `NativeLaunchFlags` interface (it's only used by the deleted flow).

In `CreateCliOptions`, remove:
```ts
  readonly providerSetup?: (options: ProviderSetupOptions) => Promise<void>;
  readonly startAgentSession?: typeof AgentSession.start;
  readonly chatTui?: typeof runChatTui;
  readonly sessionsBackend?: SessionsBackend;
```

Remove the entire `saveTuiProvider` function and `connectFromTui` (both exist only to feed the Ink wizard's verify-then-save flow).

Replace the `connect` command's action — currently:
```ts
    .action(async (type: string | undefined, flags: ConnectFlags) => {
      if (flags.apiKeyEnv === undefined && flags.baseUrl === undefined && !flags.keychain && flags.id === undefined) {
        const choices = type === undefined ? descriptors : descriptors.filter((item) => item.id === type);
        if (choices.length === 0) throw new Error(`Unsupported provider type: ${type}`);
        await (options.providerSetup ?? runProviderSetup)({ descriptors: choices, connect: (result) => saveTuiProvider(result, undefined, true) });
        return;
      }
      const selectedType = type ?? (ui.interactive ? await ui.select("Choose a provider", descriptors.map(toChoice)) : undefined);
      if (selectedType === undefined) throw new Error("Specify a provider type in a non-interactive terminal");
      await connect(selectedType, flags);
    });
```
with:
```ts
    .action(async (type: string | undefined, flags: ConnectFlags) => {
      const selectedType = type ?? (ui.interactive ? await ui.select("Choose a provider", descriptors.map(toChoice)) : undefined);
      if (selectedType === undefined) throw new Error("Specify a provider type in a non-interactive terminal");
      await connect(selectedType, flags);
    });
```
(`connect()` already prompts through the OS Keychain via `ui.interactive`/`requireInteractive` when no `--api-key-env` is given — no wizard needed.)

Remove the `nativeLaunch` function entirely (from `const nativeLaunch = async (args...` through its closing `};`), and remove these now-orphaned helpers used only by it: `resolveResumeFlag`, `sessionsConfigDir`, `toSessionChoice`, `parseResumeFlag`, `parseContinueFlag`, `parseNameFlag`.

Change the root command registration — currently:
```ts
  const program = new Command();
  program.name("alfacode").description("Run the AlfaCode terminal agent on the Claude Code engine").argument("[args...]", "Native session options").allowUnknownOption(true)
    .option("--fullscreen", "Render the chat UI on the terminal's alternate screen buffer, with a fixed-bottom composer", true)
    .option("--no-fullscreen", "Render inline using the terminal's native scrollback instead of the alternate screen buffer")
    .option("--screen-reader", "Render a plain, linear, screen-reader-friendly UI (same as ALFACODE_SCREEN_READER=1)")
    .action(nativeLaunch);
```
to:
```ts
  const program = new Command();
  program.name("alfacode").description("Run the real Claude Code TUI with extra models available through the gateway").argument("[args...]", "Arguments passed through to claude").allowUnknownOption(true)
    .action(classicLaunch);
```

In `classicLaunch`, remove only the wizard-fallback `if` block — currently:
```ts
    let config = await bootstrapDefaultProvider(await loadConfig());
    const unavailable = await selectedCredentialUnavailable(config, keychain);
    if (config.providers.length === 0 || unavailable !== undefined) {
      requireInteractive(ui.interactive);
      await (options.providerSetup ?? runProviderSetup)({
        descriptors,
        ...(unavailable === undefined ? {} : { notice: `The saved provider '${unavailable}' has no credential. Reconnect it to continue.` }),
        connect: connectFromTui,
      });
      config = await loadConfig();
    }
```
becomes just:
```ts
    const config = await bootstrapDefaultProvider(await loadConfig());
```
Leave the rest of `classicLaunch` (the `selectedProvider`/`runtimeStarter`/launch-options block below it) untouched for this task — `selectedProvider(config)` already throws a clear `"No provider is selected. Run: alfacode connect google"` error when `config.providers` is empty, which is good enough for this step's compile-and-behave bar. Task 2 replaces this zero-provider case with the friendlier passthrough, and also removes `selectedCredentialUnavailable` entirely (it is unused after this edit — its only other caller, `nativeLaunch`, is deleted above — but leave the unused function in place for this task; deleting it here would be an unrelated cleanup mixed into an already-large diff, and Task 2 removes it as part of its own, closely-related edit).

Also remove the now-dead `program.command("run", ...)` (it only exists to wrap `classicLaunch` with a `--non-interactive` flag that duplicated the wizard-avoidance logic above — `alfacode` and `alfacode launch` now behave identically to it) and the `program.command("launch", ...)` registration's separate description (keep `launch` as an explicit alias of the default action, same handler):
```ts
  program.command("launch [args...]").description("Same as running alfacode with no subcommand").allowUnknownOption(true).action(classicLaunch);
```

Remove `run [args...]` command entirely.

- [ ] **Step 4: Update `test/cli.test.ts`**

Remove: the `fakeSessionsBackend` helper, its `SessionsBackend` import, and every test that invokes `alfacode` (bare), `sessions`, `--fullscreen`, `--screen-reader`, or passes `chatTui`/`startAgentSession`/`sessionsBackend`/`providerSetup` (except tests of `connect`/`providers` that don't touch the removed wizard branch — keep those, just delete the `providerSetup` option from their `createCli(...)` calls if present. The test "rejects an unsafe optional base URL from native setup before storing credentials" (line 60-83) exercised the wizard directly — delete it; base-URL validation is still covered by `connect`'s own `isHttpUrl` check, add one line to any remaining `connect --base-url` test if none currently covers an unsafe URL, e.g.:

```ts
  it("rejects an unsafe base URL passed to connect", async () => {
    const home = await mkdtemp(join(tmpdir(), "alfacode-cli-base-url-"));
    directories.push(home);
    const cli = createCli({ configStore: new ConfigStore({ homeDirectory: home }), ui: fakeUi() });
    await expect(cli.parseAsync(
      ["node", "alfacode", "connect", "openai-compatible", "--base-url", "http://attacker.example/v1", "--api-key-env", "TEST_KEY"],
      { from: "node" },
    )).rejects.toThrow("absolute HTTPS URL");
  });
```

Delete the "treats an unexpected Keychain retrieval failure..." test (originally lines 85-123) — it asserted the old wizard-triggering behavior (`selectedCredentialUnavailable` throwing a "has no credential" notice), which this task's `classicLaunch` no longer performs: a broken credential now surfaces as a warning from `startRuntime` instead (that path already exists, unchanged, in `runtime.ts`'s per-provider try/catch). Replace it with a test of the warning being printed:

```ts
  it("prints runtime warnings without failing the launch", async () => {
    const home = await mkdtemp(join(tmpdir(), "alfacode-cli-warn-"));
    directories.push(home);
    const configStore = new ConfigStore({ homeDirectory: home });
    await configStore.write({ version: 1, defaultProviderId: "google", providers: [{ id: "google", type: "google", apiKey: { kind: "keychain", service: "alfacode", account: "google" } }] });
    const written: string[] = [];
    const cli = createCli({
      configStore,
      keychain: { store: async () => undefined },
      startRuntime: async () => ({ baseUrl: "http://gateway", authToken: "token", modelCandidates: [], warnings: ["Provider 'google' unavailable: Keychain is locked"], close: async () => undefined }),
      launch: async () => 0,
      ui: fakeUi({ write: (message) => { written.push(message); } }),
    });

    await cli.parseAsync(["node", "alfacode", "launch"], { from: "node" });
    expect(written).toContain("Warning: Provider 'google' unavailable: Keychain is locked");
  });
```

Add a test confirming the bare (no-subcommand) action now behaves like `launch`:

```ts
  it("runs the launch flow when invoked with no subcommand", async () => {
    const home = await mkdtemp(join(tmpdir(), "alfacode-cli-bare-"));
    directories.push(home);
    const configStore = new ConfigStore({ homeDirectory: home });
    await configStore.write({ version: 1, defaultProviderId: "google", providers: [{ id: "google", type: "google", apiKey: { kind: "keychain", service: "alfacode", account: "google" } }] });
    const launched: unknown[] = [];
    const cli = createCli({
      configStore,
      keychain: { store: async () => undefined, retrieve: async () => "secret" },
      startRuntime: async () => ({ baseUrl: "http://gateway", authToken: "token", modelCandidates: [], close: async () => undefined }),
      launch: async (launchOptions) => { launched.push(launchOptions); return 0; },
      ui: fakeUi(),
    });

    await cli.parseAsync(["node", "alfacode", "--", "--print", "hi"], { from: "node" });
    expect(launched).toHaveLength(1);
  });
```

- [ ] **Step 5: Prune `package.json`**

Remove from `dependencies`: `"@anthropic-ai/claude-agent-sdk"`, `"ink"`, `"marked"`, `"react"`. Remove from `devDependencies`: `"@types/react"`, `"ink-testing-library"`. Then:

```bash
pnpm install
```

- [ ] **Step 6: Verify**

Run: `pnpm typecheck && pnpm test`
Expected: both PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor: remove the embedded Ink/SDK chat engine

alfacode now spawns the real claude binary instead of rendering its
own chat UI on top of the embedded Agent SDK. The raw launcher path
(previously "alfacode launch") is the only mode left, and is now the
default action.
EOF
)"
```

---

### Task 2: Zero-config passthrough when no provider is available

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/claude-launcher.ts`
- Test: `test/cli.test.ts`
- Test: `test/claude-launcher.test.ts`

**Interfaces:**
- Consumes: `ClaudeLaunchOptions` from Task 1 (unchanged fields: `claudeArgs`, `baseUrl`, `authToken`, `configDir`, `extraEnv`, `scrubEnvironmentKeys`).
- Produces: `buildClaudeEnvironment` always sets `CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1"` in `safeClaudeDefaults` (every gateway-routed model is, by definition, unknown to Claude's built-in catalog).

- [ ] **Step 1: Write the failing test for the env default**

In `test/claude-launcher.test.ts`, add:
```ts
  it("always disables unknown-model window enforcement, since every gateway model is unknown to claude's built-in catalog", () => {
    const environment = buildClaudeEnvironment({ claudeArgs: [], baseUrl: "http://127.0.0.1:1", authToken: "token" });
    expect(environment.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT).toBe("1");
  });
```
(Check the top of the file for the existing `buildClaudeEnvironment` import — reuse it.)

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm vitest run test/claude-launcher.test.ts -t "disables unknown-model"`
Expected: FAIL — `environment.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT` is `undefined`.

- [ ] **Step 3: Add the default**

In `src/claude-launcher.ts`, add one line to `safeClaudeDefaults`:
```ts
const safeClaudeDefaults: Readonly<Record<string, string>> = {
  CLAUDE_CODE_DISABLE_ARTIFACT: "1",
  CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  DISABLE_FEEDBACK_COMMAND: "1",
  CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
  CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "0",
  CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
  CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
};
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `pnpm vitest run test/claude-launcher.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Write the failing test for zero-provider passthrough**

In `test/cli.test.ts`, add:
```ts
  it("skips the gateway entirely and launches plain claude when no provider is available", async () => {
    const home = await mkdtemp(join(tmpdir(), "alfacode-cli-no-provider-"));
    directories.push(home);
    const configStore = new ConfigStore({ homeDirectory: home });
    let startRuntimeCalls = 0;
    const launched: unknown[] = [];
    const cli = createCli({
      configStore,
      keychain: { store: async () => undefined },
      startRuntime: async () => { startRuntimeCalls += 1; return { baseUrl: "http://gateway", authToken: "token", modelCandidates: [], close: async () => undefined }; },
      launch: async (options) => { launched.push(options); return 0; },
      ui: fakeUi(),
    });

    await cli.parseAsync(["node", "alfacode", "--", "--print", "hi"], { from: "node" });
    expect(startRuntimeCalls).toBe(0);
    expect(launched).toEqual([{ claudeArgs: ["--print", "hi"], baseUrl: "", authToken: "" }]);
  });
```

- [ ] **Step 6: Run it to confirm it fails**

Run: `pnpm vitest run test/cli.test.ts -t "skips the gateway"`
Expected: FAIL — `bootstrapDefaultProvider` seeds an anonymous Zen provider on a fresh config directory, so `startRuntimeCalls` is 1, not 0.

- [ ] **Step 7: Implement the passthrough**

In `src/cli.ts`, remove the `bootstrapDefaultProvider` call and function entirely (it existed to auto-seed anonymous Zen, which is dead per the design spec — Zen's anonymous tier no longer works), and remove `selectedCredentialUnavailable` entirely too (unused since Task 1's edit — a broken credential is now just a warning from `startRuntime`, never a pre-flight block). Change `classicLaunch` to:
```ts
  const classicLaunch = async (args: readonly string[]): Promise<void> => {
    const config = await loadConfig();
    if (config.providers.length === 0) {
      process.exitCode = await (options.launch ?? launchClaude)({ claudeArgs: args, baseUrl: "", authToken: "" });
      return;
    }
    if (runtimeStarter === undefined) throw new Error("Gateway runtime is not configured yet");
    const provider = await selectedProvider(config);
    const runtime = await runtimeStarter({ provider, config });
    try {
      for (const warning of runtime.warnings ?? []) ui.write(`Warning: ${warning}`);
      const launchOptions: ClaudeLaunchOptions = {
        claudeArgs: args,
        baseUrl: runtime.baseUrl,
        authToken: runtime.authToken,
        ...(runtime.defaultModelId === undefined ? {} : { defaultModelId: runtime.defaultModelId }),
        ...(runtime.contextWindowTokens === undefined ? {} : { contextWindowTokens: runtime.contextWindowTokens }),
        ...(runtime.secretEnvironmentNames === undefined ? {} : { scrubEnvironmentKeys: runtime.secretEnvironmentNames }),
      };
      process.exitCode = await (options.launch ?? launchClaude)(launchOptions);
    } finally {
      await runtime.close();
    }
  };
```
(`provider`/`selectedProvider` and the `defaultModelId`/`contextWindowTokens` fields are still valid here — `runtime.ts`'s trim happens in Task 3, not this one; Task 3 updates this function again to drop them once `StartRuntimeInput` changes shape.)

Also remove every other call site of `bootstrapDefaultProvider` (the `doctor` command uses it too — replace `const config = await bootstrapDefaultProvider(await loadConfig());` there with `const config = await loadConfig();`), and remove the now-unused `defaultZenProvider` function and its `descriptors.find((item) => item.allowsAnonymous === true)` logic, plus the `allowsAnonymous` field on `ProviderDescriptor` in `src/provider-descriptors.ts` and its one usage on the `zen` entry (leave `zen`'s other fields as-is).

Update `ClaudeLaunchOptions.baseUrl`/`authToken` to accept an empty string as the "no gateway, real Anthropic" sentinel — in `src/claude-launcher.ts`'s `buildClaudeEnvironment`, only set `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` when non-empty:
```ts
  Object.assign(environment, safeClaudeDefaults, options.extraEnv);
  for (const key of Object.keys(environment)) { /* unchanged scrub loop */ }
  if (options.baseUrl.length > 0) environment.ANTHROPIC_BASE_URL = options.baseUrl;
  if (options.authToken.length > 0) environment.ANTHROPIC_AUTH_TOKEN = options.authToken;
  environment.CLAUDE_CONFIG_DIR = options.configDir ?? join(homedir(), ".alfacode", "claude");
  environment.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = "1";
```
(replacing the current unconditional `ANTHROPIC_BASE_URL: options.baseUrl, ANTHROPIC_AUTH_TOKEN: options.authToken` assignment inside the `Object.assign(environment, { ... })` block — keep `CLAUDE_CONFIG_DIR` and `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` unconditional, they're harmless with no gateway running since claude just won't discover anything extra).

- [ ] **Step 8: Run it to confirm it passes**

Run: `pnpm vitest run test/cli.test.ts test/claude-launcher.test.ts`
Expected: PASS. Also re-run `pnpm test` in full — the deleted `bootstrapDefaultProvider` behavior may be covered by an existing test named around "seeds the anonymous Zen provider on a genuinely fresh install" (`test/cli.test.ts:327` per the current file) — delete that test, it verifies behavior this task intentionally removes.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat: launch plain claude when no provider is configured

A bare alfacode install with zero configured providers (and no
reachable Ollama, added in a later task) now behaves identically to
running claude directly, instead of forcing a setup step. Also drops
the dead anonymous-Zen auto-seed, since Zen's anonymous tier no
longer works.
EOF
)"
```

---

### Task 3: Trim automatic model selection and the usage ledger

**Files:**
- Delete: `src/model-selection.ts`, `src/model-selection-state.ts`, `src/usage-ledger.ts`
- Delete tests: `test/model-selection.test.ts`, `test/usage-ledger.test.ts`
- Modify: `src/runtime.ts`
- Modify: `src/gateway.ts`
- Modify: `src/cli.ts`
- Test: `test/providers/runtime-factory.test.ts`
- Test: `test/gateway.test.ts`

**Interfaces:**
- Produces: `startRuntime(input: { config: AlfaCodeConfig }, dependencies?: RuntimeDependencies): Promise<RuntimeHandle>` — `provider` and `purpose` are gone from the input; `RuntimeHandle` drops `defaultModelId` and `contextWindowTokens`.
- Produces: `createGatewayServer(options: { token: string; providers: readonly Provider[]; pingIntervalMs?: number }): FastifyInstance` — `usageLedger`, `onProviderOutcome`, `selectFallback` removed from `GatewayOptions`.

- [ ] **Step 1: Update `test/providers/runtime-factory.test.ts` first**

Delete the last test in the file (`"sets Claude's context from the automatically selected model, never the smallest catalog entry"`, lines 77-94) and its now-unused `AutomaticModelSelector` import. Replace it with:
```ts
  it("merges every configured provider's candidates and reports per-provider warnings, without picking a default", async () => {
    const home = await mkdtemp(join(tmpdir(), "alfacode-runtime-"));
    const fake = () => ({
      async listModels() { return [{ id: "selected", displayName: "Selected", contextWindow: 1_000_000 }]; },
      async countTokens() { return 1; }, async *stream() {}, async close() {},
    });
    const metadata = { async resolve() { return { capabilities: { streaming: true, tools: true, parallelTools: true, forcedToolChoice: true, vision: false, reasoningState: "none" as const, nativeTokenCounting: true, jsonSchema: "subset" as const } }; } };
    const record: ProviderRecord = { id: "google", type: "google", apiKey: { kind: "env", name: "TEST_KEY" } };
    const runtime = await startRuntime({ config: { version: 1, providers: [record, { id: "broken", type: "catalog" }] } }, {
      homeDirectory: home, secrets: new SecretResolver({ environment: { TEST_KEY: "secret" } }), createGoogle: () => fake() as never, modelMetadata: metadata,
    });
    try {
      expect(runtime.modelCandidates.map((model) => model.id)).toEqual(["selected"]);
      expect(runtime.warnings).toEqual(["Provider 'broken' unavailable: no API key reference"]);
      expect(runtime).not.toHaveProperty("defaultModelId");
      expect(runtime).not.toHaveProperty("contextWindowTokens");
    } finally { await runtime.close(); await rm(home, { recursive: true, force: true }); }
  });
```
(Keep every other test in the file — they all call `createConfiguredProvider` directly and never touch the selector.)

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm vitest run test/providers/runtime-factory.test.ts`
Expected: FAIL — the current `startRuntime` still requires `input.provider` and throws when no model is "selected" for `purpose !== "discovery"`.

- [ ] **Step 3: Trim `src/runtime.ts`**

Remove imports: `import { UsageLedger } from "./usage-ledger.js";`, `import { AutomaticModelSelector, LedgerModelUsageHistory } from "./model-selection.js";`, `import { FileModelSelectionStateStore } from "./model-selection-state.js";`.

Change:
```ts
export interface RuntimeHandle {
  readonly baseUrl: string;
  readonly authToken: string;
  readonly defaultModelId?: string;
  readonly modelCandidates: readonly ModelDescriptor[];
  readonly contextWindowTokens?: number;
  readonly secretEnvironmentNames?: readonly string[];
  readonly warnings?: readonly string[];
  close(): Promise<void>;
}

export interface StartRuntimeInput {
  readonly provider: ProviderRecord;
  readonly config: AlfaCodeConfig;
  readonly purpose?: "launch" | "discovery";
}

export interface RuntimeDependencies {
  readonly secrets?: SecretResolver;
  readonly homeDirectory?: string;
  readonly createGoogle?: (options: ConstructorParameters<typeof GoogleProvider>[0]) => GoogleProvider;
  readonly usageLedger?: UsageLedger;
  readonly fetch?: typeof fetch;
  readonly modelMetadata?: DynamicModelMetadataResolver;
  readonly modelSelector?: AutomaticModelSelector;
}
```
to:
```ts
export interface RuntimeHandle {
  readonly baseUrl: string;
  readonly authToken: string;
  readonly modelCandidates: readonly ModelDescriptor[];
  readonly secretEnvironmentNames?: readonly string[];
  readonly warnings?: readonly string[];
  close(): Promise<void>;
}

export interface StartRuntimeInput {
  readonly config: AlfaCodeConfig;
}

export interface RuntimeDependencies {
  readonly secrets?: SecretResolver;
  readonly homeDirectory?: string;
  readonly createGoogle?: (options: ConstructorParameters<typeof GoogleProvider>[0]) => GoogleProvider;
  readonly fetch?: typeof fetch;
  readonly modelMetadata?: DynamicModelMetadataResolver;
}
```

Replace the body of `startRuntime` (from `export async function startRuntime` through its closing brace) with:
```ts
export async function startRuntime(input: StartRuntimeInput, dependencies: RuntimeDependencies = {}): Promise<RuntimeHandle> {
  const secrets = dependencies.secrets ?? new SecretResolver();
  const homeDirectory = dependencies.homeDirectory ?? homedir();
  const providers: Provider[] = [];

  try {
    const candidates: ModelDescriptor[] = [];
    const warnings: string[] = [];
    for (const record of input.config.providers) {
      try {
        const anonymousZen = (record.type === "opencode-zen" || record.type === "zen") && record.apiKey === undefined;
        const anonymousLocal = record.type === "ollama-local" && record.apiKey === undefined;
        if (record.apiKey === undefined && !anonymousZen && !anonymousLocal) throw new Error("no API key reference");
        const apiKey = anonymousZen ? "public" : anonymousLocal ? "ollama" : await secrets.resolve(record.apiKey!);
        if (apiKey === undefined || apiKey.length === 0) throw new Error("API key unavailable");
        const built = await createConfiguredProvider(record, apiKey, dependencies, homeDirectory);
        providers.push(built.provider);
        candidates.push(...built.descriptors);
      } catch (error: unknown) {
        warnings.push(`Provider '${record.id}' unavailable: ${redactProbeReason(error instanceof Error ? error.message : String(error))}`);
      }
    }

    const authToken = randomBytes(32).toString("base64url");
    const gateway = await listenLocalGateway({ token: authToken, providers });
    let closed = false;
    return {
      baseUrl: gateway.address,
      authToken,
      modelCandidates: candidates,
      ...(warnings.length === 0 ? {} : { warnings }),
      secretEnvironmentNames: input.config.providers.flatMap((record) => record.apiKey?.kind === "env" ? [record.apiKey.name] : []),
      close: async () => {
        if (closed) return;
        closed = true;
        await gateway.app.close();
      },
    };
  } catch (error) {
    await Promise.allSettled(providers.map(async (provider) => provider.close()));
    throw error;
  }
}
```
(This drops `pinnedModel`, `selectedModel`, `activeSelector`, the `ledger.registerModel` loop, and the selector-driven `onProviderOutcome`/`selectFallback` gateway options — `listenLocalGateway` now takes only `{ token, providers }`, matching Task 3 Step 5's trimmed `GatewayOptions`. Note the new `anonymousLocal` branch — added here now so Task 4 only needs to add the `createConfiguredProvider` case and the caller-side probe, not touch this loop again.)

- [ ] **Step 4: Run it to confirm the runtime-factory test passes**

Run: `pnpm vitest run test/providers/runtime-factory.test.ts`
Expected: still FAILS — `listenLocalGateway`/`gateway.ts` hasn't been trimmed yet, so `GatewayOptions` still requires nothing extra (it's optional today) but `runtime.ts` no longer imports the ledger, which is fine; the real remaining failure is `pnpm typecheck` on `gateway.ts` if it still references removed types indirectly — check with `pnpm typecheck` before re-running the test.

- [ ] **Step 5: Trim `src/gateway.ts`**

Remove the import `import { type AttemptOutcome, type UsageLedger } from "./usage-ledger.js";`.

Change:
```ts
export interface GatewayOptions {
  readonly token: string;
  readonly providers: readonly Provider[];
  readonly pingIntervalMs?: number;
  readonly usageLedger?: UsageLedger;
  readonly onProviderOutcome?: (outcome: { readonly providerId: string; readonly modelId: string; readonly statusCode: number; readonly retryAfter?: string | number }) => Promise<void> | void;
  readonly selectFallback?: (failure: { readonly providerId: string; readonly modelId: string; readonly statusCode: number; readonly retryAfter?: string | number }) => Promise<{ readonly provider: Provider; readonly model: ProviderModel } | undefined>;
}
```
to:
```ts
export interface GatewayOptions {
  readonly token: string;
  readonly providers: readonly Provider[];
  readonly pingIntervalMs?: number;
}
```

Replace the non-streaming branch inside the `/v1/messages` handler — currently the whole `if (parsed.data.stream !== true) { ... }` block with its `while (!controller.signal.aborted)` retry loop — with:
```ts
    if (parsed.data.stream !== true) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      request.raw.once("aborted", abort);
      const context = providerContext(request, controller.signal);
      const { provider, model } = resolved;
      const routeModelId = parsed.data.model;
      try {
        const effectiveRequest = withAlfaCodeIdentity({ ...resolved.request, model: model.id }, provider, model);
        const response = await collectResponse(provider, effectiveRequest, context, async () => undefined);
        return { ...response, model: routeModelId };
      } catch (error) {
        if (controller.signal.aborted) return reply.code(499).send(anthropicError("cancelled_error", "Request cancelled"));
        const normalized = normalizeProviderError(error);
        if (normalized.status === 429) reply.header("retry-after", retryAfterHeader(normalized.retryAfter));
        return reply.code(normalized.status).send(normalized.body);
      } finally {
        request.raw.removeListener("aborted", abort);
      }
    }
```

Change the streaming call site:
```ts
    reply.hijack();
    await streamResponse(reply.raw, request, resolved.provider, resolved.model, parsed.data.model, resolved.extendedContext, resolved.request, pingIntervalMs, options.usageLedger, options.onProviderOutcome, options.selectFallback);
```
to:
```ts
    reply.hijack();
    await streamResponse(reply.raw, request, resolved.provider, resolved.model, parsed.data.model, resolved.request, pingIntervalMs);
```

Replace the whole `streamResponse` function with:
```ts
async function streamResponse(
  response: ServerResponse,
  request: FastifyRequest,
  provider: Provider,
  providerModel: ProviderModel,
  routeModelId: string,
  providerRequest: ProviderMessageRequest,
  pingIntervalMs: number,
): Promise<void> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.raw.once("aborted", abort);
  response.once("close", abort);

  response.statusCode = 200;
  response.setHeader("content-type", "text/event-stream; charset=utf-8");
  response.setHeader("cache-control", "no-cache, no-transform");
  response.setHeader("connection", "keep-alive");
  response.setHeader("x-accel-buffering", "no");
  const context = providerContext(request, controller.signal);
  let wireStarted = false;
  try {
    const effectiveRequest = withAlfaCodeIdentity({ ...providerRequest, model: providerModel.id }, provider, providerModel);
    const iterator = provider.streamMessage(effectiveRequest, context)[Symbol.asyncIterator]();
    let pendingNext: Promise<IteratorResult<CanonicalStreamEvent>> | undefined;
    try {
      while (!controller.signal.aborted) {
        pendingNext ??= iterator.next();
        const next = await nextOrPing(pendingNext, pingIntervalMs, controller.signal);
        if (next === "ping") {
          wireStarted = true;
          await write(response, sse("ping", { type: "ping" }), controller.signal);
          continue;
        }
        pendingNext = undefined;
        if (next.done) return;
        if (next.value.type === "usage") continue;
        wireStarted = true;
        const event = next.value.type === "message_start"
          ? { ...next.value, message: { ...next.value.message, model: routeModelId } } as CanonicalStreamEvent
          : next.value;
        await write(response, serializeEvent(event), controller.signal);
      }
    } finally {
      await iterator.return?.().catch(() => undefined);
    }
  } catch (error) {
    if (controller.signal.aborted) return;
    const normalized = normalizeProviderError(error);
    if (!wireStarted) {
      response.statusCode = normalized.status;
      if (normalized.status === 429) response.setHeader("retry-after", retryAfterHeader(normalized.retryAfter));
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify(normalized.body));
    } else {
      await write(response, sse("error", normalized.body), controller.signal).catch(() => undefined);
    }
  } finally {
    request.raw.removeListener("aborted", abort);
    response.removeListener("close", abort);
    if (!response.writableEnded) response.end();
  }
}
```

Delete the now-unused helper functions: `recordProviderOutcome`, `isFailoverStatus`, `startAttempt`, the `AttemptTracker` interface, and `errorClass`.

- [ ] **Step 6: Update `test/gateway.test.ts`**

Delete these five tests (they exercise the removed ledger/fallback machinery): `"records final cumulative usage without emitting a private SSE event"`, `"records failed-before-output and partial-after-output attempts"`, `"feeds live availability failures back to automatic selection"`, `"fails over on an overloaded model before output even after keepalive pings"`, `"fails over non-streaming retries without returning a streamed response"`. Remove any now-unused `UsageLedger`/`AttemptOutcome` imports at the top of the file left dangling by their removal.

- [ ] **Step 7: Delete the selection/ledger files and their tests**

```bash
git rm src/model-selection.ts src/model-selection-state.ts src/usage-ledger.ts
git rm test/model-selection.test.ts test/usage-ledger.test.ts
```

- [ ] **Step 8: Remove `usage`/`default [model]`/`providers default` from `src/cli.ts`**

Remove: `program.command("usage")...` block, `program.command("default [model]")...` block, `providers.command("default <id>")...` block, and the now-unused `chooseDefaultModel`, `setDefaultModel`, `clearDefaultModel`, `usageQuery`, `queryUsageLedger`, `renderUsage` functions and `UsageFlags` interface. Remove the `UsageLedger, type UsageQuery, type UsageSummary` import from `./usage-ledger.js` and the `queryUsage` field from `CreateCliOptions`/`main()`.

Update `cli.ts`'s `StartRuntime`/`DiscoverModels` type aliases to match `runtime.ts`'s new `StartRuntimeInput` (no `provider`, no `purpose`):
```ts
export type StartRuntime = (input: { config: AlfaCodeConfig }) => Promise<RuntimeHandle>;
export type DiscoverModels = (input: { config: AlfaCodeConfig }) => Promise<readonly GatewayModel[]>;
```

Update `cli.ts`'s local `RuntimeHandle` interface (near the top) to match: remove `defaultModelId` and `contextWindowTokens`.

`selectedProvider()` was only ever used to name which single provider's model should be "pinned" or filtered to. With pinning gone, redesign `catalog()` to filter the merged candidate list by decoding each model id instead of pre-selecting one provider record — change:
```ts
  const catalog = async (config: AlfaCodeConfig, provider?: ProviderRecord): Promise<readonly GatewayModel[]> => {
    const selected = provider ?? await selectedProvider(config);
    if (options.discoverModels !== undefined) return options.discoverModels({ provider: selected, config });
    if (runtimeStarter === undefined) throw new Error("Model discovery is not configured yet");
    return discoverModelsFromGateway(runtimeStarter, { provider: selected, config });
  };
```
to:
```ts
  const catalog = async (config: AlfaCodeConfig, providerId?: string): Promise<readonly GatewayModel[]> => {
    if (options.discoverModels !== undefined) return options.discoverModels({ config });
    if (runtimeStarter === undefined) throw new Error("Model discovery is not configured yet");
    const models = await discoverModelsFromGateway(runtimeStarter, { config });
    return providerId === undefined ? models : models.filter((model) => decodeModelId(model.id)?.providerId === providerId);
  };
```
(`decodeModelId` is already imported at the top of `cli.ts`.) Update its one call site, in the `models [provider]` command:
```ts
  program.command("models [provider]").option("--json", "Emit JSON").action(async (providerId: string | undefined, flags: { json?: boolean }) => {
    const config = await loadConfig();
    const models = await catalog(config, providerId);
    if (flags.json) return ui.write(JSON.stringify(models));
    if (models.length === 0) return ui.write("No models available.");
    for (const model of models) ui.write(renderModel(model));
  });
```

Now delete `selectedProvider` entirely (it has no remaining callers: `classicLaunch`, `catalog`, `nativeLaunch`, and `saveTuiProvider` — the only four call sites — were removed or redesigned across Tasks 1-3).

Update `classicLaunch`'s `runtimeStarter` call to drop the now-gone `provider` field and the removed `defaultModelId`/`contextWindowTokens` fields — it becomes:
```ts
  const classicLaunch = async (args: readonly string[]): Promise<void> => {
    const config = await loadConfig();
    if (config.providers.length === 0) {
      process.exitCode = await (options.launch ?? launchClaude)({ claudeArgs: args, baseUrl: "", authToken: "" });
      return;
    }
    if (runtimeStarter === undefined) throw new Error("Gateway runtime is not configured yet");
    const runtime = await runtimeStarter({ config });
    try {
      for (const warning of runtime.warnings ?? []) ui.write(`Warning: ${warning}`);
      const launchOptions: ClaudeLaunchOptions = {
        claudeArgs: args,
        baseUrl: runtime.baseUrl,
        authToken: runtime.authToken,
        ...(runtime.secretEnvironmentNames === undefined ? {} : { scrubEnvironmentKeys: runtime.secretEnvironmentNames }),
      };
      process.exitCode = await (options.launch ?? launchClaude)(launchOptions);
    } finally {
      await runtime.close();
    }
  };
```

Update `main()`'s `startRuntime` wiring similarly:
```ts
    startRuntime: (input) => startRuntime({ config: input.config }, catalog === undefined ? {} : { modelMetadata: createModelsDevMetadataResolver(catalog, input.config) }),
```

- [ ] **Step 9: Verify**

Run: `pnpm typecheck && pnpm test`
Expected: both PASS.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor: drop automatic model selection and the usage ledger

Model choice is now entirely claude's own /model, backed by whatever
the gateway discovers - there is no app-level "best model" pick or
retry-on-failure between providers anymore (out of v1 scope per the
design spec). Removes the usage-tracking CLI surface that depended on
the deleted ledger.
EOF
)"
```

---

### Task 4: Auto-detect a local Ollama as a zero-config provider

**Files:**
- Create: `src/ollama-local.ts`
- Test: `test/ollama-local.test.ts`
- Modify: `src/runtime.ts`
- Modify: `src/cli.ts`
- Test: `test/providers/runtime-factory.test.ts`
- Test: `test/cli.test.ts`

**Interfaces:**
- Produces (`src/ollama-local.ts`): `OLLAMA_LOCAL_BASE_URL: string`, `OLLAMA_LOCAL_PROVIDER_ID: string`, `probeOllamaLocal(options?: { baseUrl?: string; fetch?: typeof fetch; timeoutMs?: number }): Promise<boolean>`, `ollamaLocalProviderRecord(): ProviderRecord`.
- Consumes: `ProviderRecord` from `src/config.js` (unchanged type).

- [ ] **Step 1: Write the failing test for the probe**

Create `test/ollama-local.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { OLLAMA_LOCAL_BASE_URL, OLLAMA_LOCAL_PROVIDER_ID, ollamaLocalProviderRecord, probeOllamaLocal } from "../src/ollama-local.js";

describe("probeOllamaLocal", () => {
  it("returns true when the local endpoint responds ok", async () => {
    const calls: string[] = [];
    const reachable = await probeOllamaLocal({ fetch: async (input) => { calls.push(String(input)); return new Response(null, { status: 200 }); } });
    expect(reachable).toBe(true);
    expect(calls).toEqual([`${OLLAMA_LOCAL_BASE_URL}/models`]);
  });

  it("returns false when the endpoint is unreachable", async () => {
    const reachable = await probeOllamaLocal({ fetch: async () => { throw new Error("ECONNREFUSED"); } });
    expect(reachable).toBe(false);
  });

  it("returns false on a non-ok response", async () => {
    const reachable = await probeOllamaLocal({ fetch: async () => new Response(null, { status: 500 }) });
    expect(reachable).toBe(false);
  });
});

describe("ollamaLocalProviderRecord", () => {
  it("has no API key reference (openai-compatible discovery treats it as anonymous)", () => {
    expect(ollamaLocalProviderRecord()).toEqual({ id: OLLAMA_LOCAL_PROVIDER_ID, type: "ollama-local" });
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm vitest run test/ollama-local.test.ts`
Expected: FAIL — `../src/ollama-local.js` does not exist.

- [ ] **Step 3: Implement `src/ollama-local.ts`**

```ts
import type { ProviderRecord } from "./config.js";

export const OLLAMA_LOCAL_BASE_URL = "http://localhost:11434/v1";
export const OLLAMA_LOCAL_PROVIDER_ID = "ollama-local";

export interface OllamaLocalProbeOptions {
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/** A short timeout keeps a cold/absent Ollama daemon from delaying every launch. */
export async function probeOllamaLocal(options: OllamaLocalProbeOptions = {}): Promise<boolean> {
  const baseUrl = options.baseUrl ?? OLLAMA_LOCAL_BASE_URL;
  const requestFetch = options.fetch ?? fetch;
  try {
    const response = await requestFetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(options.timeoutMs ?? 300) });
    return response.ok;
  } catch {
    return false;
  }
}

export function ollamaLocalProviderRecord(): ProviderRecord {
  return { id: OLLAMA_LOCAL_PROVIDER_ID, type: "ollama-local" };
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `pnpm vitest run test/ollama-local.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test for `createConfiguredProvider`'s new branch**

In `test/providers/runtime-factory.test.ts`, add:
```ts
  it("discovers ollama-local without a base URL or API key", async () => {
    const record: ProviderRecord = { id: "ollama-local", type: "ollama-local" };
    const urls: string[] = [];
    const built = await createConfiguredProvider(record, "ollama", {
      fetch: async (input) => { urls.push(String(input)); return Response.json(String(input).endsWith("/models") ? { data: [{ id: "gemma4:31b" }] } : { id: "gemma4:31b" }); },
      modelMetadata: { async resolve() { return { capabilities: { streaming: true, tools: true, parallelTools: true, forcedToolChoice: true, vision: false, reasoningState: "optional" as const, nativeTokenCounting: false, jsonSchema: "full" as const } }; } },
    }, "/tmp/alfacode-test");
    expect(built.descriptors[0]).toMatchObject({ id: "gemma4:31b", availability: "available" });
    expect(urls[0]).toBe("http://localhost:11434/v1/models");
  });
```

- [ ] **Step 6: Run it to confirm it fails**

Run: `pnpm vitest run test/providers/runtime-factory.test.ts -t "ollama-local"`
Expected: FAIL — `createConfiguredProvider` throws `Unsupported provider type: ollama-local`.

- [ ] **Step 7: Add the branch in `src/runtime.ts`**

In `createConfiguredProvider`, right after the `openai-compatible` branch, add:
```ts
  if (record.type === "ollama-local") {
    const localBaseUrl = baseUrl ?? "http://localhost:11434/v1";
    const descriptors = await discoverConfiguredModels(record, apiKey, "openai-chat", localBaseUrl, dependencies);
    return { provider: createWireProvider({ id: record.id, apiKey, baseUrl: localBaseUrl, wireProtocol: "openai-chat", models: descriptors }, dependencies, homeDirectory), descriptors };
  }
```

- [ ] **Step 8: Run it to confirm it passes**

Run: `pnpm vitest run test/providers/runtime-factory.test.ts`
Expected: PASS, all cases.

- [ ] **Step 9: Write the failing test for auto-injection in the launch flow**

In `test/cli.test.ts`, add:
```ts
  it("adds a local Ollama provider automatically when it's reachable and not already configured", async () => {
    const home = await mkdtemp(join(tmpdir(), "alfacode-cli-ollama-"));
    directories.push(home);
    const configStore = new ConfigStore({ homeDirectory: home });
    const seenConfigs: AlfaCodeConfig[] = [];
    const cli = createCli({
      configStore,
      probeOllamaLocal: async () => true,
      startRuntime: async (input) => { seenConfigs.push(input.config); return { baseUrl: "http://gateway", authToken: "token", modelCandidates: [], close: async () => undefined }; },
      launch: async () => 0,
      ui: fakeUi(),
    });

    await cli.parseAsync(["node", "alfacode"], { from: "node" });
    expect(seenConfigs[0]?.providers.map((provider) => provider.id)).toEqual(["ollama-local"]);
    expect(await configStore.exists()).toBe(false);
  });

  it("does not duplicate an already-configured ollama-local provider", async () => {
    const home = await mkdtemp(join(tmpdir(), "alfacode-cli-ollama-dup-"));
    directories.push(home);
    const configStore = new ConfigStore({ homeDirectory: home });
    await configStore.write({ version: 1, providers: [{ id: "ollama-local", type: "ollama-local" }] });
    const seenConfigs: AlfaCodeConfig[] = [];
    const cli = createCli({
      configStore,
      probeOllamaLocal: async () => true,
      startRuntime: async (input) => { seenConfigs.push(input.config); return { baseUrl: "http://gateway", authToken: "token", modelCandidates: [], close: async () => undefined }; },
      launch: async () => 0,
      ui: fakeUi(),
    });

    await cli.parseAsync(["node", "alfacode"], { from: "node" });
    expect(seenConfigs[0]?.providers).toHaveLength(1);
  });
```
(`AlfaCodeConfig` is already imported in this file per Task 1's edits.)

- [ ] **Step 10: Run it to confirm it fails**

Run: `pnpm vitest run test/cli.test.ts -t "ollama"`
Expected: FAIL — `createCli` rejects the unknown `probeOllamaLocal` option (or, if `CreateCliOptions` is a loose type, `seenConfigs[0]` has zero providers because nothing injects `ollama-local`).

- [ ] **Step 11: Wire it into `src/cli.ts`**

Add the import:
```ts
import { ollamaLocalProviderRecord, probeOllamaLocal } from "./ollama-local.js";
```
Add to `CreateCliOptions`:
```ts
  readonly probeOllamaLocal?: () => Promise<boolean>;
```
In `createCli`, capture it near the other option defaults:
```ts
  const probeOllama = options.probeOllamaLocal ?? probeOllamaLocal;
```
`classicLaunch` becomes:
```ts
  const classicLaunch = async (args: readonly string[]): Promise<void> => {
    const config = await loadConfig();
    const withOllama = config.providers.some((item) => item.type === "ollama-local")
      ? config
      : await probeOllama() ? { ...config, providers: [...config.providers, ollamaLocalProviderRecord()] } : config;
    if (withOllama.providers.length === 0) {
      process.exitCode = await (options.launch ?? launchClaude)({ claudeArgs: args, baseUrl: "", authToken: "" });
      return;
    }
    if (runtimeStarter === undefined) throw new Error("Gateway runtime is not configured yet");
    const runtime = await runtimeStarter({ config: withOllama });
    try {
      for (const warning of runtime.warnings ?? []) ui.write(`Warning: ${warning}`);
      const launchOptions: ClaudeLaunchOptions = {
        claudeArgs: args,
        baseUrl: runtime.baseUrl,
        authToken: runtime.authToken,
        ...(runtime.secretEnvironmentNames === undefined ? {} : { scrubEnvironmentKeys: runtime.secretEnvironmentNames }),
      };
      process.exitCode = await (options.launch ?? launchClaude)(launchOptions);
    } finally {
      await runtime.close();
    }
  };
```
(only the `withOllama` computation, the zero-provider check, and the `runtimeStarter({ config: withOllama })` call differ from Task 3's version — shown in full since steps need real code, not a diff description). This mutation is never written back through `configStore` — it lives only for this one launch.

- [ ] **Step 12: Run it to confirm it passes**

Run: `pnpm vitest run test/cli.test.ts`
Expected: PASS, all cases. Also re-run the Task 2 zero-provider test (`"skips the gateway entirely..."`) with `probeOllamaLocal` left at its real default — it will now actually probe `localhost:11434` over the network in CI. Fix it by passing `probeOllamaLocal: async () => false` explicitly in that test so it stays hermetic:
```ts
      probeOllamaLocal: async () => false,
```
added to that test's `createCli({...})` call.

- [ ] **Step 13: Full verification**

Run: `pnpm typecheck && pnpm test`
Expected: both PASS.

- [ ] **Step 14: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat: auto-detect a local Ollama as a zero-config provider

A reachable localhost:11434 is added to the launch's provider list
automatically, never persisted to config.json. Ollama Cloud and a
real OpenCode Go/Zen account still go through the existing
alfacode connect openai-compatible / connect zen commands - no new
code needed there, they already work.
EOF
)"
```

---

### Task 5: Final verification and PR

**Files:** none (verification + manual checklist only).

- [ ] **Step 1: Full automated check**

Run: `pnpm check` (runs `typecheck && test && build` per `package.json`'s existing script)
Expected: PASS.

- [ ] **Step 2: Manual acceptance checklist**

Run each of these against the built CLI (`pnpm build && node dist/cli.js`, or `pnpm dev` for the TS entrypoint) and record the actual output in the PR description:

1. Fresh `~/.alfacode` (rename it aside first if it exists), Ollama daemon stopped, no providers configured: `alfacode --print "hi"` → behaves identically to `claude --print "hi"` run directly.
2. Start Ollama locally (`ollama serve`, with a model pulled, e.g. `ollama pull gemma3:1b`), zero other config: `alfacode`, then `/model` inside the real TUI → the local model is listed; dispatch a message to it and confirm a real response.
3. `alfacode connect openai-compatible --id ollama-cloud --base-url https://ollama.com/v1 --api-key-env OLLAMA_API_KEY` (with a real key exported), then `alfacode` → `/model` lists `gemma4:31b`; dispatch and confirm a real response (already proven against the standalone gateway this session — this step confirms the full CLI path too).
4. `alfacode connect zen --id opencode-go --api-key-env OPENCODE_GO_API_KEY` (Andrea's real paid key, once available) → confirm the `MissingSessionID` error from the anonymous tier does NOT appear; `/model` lists the Zen catalog; dispatch works.
5. Create `.claude/agents/gateway-test.md` in a scratch project with `model: alfacode-anthropic/ollama-cloud/gemma4:31b` (or whichever encoded id `alfacode models` reports) in its frontmatter, dispatch a Task to it from the main conversation while the main conversation stays on a normal Anthropic model, and confirm the subagent's response demonstrably came from the non-Anthropic model (ask it to self-identify, same technique used throughout this session's PoCs). This is the original goal of the whole project — do not skip it.

- [ ] **Step 3: Open the PR**

```bash
git push -u origin feat/thin-launcher
gh pr create --title "Replace the custom TUI with a thin launcher over real Claude Code" --body "$(cat <<'EOF'
## Summary
- Removes the embedded Ink/React TUI and @anthropic-ai/claude-agent-sdk engine; alfacode now spawns the real, unmodified claude binary and lets it render its own TUI.
- Drops automatic model selection, failover, and usage tracking (out of v1 scope) along with the CLI commands that only existed to serve them.
- Adds zero-config auto-detection of a local Ollama; Ollama Cloud and a real OpenCode Go/Zen account go through the existing connect command, no new provider code needed for them.

## Test plan
- [ ] `pnpm check` passes
- [ ] Manual acceptance checklist (5 items) in docs/superpowers/plans/2026-09-10-thin-launcher.md, Task 5
EOF
)"
```

No AI co-author trailer (standing rule for this repo).
