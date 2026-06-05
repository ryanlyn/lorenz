#!/usr/bin/env node

const cliUrl = new URL("../dist/bin/cli.js", import.meta.url);

function isMissingBuiltCli(error) {
  return (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ERR_MODULE_NOT_FOUND" &&
    "url" in error &&
    error.url === cliUrl.href
  );
}

try {
  await import(cliUrl.href);
} catch (error) {
  if (!isMissingBuiltCli(error)) {
    throw error;
  }

  console.error("symphony-ts has not been built yet. Run `pnpm build` or `mise run build` first.");
  process.exitCode = 1;
}
