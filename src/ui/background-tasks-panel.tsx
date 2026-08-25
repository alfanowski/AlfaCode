import React from "react";
import { Box, Text } from "ink";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { sanitizeTerminalText } from "./markdown.js";
import type { Theme } from "./theme.js";

export interface BackgroundTask {
  readonly taskId: string;
  readonly taskType: string;
  readonly description: string;
}

/**
 * `system/background_tasks_changed` is a level signal: it always carries the FULL set of live
 * background tasks (backgrounded Bash commands or subagents), so consumers replace their local
 * state with each payload rather than pairing start/stop edges. That is exactly what AlfaCode
 * needs to show "still running in background" work distinct from the current foreground turn.
 */
export function parseBackgroundTasksChanged(message: SDKMessage): readonly BackgroundTask[] | undefined {
  if (message.type !== "system" || message.subtype !== "background_tasks_changed") return undefined;
  return message.tasks.map((task) => ({
    taskId: task.task_id,
    taskType: sanitizeTerminalText(task.task_type).slice(0, 80),
    description: sanitizeTerminalText(task.description).slice(0, 200),
  }));
}

export function BackgroundTasksPanel({ tasks, theme }: { readonly tasks: readonly BackgroundTask[]; readonly theme: Theme }): React.JSX.Element | null {
  if (tasks.length === 0) return null;
  const visible = tasks.slice(0, 4);
  const extra = tasks.length - visible.length;
  return <Box flexDirection="column" borderStyle="round" borderColor={theme.secondary} paddingX={1} marginBottom={1}>
    <Text bold color={theme.secondarySoft}>⚙ BACKGROUND · {tasks.length} running</Text>
    {visible.map((task) => <Text key={task.taskId} color={theme.muted}>· {task.taskType} — {task.description}</Text>)}
    {extra > 0 ? <Text color={theme.faint}>+{extra} more</Text> : null}
  </Box>;
}
