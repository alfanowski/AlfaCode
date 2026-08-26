import React from "react";
import { Box, Text } from "ink";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { sanitizeTerminalText } from "./markdown.js";
import type { Theme } from "./theme.js";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  readonly content: string;
  readonly activeForm: string;
  readonly status: TodoStatus;
}

/**
 * AlfaCode's engine surfaces the plan/task list exclusively through TodoWrite tool calls (there
 * is no dedicated "todo state" SDK message). `TodoWriteInput.todos` already IS the full, updated
 * todo list per the SDK's own tool schema, so the assistant message that completes a TodoWrite
 * tool_use content block is read as the authoritative current state — no need to wait on (or
 * correlate against) the matching tool_result.
 */
export function parseTodoWriteTodos(message: SDKMessage): readonly TodoItem[] | undefined {
  if (message.type !== "assistant") return undefined;
  const content: unknown = message.message.content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (!isRecord(block) || block.type !== "tool_use" || block.name !== "TodoWrite") continue;
    const todos = parseTodos(isRecord(block.input) ? block.input.todos : undefined);
    if (todos !== undefined) return todos;
  }
  return undefined;
}

function parseTodos(value: unknown): readonly TodoItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const todos: TodoItem[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate) || typeof candidate.content !== "string" || typeof candidate.activeForm !== "string" || !isTodoStatus(candidate.status)) return undefined;
    todos.push({
      content: sanitizeTerminalText(candidate.content).slice(0, 400),
      activeForm: sanitizeTerminalText(candidate.activeForm).slice(0, 400),
      status: candidate.status,
    });
  }
  return todos;
}

function isTodoStatus(value: unknown): value is TodoStatus {
  return value === "pending" || value === "in_progress" || value === "completed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function TodoPanel({ todos, collapsed, theme }: { readonly todos: readonly TodoItem[]; readonly collapsed: boolean; readonly theme: Theme }): React.JSX.Element | null {
  if (todos.length === 0) return null;
  const completed = todos.filter((todo) => todo.status === "completed").length;
  const active = todos.find((todo) => todo.status === "in_progress");
  if (collapsed) {
    return <Box borderStyle="round" borderColor={theme.border} paddingX={1} marginBottom={1} justifyContent="space-between">
      <Text bold color={theme.muted}>TASKS</Text>
      <Text color={theme.faint}>{completed}/{todos.length} done{active === undefined ? "" : ` · ${active.activeForm}`} · ctrl+t expand</Text>
    </Box>;
  }
  return <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1} marginBottom={1}>
    <Box justifyContent="space-between"><Text bold color={theme.muted}>TASKS</Text><Text color={theme.faint}>{completed}/{todos.length} done · ctrl+t collapse</Text></Box>
    {todos.map((todo, index) => {
      const icon = todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "▶" : "○";
      const color = todo.status === "completed" ? theme.success : todo.status === "in_progress" ? theme.accent : theme.faint;
      const label = todo.status === "in_progress" ? todo.activeForm : todo.content;
      return <Text key={`todo-${index}`} color={color}>{icon} {label}</Text>;
    })}
  </Box>;
}
