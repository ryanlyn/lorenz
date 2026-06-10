export {
  sleep,
  makeIssue,
  makeSettings,
  makeDependencyChain,
  makePrioritySpread,
  makeHighTraffic,
} from "./fixtures.js";
export { ChaosLinearClient } from "./chaos-client.js";
export type { ChaosConfig } from "./chaos-client.js";
export { createFakeAgentRunner } from "./fake-runner.js";
export type { FakeRunnerConfig, FakeRunnerIssueBehavior } from "./fake-runner.js";
export { runScenario } from "./scenario.js";
export type {
  MutationDescriptor,
  SandboxResult,
  SandboxScenario,
  TimedMutation,
} from "./scenario.js";
export { checkAssertions } from "./assertions.js";
export type { Assertion, AssertionResult } from "./assertions.js";
export {
  crossProduct,
  randomSample,
  generateScenarioVariants,
  parseJsonScenario,
} from "./paramspace.js";
export type {
  JsonScenarioDefinition,
  ParamCombination,
  ParamSpace,
} from "./paramspace.js";

import { runSandboxCli } from "./cli.js";

const isDirectExecution =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("sandbox.ts") || process.argv[1].endsWith("sandbox.js"));

if (isDirectExecution) {
  runSandboxCli().catch((err) => {
    process.stderr.write(`Fatal error: ${err}\n`);
    process.exit(1);
  });
}
