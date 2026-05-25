import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import { execa } from "execa";

export class CodexProcess {
  readonly child: ChildProcessWithoutNullStreams;
  private stderrBuffer = "";
  private readonly stderrDecoder = new StringDecoder("utf8");
  private stderrHandlers = new Set<(line: string) => void>();
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

    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrBuffer = this.consumeBuffer(
        this.stderrBuffer + this.stderrDecoder.write(chunk),
        (line) => {
          for (const handler of this.stderrHandlers) handler(line);
        },
      );
    });

    this.child.on("close", (code, signal) => {
      this.stderrBuffer += this.stderrDecoder.end();
      if (this.stderrBuffer.trim() !== "") {
        for (const handler of this.stderrHandlers) handler(this.stderrBuffer.trimEnd());
        this.stderrBuffer = "";
      }
      for (const handler of this.exitHandlers) handler(code, signal);
    });
  }

  onStderr(handler: (line: string) => void): void {
    this.stderrHandlers.add(handler);
  }

  onExit(handler: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitHandlers.add(handler);
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
}
