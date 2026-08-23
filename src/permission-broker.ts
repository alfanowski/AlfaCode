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

interface PendingPermission {
  readonly request: PermissionRequest;
  readonly resolve: (result: PermissionResult) => void;
  readonly reject: (error: Error) => void;
}

export class PermissionBroker {
  private sequence = 0;
  private readonly queue: PendingPermission[] = [];
  private readonly listeners = new Set<(request: PermissionRequest | undefined) => void>();

  public readonly canUseTool: CanUseTool = async (toolName, input, options) => {
    const id = ++this.sequence;
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
    this.emit();
  }

  private cancel(id: number): void {
    const index = this.queue.findIndex((item) => item.request.id === id);
    if (index < 0) return;
    const [pending] = this.queue.splice(index, 1);
    pending?.reject(new Error("Permission request aborted"));
    this.emit();
  }

  private emit(): void {
    const current = this.current();
    for (const listener of this.listeners) listener(current);
  }
}

function sanitize(value: string): string {
  return value.replace(/[\u001B\u009B][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "").slice(0, 2_000);
}
