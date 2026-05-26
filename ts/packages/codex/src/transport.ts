import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";

import {
  AbstractMessageReader,
  AbstractMessageWriter,
  Disposable,
  type DataCallback,
  type Message,
  type MessageReader,
  type MessageWriter,
} from "vscode-jsonrpc";

export interface CodexJsonRpcTransportOptions {
  onMalformedLine?: ((line: string) => void) | undefined;
  onNotification?: ((message: Record<string, unknown>) => void) | undefined;
  onRequest?: ((message: Record<string, unknown> & { method: string }) => void) | undefined;
  requestIdOffset?: number | undefined;
}

export class CodexNdjsonMessageReader extends AbstractMessageReader implements MessageReader {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private callback: DataCallback | null = null;
  private closed = false;

  constructor(
    private readonly readable: Readable,
    private readonly options: CodexJsonRpcTransportOptions = {},
  ) {
    super();
  }

  listen(callback: DataCallback): Disposable {
    if (this.callback !== null) throw new Error("Codex NDJSON reader is already listening");
    this.callback = callback;

    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
      this.buffer = this.consumeBuffer(this.buffer + text);
    };
    const onError = (error: Error) => this.fireError(error);
    const onClose = () => this.close();

    this.readable.on("data", onData);
    this.readable.on("error", onError);
    this.readable.on("end", onClose);
    this.readable.on("close", onClose);

    return Disposable.create(() => {
      this.readable.off("data", onData);
      this.readable.off("error", onError);
      this.readable.off("end", onClose);
      this.readable.off("close", onClose);
      this.callback = null;
    });
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.buffer += this.decoder.end();
    if (this.buffer.trim() !== "") {
      this.emitLine(this.buffer.trimEnd());
      this.buffer = "";
    }
    this.fireClose();
  }

  private consumeBuffer(buffer: string): string {
    let remaining = buffer;
    while (true) {
      const index = remaining.indexOf("\n");
      if (index === -1) return remaining;
      const line = remaining.slice(0, index).trimEnd();
      remaining = remaining.slice(index + 1);
      if (line.trim() !== "") this.emitLine(line);
    }
  }

  private emitLine(line: string): void {
    let decoded: unknown;
    try {
      decoded = JSON.parse(line) as unknown;
    } catch {
      this.options.onMalformedLine?.(line);
      return;
    }
    if (!isRecord(decoded)) return;

    const rawMessage = stripJsonRpc(decoded);
    const connectionMessage = this.toConnectionMessage(decoded);
    const method = typeof rawMessage.method === "string" ? rawMessage.method : null;
    if (method !== null && rawMessage.id !== undefined) {
      this.options.onRequest?.({ ...rawMessage, method });
    } else if (method !== null) {
      this.options.onNotification?.(rawMessage);
    }

    this.callback?.(connectionMessage);
  }

  private toConnectionMessage(message: Record<string, unknown>): Message {
    const offset = this.options.requestIdOffset ?? 0;
    const hasMethod = typeof message.method === "string";
    const isResponse = !hasMethod && (message.result !== undefined || message.error !== undefined);
    if (offset !== 0 && isResponse && typeof message.id === "number") {
      return withJsonRpc({ ...message, id: message.id - offset });
    }
    return withJsonRpc(message);
  }
}

export class CodexNdjsonMessageWriter extends AbstractMessageWriter implements MessageWriter {
  private errorCount = 0;

  constructor(
    private readonly writable: Writable,
    private readonly options: Pick<CodexJsonRpcTransportOptions, "requestIdOffset"> = {},
  ) {
    super();
  }

  async write(message: Message): Promise<void> {
    if (!this.writable.writable) {
      const error = new Error("Codex NDJSON writer is closed");
      this.fireError(error, message, ++this.errorCount);
      return Promise.reject(error);
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        this.fireError(error, message, ++this.errorCount);
        reject(error);
      };
      const succeed = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      try {
        this.writable.write(`${JSON.stringify(this.toWireMessage(message))}\n`, (error) => {
          if (error) fail(error);
          else succeed();
        });
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  end(): void {
    this.fireClose();
  }

  private toWireMessage(message: Message): Record<string, unknown> {
    const wireMessage = stripJsonRpc(message);
    const offset = this.options.requestIdOffset ?? 0;
    if (
      offset !== 0 &&
      typeof wireMessage.method === "string" &&
      typeof wireMessage.id === "number"
    ) {
      return { ...wireMessage, id: wireMessage.id + offset };
    }
    if (
      offset !== 0 &&
      wireMessage.method === "$/cancelRequest" &&
      isRecord(wireMessage.params) &&
      typeof wireMessage.params.id === "number"
    ) {
      return {
        ...wireMessage,
        params: { ...wireMessage.params, id: wireMessage.params.id + offset },
      };
    }
    return wireMessage;
  }
}

function withJsonRpc(message: Record<string, unknown>): Message {
  return { jsonrpc: "2.0", ...message };
}

function stripJsonRpc(message: Record<string, unknown>): Record<string, unknown>;
function stripJsonRpc(message: Message): Record<string, unknown>;
function stripJsonRpc(message: Message | Record<string, unknown>): Record<string, unknown> {
  const { jsonrpc: _jsonrpc, ...withoutJsonRpc } = message as unknown as Record<string, unknown>;
  return withoutJsonRpc;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
