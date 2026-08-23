import type { CanUseTool, PermissionResult, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";

export interface PermissionRequest {
  readonly id: number;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly title?: string;
  readonly description?: string;
  readonly reason?: string;
  readonly suggestions: readonly PermissionUpdate[];
}

export interface UserQuestionOption {
  readonly label: string;
  readonly description: string;
  readonly preview?: string;
}

export interface UserQuestion {
  readonly question: string;
  readonly header: string;
  readonly options: readonly UserQuestionOption[];
  readonly multiSelect: boolean;
}

export interface UserQuestionRequest {
  readonly id: number;
  readonly questions: readonly UserQuestion[];
}

interface PendingPermission {
  readonly request: PermissionRequest;
  readonly resolve: (result: PermissionResult) => void;
  readonly reject: (error: Error) => void;
}

interface PendingQuestions {
  readonly request: UserQuestionRequest;
  readonly input: Record<string, unknown>;
  readonly resolve: (result: PermissionResult) => void;
  readonly reject: (error: Error) => void;
}

export class PermissionBroker {
  private sequence = 0;
  private readonly queue: PendingPermission[] = [];
  private readonly questionQueue: PendingQuestions[] = [];
  private readonly listeners = new Set<(request: PermissionRequest | undefined) => void>();
  private readonly questionListeners = new Set<(request: UserQuestionRequest | undefined) => void>();

  public readonly canUseTool: CanUseTool = async (toolName, input, options) => {
    const id = ++this.sequence;
    if (toolName === "AskUserQuestion") {
      const questions = parseQuestions(input.questions);
      if (questions === undefined) return { behavior: "deny", message: "AskUserQuestion received an invalid question payload" };
      return new Promise<PermissionResult>((resolve, reject) => {
        this.questionQueue.push({ request: { id, questions }, input, resolve, reject });
        this.emitQuestions();
        options.signal.addEventListener("abort", () => this.cancelQuestion(id), { once: true });
      });
    }
    return new Promise<PermissionResult>((resolve, reject) => {
      const pending: PendingPermission = {
        request: {
          id,
          toolName,
          input,
          ...(options.title === undefined ? {} : { title: sanitize(options.title) }),
          ...(options.description === undefined ? {} : { description: sanitize(options.description) }),
          ...(options.decisionReason === undefined ? {} : { reason: sanitize(options.decisionReason) }),
          suggestions: options.suggestions ?? [],
        },
        resolve,
        reject,
      };
      this.queue.push(pending);
      this.emit();
      options.signal.addEventListener("abort", () => this.cancel(id), { once: true });
    });
  };

  public current(): PermissionRequest | undefined {
    return this.queue[0]?.request;
  }

  public subscribe(listener: (request: PermissionRequest | undefined) => void): () => void {
    this.listeners.add(listener);
    listener(this.current());
    return () => this.listeners.delete(listener);
  }

  public currentQuestions(): UserQuestionRequest | undefined {
    return this.questionQueue[0]?.request;
  }

  public subscribeQuestions(listener: (request: UserQuestionRequest | undefined) => void): () => void {
    this.questionListeners.add(listener);
    listener(this.currentQuestions());
    return () => this.questionListeners.delete(listener);
  }

  public answerQuestions(answers: Readonly<Record<string, string>>): void {
    const pending = this.questionQueue.shift();
    if (pending === undefined) return;
    pending.resolve({ behavior: "allow", updatedInput: { ...pending.input, answers: { ...answers } } });
    this.emitQuestions();
  }

  public cancelQuestions(message = "Question dismissed by user"): void {
    const pending = this.questionQueue.shift();
    if (pending === undefined) return;
    pending.resolve({ behavior: "deny", message });
    this.emitQuestions();
  }

  public allow(always = false): void {
    const pending = this.queue.shift();
    if (pending === undefined) return;
    pending.resolve({ behavior: "allow", ...(always && pending.request.suggestions.length > 0 ? { updatedPermissions: [...pending.request.suggestions] } : {}) });
    this.emit();
  }

  public deny(message = "Denied by user"): void {
    const pending = this.queue.shift();
    if (pending === undefined) return;
    pending.resolve({ behavior: "deny", message });
    this.emit();
  }

  public close(): void {
    for (const pending of this.queue.splice(0)) pending.reject(new Error("Permission surface closed"));
    for (const pending of this.questionQueue.splice(0)) pending.reject(new Error("Question surface closed"));
    this.emit();
    this.emitQuestions();
  }

  private cancel(id: number): void {
    const index = this.queue.findIndex((item) => item.request.id === id);
    if (index < 0) return;
    const [pending] = this.queue.splice(index, 1);
    pending?.reject(new Error("Permission request aborted"));
    this.emit();
  }

  private cancelQuestion(id: number): void {
    const index = this.questionQueue.findIndex((item) => item.request.id === id);
    if (index < 0) return;
    const [pending] = this.questionQueue.splice(index, 1);
    pending?.reject(new Error("Question request aborted"));
    this.emitQuestions();
  }

  private emit(): void {
    const current = this.current();
    for (const listener of this.listeners) listener(current);
  }

  private emitQuestions(): void {
    const current = this.currentQuestions();
    for (const listener of this.questionListeners) listener(current);
  }
}

function parseQuestions(value: unknown): readonly UserQuestion[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) return undefined;
  const questions: UserQuestion[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate) || typeof candidate.question !== "string" || typeof candidate.header !== "string" || typeof candidate.multiSelect !== "boolean" || !Array.isArray(candidate.options) || candidate.options.length < 2 || candidate.options.length > 4) return undefined;
    const options: UserQuestionOption[] = [];
    for (const option of candidate.options) {
      if (!isRecord(option) || typeof option.label !== "string" || typeof option.description !== "string") return undefined;
      options.push({ label: sanitize(option.label), description: sanitize(option.description), ...(typeof option.preview === "string" ? { preview: sanitize(option.preview) } : {}) });
    }
    questions.push({ question: sanitize(candidate.question), header: sanitize(candidate.header), options, multiSelect: candidate.multiSelect });
  }
  return questions;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitize(value: string): string {
  return value
    .replace(/\u001B(?:\]|P|X|\^|_)[\s\S]*?(?:\u0007|\u001B\\)/gu, "")
    .replace(/(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\u001B[@-_]/gu, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, "")
    .slice(0, 2_000);
}
