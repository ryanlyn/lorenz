import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import { Command } from "commander";
import {
  commanderErrorMessage,
  configureCommandForMain,
  configureCommandForParse,
  hasHelpFlag,
  isCommanderHelp,
  type ParseResult,
} from "@lorenz/cli-kit";
import { parseConfig, validateDispatchConfig } from "@lorenz/config";
import { defaultAgentExecutorRegistry } from "@lorenz/agent-sdk";
import { defaultToolRegistry } from "@lorenz/tool-sdk";
import { defaultTrackerRegistry } from "@lorenz/tracker-sdk";
import {
  parseWorkflowContent,
  renderWorkflowContent,
  workflowFilePath,
  writeWorkflowFile,
} from "@lorenz/workflow";
import { errorMessage } from "@lorenz/domain";
import { shellEscape } from "@lorenz/ssh";

import { registerBuiltinBackends } from "./daemon.js";

type ConfigTrackerKind = "jira" | "linear" | "local" | "slack";
type ConfigAgentKind = "claude" | "codex";

export interface ConfigOptions {
  workflowPath: string | null;
  force: boolean;
}

export interface ConfigCommanderOptions {
  force?: boolean;
}

export type ConfigParseResult = ParseResult<ConfigOptions>;

export interface ConfigChoice {
  value: string;
  label: string;
}

export interface ConfigInputOptions {
  defaultValue?: string | undefined;
  required?: boolean | undefined;
}

export interface ConfigPrompter {
  select(question: string, choices: readonly ConfigChoice[], defaultValue: string): Promise<string>;
  input(question: string, options?: ConfigInputOptions): Promise<string>;
  message(message: string): void;
  close(): void;
}

interface TextWriter {
  write(value: string): unknown;
}

export interface ConfigCommandDependencies {
  prompter?: ConfigPrompter | undefined;
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  stdout?: TextWriter | undefined;
  stderr?: TextWriter | undefined;
}

interface JiraOnboarding {
  kind: "jira";
  baseUrl: string;
  email: string;
  apiKey: string;
  projectKeys: string[];
}

interface LinearOnboarding {
  kind: "linear";
  apiKey: string;
  projectSlugs: string[];
}

interface LocalOnboarding {
  kind: "local";
  boardPath: string;
  idPrefix: string;
}

interface SlackOnboarding {
  kind: "slack";
  apiKey: string;
  botUserId: string;
  channels: string[];
}

type TrackerOnboarding = JiraOnboarding | LinearOnboarding | LocalOnboarding | SlackOnboarding;

export interface OnboardingAnswers {
  tracker: TrackerOnboarding;
  agent: ConfigAgentKind;
}

const trackerChoices: readonly ConfigChoice[] = [
  { value: "jira", label: "Jira" },
  { value: "linear", label: "Linear" },
  { value: "local", label: "Local Markdown board" },
  { value: "slack", label: "Slack" },
];

const agentChoices: readonly ConfigChoice[] = [
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
];

const initialWorkflowPrompt = `You are working on {{ issue.identifier }}: {{ issue.title }}.

{% if issue.description %}
{{ issue.description }}
{% else %}
No description provided.
{% endif %}

Use the available tracker tools to keep the issue status and progress up to date.
Work autonomously until the issue is complete or you are truly blocked.
`;

export function parseConfigArgs(args: string[]): ConfigParseResult {
  const command = configureCommandForParse(createConfigCommand("lorenz-config"));
  if (hasHelpFlag(args)) return { status: "help", message: command.helpInformation().trimEnd() };

  try {
    command.parse(args, { from: "user" });
  } catch (error) {
    return { status: "error", message: commanderErrorMessage(error) };
  }

  return {
    status: "ok",
    options: configOptionsFromCommanderOptions(command.opts(), command.args[0]),
  };
}

export function createConfigCommand(name = "config"): Command {
  return new Command(name)
    .description("Interactively create a Lorenz workflow.")
    .allowExcessArguments(false)
    .argument("[workflowPath]", "Workflow markdown file.")
    .option("-f, --force", "Overwrite an existing workflow.");
}

export function configOptionsFromCommanderOptions(
  parsed: ConfigCommanderOptions,
  workflowPath?: string,
): ConfigOptions {
  return {
    workflowPath: workflowPath ?? null,
    force: parsed.force ?? false,
  };
}

export async function configMain(args = process.argv.slice(2)): Promise<number> {
  let status = 0;
  const command = configureCommandForMain(createConfigCommand("lorenz-config"));
  command.action(async (workflowPath: string | undefined, parsed: ConfigCommanderOptions) => {
    status = await runConfigCommand(configOptionsFromCommanderOptions(parsed, workflowPath));
  });

  try {
    await command.parseAsync(args, { from: "user" });
    return status;
  } catch (error) {
    if (isCommanderHelp(error)) return 0;
    process.stderr.write(`${commanderErrorMessage(error)}\n`);
    return 1;
  }
}

export async function runConfigCommand(
  options: ConfigOptions,
  dependencies: ConfigCommandDependencies = {},
): Promise<number> {
  registerBuiltinBackends();
  const cwd = dependencies.cwd ?? process.cwd();
  const env = dependencies.env ?? process.env;
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const target = path.resolve(options.workflowPath ?? workflowFilePath(env, cwd));
  let prompter = dependencies.prompter;

  try {
    if (!prompter) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error(
          "Lorenz config requires an interactive terminal; run it from a TTY to create a workflow",
        );
      }
      prompter = createTerminalPrompter();
    }

    if (!options.force && (await fileExists(target))) {
      throw new Error(`workflow file already exists: ${target}; pass --force to replace it`);
    }

    prompter.message("Configure Lorenz. Press Enter to accept the Jira and Claude defaults.");
    const answers = await collectOnboardingAnswers(prompter);
    const config = buildInitialWorkflowConfig(answers);
    validateGeneratedWorkflow(config, env);
    await writeWorkflowFile(target, config, initialWorkflowPrompt, { force: options.force });

    stdout.write(`Created ${target}\n`);
    stdout.write(`Tracker: ${answers.tracker.kind} | Agent: ${answers.agent}\n`);
    stdout.write(`Validate: lorenz doctor ${shellEscape(target)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${errorMessage(error)}\n`);
    return 1;
  } finally {
    prompter?.close();
  }
}

async function collectOnboardingAnswers(prompter: ConfigPrompter): Promise<OnboardingAnswers> {
  const trackerKind = (await prompter.select(
    "Which tracker should Lorenz use?",
    trackerChoices,
    "jira",
  )) as ConfigTrackerKind;
  const agent = (await prompter.select(
    "Which coding agent should Lorenz run?",
    agentChoices,
    "claude",
  )) as ConfigAgentKind;
  const tracker = await collectTrackerAnswers(prompter, trackerKind);
  return { tracker, agent };
}

export function buildInitialWorkflowConfig(answers: OnboardingAnswers): Record<string, unknown> {
  const tracker = trackerConfig(answers.tracker);
  const config: Record<string, unknown> = {
    tracker: {
      kind: answers.tracker.kind,
      active_states: tracker.activeStates,
      terminal_states: tracker.terminalStates,
    },
    trackers: {
      [answers.tracker.kind]: tracker.provider,
    },
    agent: {
      kind: answers.agent,
    },
  };

  if (answers.tracker.kind === "slack") {
    config.polling = { interval_ms: 60_000 };
  }
  return config;
}

function validateGeneratedWorkflow(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const rendered = renderWorkflowContent(config, initialWorkflowPrompt);
  const parsed = parseWorkflowContent(rendered);
  const validationConfig = configForValidation(parsed.config);
  const settings = parseConfig(validationConfig, validationEnvironment(validationConfig, env));
  validateDispatchConfig(
    settings,
    defaultTrackerRegistry,
    defaultAgentExecutorRegistry,
    defaultToolRegistry,
  );
}

function createTerminalPrompter(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): ConfigPrompter {
  const readline = createInterface({ input, output });

  return {
    async select(question, choices, defaultValue) {
      output.write(`\n${question}\n`);
      choices.forEach((choice, index) => {
        const marker = choice.value === defaultValue ? " (default)" : "";
        output.write(`  ${index + 1}) ${choice.label}${marker}\n`);
      });
      const defaultIndex = choices.findIndex((choice) => choice.value === defaultValue) + 1;

      for (;;) {
        const answer = (await readline.question(`Select [${defaultIndex}]: `)).trim();
        if (answer === "") return defaultValue;
        const numeric = Number(answer);
        if (Number.isInteger(numeric) && numeric >= 1 && numeric <= choices.length) {
          return choices[numeric - 1]!.value;
        }
        const normalized = answer.toLowerCase();
        const choice = choices.find(
          (candidate) =>
            candidate.value.toLowerCase() === normalized ||
            candidate.label.toLowerCase() === normalized,
        );
        if (choice) return choice.value;
        output.write("Choose one of the listed options.\n");
      }
    },
    async input(question, options = {}) {
      const defaultValue = options.defaultValue ?? "";
      const suffix = defaultValue === "" ? "" : ` [${defaultValue}]`;
      for (;;) {
        const answer = (await readline.question(`${question}${suffix}: `)).trim();
        const value = answer === "" ? defaultValue : answer;
        if (!options.required || value !== "") return value;
        output.write("A value is required.\n");
      }
    },
    message(message) {
      output.write(`${message}\n`);
    },
    close() {
      readline.close();
    },
  };
}

async function collectTrackerAnswers(
  prompter: ConfigPrompter,
  kind: ConfigTrackerKind,
): Promise<TrackerOnboarding> {
  switch (kind) {
    case "jira":
      return {
        kind,
        baseUrl: await prompter.input("Jira base URL or environment reference", {
          defaultValue: "$JIRA_BASE_URL",
          required: true,
        }),
        email: await prompter.input("Jira account email or environment reference", {
          defaultValue: "$JIRA_EMAIL",
          required: true,
        }),
        apiKey: await collectSecretReference(prompter, "Jira API token", "$JIRA_API_KEY"),
        projectKeys: await collectList(prompter, "Jira project keys (comma-separated)"),
      };
    case "linear":
      return {
        kind,
        apiKey: await collectSecretReference(prompter, "Linear API key", "$LINEAR_API_KEY"),
        projectSlugs: await collectList(prompter, "Linear project slugs (comma-separated)"),
      };
    case "local":
      return {
        kind,
        boardPath: await prompter.input("Local board directory", {
          defaultValue: ".lorenz/local",
          required: true,
        }),
        idPrefix: await prompter.input("Issue id prefix", {
          defaultValue: "BOARD-",
          required: true,
        }),
      };
    case "slack":
      return {
        kind,
        apiKey: await collectSecretReference(prompter, "Slack bot token", "$SLACK_BOT_TOKEN"),
        botUserId: await prompter.input("Slack bot user id reference", {
          defaultValue: "$SLACK_BOT_USER_ID",
          required: true,
        }),
        channels: await collectList(prompter, "Slack channel ids (comma-separated)"),
      };
  }
}

async function collectSecretReference(
  prompter: ConfigPrompter,
  label: string,
  defaultValue: string,
): Promise<string> {
  for (;;) {
    const value = await prompter.input(`${label} secret reference`, {
      defaultValue,
      required: true,
    });
    if (isSecretReference(value)) return value;
    prompter.message(
      `Enter a secret reference such as ${defaultValue} or op://vault/item/field; literal secrets are not stored.`,
    );
  }
}

async function collectList(prompter: ConfigPrompter, question: string): Promise<string[]> {
  for (;;) {
    const value = await prompter.input(question, { required: true });
    const values = [
      ...new Set(
        value
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry !== ""),
      ),
    ];
    if (values.length > 0) return values;
    prompter.message("Enter at least one value.");
  }
}

function trackerConfig(tracker: TrackerOnboarding): {
  provider: Record<string, unknown>;
  activeStates: string[];
  terminalStates: string[];
} {
  switch (tracker.kind) {
    case "jira":
      return {
        provider: {
          provider: "jira",
          base_url: tracker.baseUrl,
          email: tracker.email,
          api_key: tracker.apiKey,
          project_keys: tracker.projectKeys,
        },
        activeStates: ["To Do", "In Progress"],
        terminalStates: ["Done", "Closed", "Cancelled", "Canceled"],
      };
    case "linear":
      return {
        provider: {
          provider: "linear",
          api_key: tracker.apiKey,
          project_slugs: tracker.projectSlugs,
        },
        activeStates: ["Todo", "In Progress"],
        terminalStates: ["Done", "Closed", "Cancelled", "Canceled", "Duplicate"],
      };
    case "local":
      return {
        provider: {
          provider: "local",
          path: tracker.boardPath,
          id_prefix: tracker.idPrefix,
        },
        activeStates: ["Todo", "In Progress"],
        terminalStates: ["Done", "Cancelled"],
      };
    case "slack":
      return {
        provider: {
          provider: "slack",
          api_key: tracker.apiKey,
          bot_user_id: tracker.botUserId,
          channels: tracker.channels,
        },
        activeStates: ["Todo", "In Progress"],
        terminalStates: ["Done", "Cancelled"],
      };
  }
}

function validationEnvironment(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const next = { ...env };
  visitStrings(config, (value) => {
    const match = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
    if (match && !next[match[1]!]) next[match[1]!] = "configured-for-validation";
  });
  return next;
}

function configForValidation(config: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(config).map(([key, value]) => [key, valueForValidation(value)]),
  );
}

function valueForValidation(value: unknown): unknown {
  if (typeof value === "string") {
    return isOnePasswordReference(value) ? "configured-for-validation" : value;
  }
  if (Array.isArray(value)) return value.map(valueForValidation);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, valueForValidation(entry)]),
    );
  }
  return value;
}

function isSecretReference(value: string): boolean {
  return /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value) || isOnePasswordReference(value);
}

function isOnePasswordReference(value: string): boolean {
  return value.startsWith("op://");
}

function visitStrings(value: unknown, visit: (value: string) => void): void {
  if (typeof value === "string") {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => visitStrings(entry, visit));
    return;
  }
  if (typeof value === "object" && value !== null) {
    Object.values(value).forEach((entry) => visitStrings(entry, visit));
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
