/**
 * CLI entry point for the traceviz server.
 *
 * Usage:
 *   traceviz-server [--trace-dir DIR] [--port PORT] [--static-dir DIR]
 */

import path from "node:path";

import { createApp } from "./server.js";

function usage(): never {
  console.error("Usage: traceviz-server [--trace-dir DIR] [--port PORT] [--static-dir DIR]");
  console.error("");
  console.error("Options:");
  console.error("  --trace-dir DIR    Directory containing JSONL trace files (default: ./traces)");
  console.error("  --port PORT        Port to listen on (default: 5050)");
  console.error("  --static-dir DIR   Directory to serve static frontend from");
  console.error("  --help, -h         Show this help");
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let traceDir = "./traces";
  let port = 5050;
  let staticDir: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === "--trace-dir" || arg === "-d") && i + 1 < args.length) {
      traceDir = args[++i]!;
    } else if ((arg === "--port" || arg === "-p") && i + 1 < args.length) {
      const parsed = parseInt(args[++i]!, 10);
      if (Number.isNaN(parsed)) {
        console.error("Error: --port must be a number");
        usage();
      }
      port = parsed;
    } else if (arg === "--static-dir" && i + 1 < args.length) {
      staticDir = args[++i]!;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      console.error(`Unknown argument: ${arg}`);
      usage();
    }
  }

  traceDir = path.resolve(traceDir);
  if (staticDir) {
    staticDir = path.resolve(staticDir);
  }

  const app = await createApp({ traceDir, staticDir });

  await app.listen({ host: "127.0.0.1", port });
  console.log(`Traceviz server listening at http://127.0.0.1:${port}`);
  console.log(`  Trace directory: ${traceDir}`);
  if (staticDir) {
    console.log(`  Static directory: ${staticDir}`);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
