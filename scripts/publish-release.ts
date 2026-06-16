import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { stageRelease } from "./stage-release.ts";

const scriptPath = fileURLToPath(import.meta.url);

type PublishOptions = {
  version?: string;
  tag?: string;
  dryRun: boolean;
  help: boolean;
};

// Stages the self-contained CLI tree and publishes it to npm as the unscoped `lorenz` package. The
// staged root package.json already carries the published name, version, bin, and `publishConfig`
// (see writeRootPackageJson in stage-release.ts); this script only stages and hands the tree to
// `npm publish`. Authentication is left to the environment (`npm login` locally, an `.npmrc`
// authToken in CI) so no token ever passes through this process.
async function publishRelease(options: PublishOptions): Promise<void> {
  const { releaseDir, manifest } = await stageRelease({ force: true, version: options.version });

  const publishArgs = ["publish", "--access", "public"];
  if (options.tag) publishArgs.push("--tag", options.tag);
  if (options.dryRun) publishArgs.push("--dry-run");

  console.log(
    `Publishing lorenz@${manifest.version} from ${releaseDir}${options.dryRun ? " (dry run)" : ""}`,
  );

  await runNpm(publishArgs, releaseDir);
}

async function runNpm(args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("npm", args, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`npm ${args.join(" ")} exited with code ${code ?? "null"}.`));
    });
  });
}

function parseArgs(args: string[]): PublishOptions {
  const options: PublishOptions = { dryRun: false, help: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--":
        break;
      case "--version":
        options.version = requiredValue(args, ++index, arg);
        break;
      case "--tag":
        options.tag = requiredValue(args, ++index, arg);
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function printHelp(): void {
  console.log(`Usage: tsx scripts/publish-release.ts [options]

Stages the CLI release and publishes it to npm as the unscoped \`lorenz\` package.
Run \`pnpm build\` first; staging fails if build outputs are missing. Authenticate
with \`npm login\` (or an .npmrc authToken in CI) before publishing for real.

Options:
  --version <value>  Override the published version (defaults to @lorenz/cli's)
  --tag <name>       npm dist-tag to publish under (e.g. next)
  --dry-run          Run \`npm publish --dry-run\` without uploading
  --help             Show this help
`);
}

async function runCli(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  await publishRelease(options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  runCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
