import { checkAssertions } from "./assertions.js";
import { parseJsonScenario, type JsonScenarioDefinition } from "./paramspace.js";
import { runScenario, type SandboxResult } from "./scenario.js";

/** Serialize SandboxResult to a JSON-friendly format (errors -> strings). */
function serializeResult(result: SandboxResult): Record<string, unknown> {
  return {
    ticksExecuted: result.ticksExecuted,
    clientCallCount: result.clientCallCount,
    events: result.events,
    errors: result.errors.map((e) => ({ message: e.message })),
    finalSnapshot: result.finalSnapshot,
    snapshotCount: result.snapshots.length,
  };
}

export async function runSandboxCli(args = process.argv.slice(2)): Promise<void> {
  if (args.length === 0) {
    process.stderr.write("Usage: npx tsx demo/sandbox.ts <scenario-file.json>\n");
    process.stderr.write("       npx tsx demo/sandbox.ts --inline '<json>'\n");
    process.exit(1);
  }

  let rawJson: string;

  if (args[0] === "--inline") {
    if (!args[1]) {
      process.stderr.write("Error: --inline requires a JSON argument\n");
      process.exit(1);
    }
    rawJson = args[1];
    process.stderr.write("Running inline scenario...\n");
  } else {
    const filePath = args[0]!;
    const fs = await import("node:fs");
    const path = await import("node:path");

    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      process.stderr.write(`Error: file not found: ${resolved}\n`);
      process.exit(1);
    }

    try {
      rawJson = fs.readFileSync(resolved, "utf-8");
    } catch (err) {
      process.stderr.write(`Error reading file: ${err}\n`);
      process.exit(1);
    }
    process.stderr.write(`Running scenario from ${resolved}...\n`);
  }

  let scenarioDef: JsonScenarioDefinition;
  try {
    scenarioDef = JSON.parse(rawJson) as JsonScenarioDefinition;
  } catch (err) {
    process.stderr.write(`Error parsing JSON: ${err}\n`);
    process.exit(1);
  }

  const scenario = parseJsonScenario(scenarioDef);

  process.stderr.write(`  Issues: ${scenario.issues.length}, Ticks: ${scenario.pollTicks ?? 1}\n`);

  const result = await runScenario(scenario);

  const assertions = scenario.assertions ?? [];
  const assertionResults = assertions.length > 0 ? checkAssertions(result, assertions) : [];

  const allPassed = assertionResults.every((r) => r.passed);
  const output = {
    success: assertions.length === 0 || allPassed,
    result: serializeResult(result),
    assertions: assertionResults.map((r) => ({
      type: r.assertion.type,
      passed: r.passed,
      message: r.message,
    })),
  };

  process.stdout.write(JSON.stringify(output, null, 2) + "\n");

  if (!output.success) {
    const failCount = assertionResults.filter((r) => !r.passed).length;
    process.stderr.write(`FAILED: ${failCount}/${assertionResults.length} assertion(s) failed\n`);
    process.exit(1);
  } else {
    process.stderr.write(
      assertions.length > 0
        ? `PASSED: all ${assertionResults.length} assertion(s) passed\n`
        : `DONE: scenario completed (no assertions defined)\n`,
    );
    process.exit(0);
  }
}
