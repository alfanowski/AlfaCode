import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

export interface Choice {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}

export interface TerminalUi {
  readonly interactive: boolean;
  readonly color: boolean;
  write(message: string): void;
  select(message: string, choices: readonly Choice[]): Promise<string>;
  ask(message: string, fallback?: string): Promise<string>;
}

export interface TerminalUiOptions {
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WriteStream;
  readonly interactive?: boolean;
  readonly color?: boolean;
  readonly environment?: NodeJS.ProcessEnv;
}

export function createTerminalUi(options: TerminalUiOptions = {}): TerminalUi {
  const input = options.input ?? stdin;
  const output = options.output ?? stdout;
  const environment = options.environment ?? process.env;
  const interactive = options.interactive ?? Boolean(isTty(input) && output.isTTY && !environment.CI);
  const color = options.color ?? Boolean(interactive && !environment.NO_COLOR && environment.TERM !== "dumb");
  const prefix = color ? "\u001B[1;36mAlfaCode\u001B[0m" : "AlfaCode";
  return {
    interactive,
    color,
    write(message) { output.write(`${message}\n`); },
    async ask(message, fallback) {
      requireInteractive(interactive);
      const readline = createInterface({ input, output, terminal: true });
      try {
        const suffix = fallback === undefined ? "" : ` [${fallback}]`;
        const answer = (await readline.question(`${prefix} ${message}${suffix}: `)).trim();
        return answer || fallback || "";
      } finally {
        readline.close();
      }
    },
    async select(message, choices) {
      requireInteractive(interactive);
      if (choices.length === 0) throw new Error("No choices are available");
      output.write(`${prefix} ${message}\n`);
      choices.forEach((choice, index) => output.write(`  ${index + 1}) ${choice.label}${choice.hint === undefined ? "" : ` — ${choice.hint}`}\n`));
      const answer = await this.ask("Choose a number", "1");
      const index = Number(answer) - 1;
      const selected = Number.isInteger(index) ? choices[index] : undefined;
      if (selected === undefined) throw new Error("Invalid selection");
      return selected.value;
    },
  };
}

function isTty(input: NodeJS.ReadableStream): boolean {
  return "isTTY" in input && input.isTTY === true;
}

export function requireInteractive(interactive: boolean): void {
  if (!interactive) throw new Error("This command requires an interactive terminal. Use --api-key-env for non-interactive setup.");
}
