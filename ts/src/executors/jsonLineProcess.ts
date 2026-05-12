import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { execa } from "execa";

export class JsonLineProcess {
  readonly child: ChildProcessWithoutNullStreams;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private readonly stdoutDecoder = new StringDecoder("utf8");
  private readonly stderrDecoder = new StringDecoder("utf8");
  private lineHandlers = new Set<(value: unknown, raw: string) => void>();
  private stderrHandlers = new Set<(line: string) => void>();
  private malformedHandlers = new Set<(line: string) => void>();
  private exitHandlers = new Set<(code: number | null, signal: NodeJS.Signals | null) => void>();

  constructor(command: string | ChildProcessWithoutNullStreams, cwd?: string) {
    this.child =
      typeof command === "string"
        ? (execa("bash", ["-lc", command], {
            ...(cwd === undefined ? {} : { cwd }),
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
            reject: false,
          }) as unknown as ChildProcessWithoutNullStreams)
        : command;

    this.child.stdout.on("data", (chunk) => {
      this.stdoutBuffer = this.consumeBuffer(
        this.stdoutBuffer + this.stdoutDecoder.write(chunk),
        (line) => {
          try {
            const decoded = JSON.parse(line) as unknown;
            for (const handler of this.lineHandlers) handler(decoded, line);
          } catch {
            if (this.malformedHandlers.size > 0) {
              for (const handler of this.malformedHandlers) handler(line);
            } else {
              for (const handler of this.stderrHandlers) handler(line);
            }
          }
        },
      );
    });

    this.child.stderr.on("data", (chunk) => {
      this.stderrBuffer = this.consumeBuffer(
        this.stderrBuffer + this.stderrDecoder.write(chunk),
        (line) => {
          for (const handler of this.stderrHandlers) handler(line);
        },
      );
    });

    this.child.on("close", (code, signal) => {
      this.stdoutBuffer += this.stdoutDecoder.end();
      this.stderrBuffer += this.stderrDecoder.end();
      if (this.stdoutBuffer.trim() !== "") {
        this.emitStdoutLine(this.stdoutBuffer.trimEnd());
        this.stdoutBuffer = "";
      }
      if (this.stderrBuffer.trim() !== "") {
        for (const handler of this.stderrHandlers) handler(this.stderrBuffer.trimEnd());
        this.stderrBuffer = "";
      }
      for (const handler of this.exitHandlers) handler(code, signal);
    });
  }

  onJson(handler: (value: unknown, raw: string) => void): void {
    this.lineHandlers.add(handler);
  }

  onStderr(handler: (line: string) => void): void {
    this.stderrHandlers.add(handler);
  }

  onMalformed(handler: (line: string) => void): void {
    this.malformedHandlers.add(handler);
  }

  onExit(handler: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitHandlers.add(handler);
  }

  send(value: unknown): boolean {
    if (!this.child.stdin.writable || this.child.exitCode !== null || this.child.killed)
      return false;
    try {
      return this.child.stdin.write(`${JSON.stringify(value)}\n`);
    } catch {
      return false;
    }
  }

  sendRawLine(value: string): void {
    this.child.stdin.write(`${value}\n`);
  }

  async stop(): Promise<void> {
    if (this.child.killed) return;
    this.child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.child.killed) this.child.kill("SIGKILL");
        resolve();
      }, 1000);
      this.child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private consumeBuffer(buffer: string, emit: (line: string) => void): string {
    let remaining = buffer;
    while (true) {
      const index = remaining.indexOf("\n");
      if (index === -1) return remaining;
      const line = remaining.slice(0, index).trimEnd();
      remaining = remaining.slice(index + 1);
      if (line.trim() !== "") emit(line);
    }
  }

  private emitStdoutLine(line: string): void {
    try {
      const decoded = JSON.parse(line) as unknown;
      for (const handler of this.lineHandlers) handler(decoded, line);
    } catch {
      if (this.malformedHandlers.size > 0) {
        for (const handler of this.malformedHandlers) handler(line);
      } else {
        for (const handler of this.stderrHandlers) handler(line);
      }
    }
  }
}
