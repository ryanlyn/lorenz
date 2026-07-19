import type { Command } from "commander";
import { InvalidArgumentError } from "commander";

export type ParseResult<T> =
  | { status: "ok"; options: T }
  | { status: "help"; message: string }
  | { status: "error"; message: string };

export function configureCommandForParse(command: Command): Command {
  return command.exitOverride().configureOutput({
    writeErr: () => undefined,
    writeOut: () => undefined,
    outputError: () => undefined,
  });
}

export function configureCommandForMain(command: Command): Command {
  return command.exitOverride().configureOutput({
    writeOut: (value) => process.stdout.write(value),
    writeErr: () => undefined,
    outputError: () => undefined,
  });
}

export function hasHelpFlag(args: string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

export function parseNonNegativeInteger(option: string): (value: string) => number {
  return (value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0)
      throw new InvalidArgumentError(`${option} must be a non-negative integer`);
    return parsed;
  };
}

export function parsePositiveInteger(option: string): (value: string) => number {
  return (value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0)
      throw new InvalidArgumentError(`${option} must be a positive integer`);
    return parsed;
  };
}

export function parseRequiredValue(option: string, label = "value"): (value: string) => string {
  return (value) => {
    if (!value || value.trim() === "")
      throw new InvalidArgumentError(`${option} requires a ${label}`);
    return value;
  };
}

export function commanderErrorMessage(error: unknown): string {
  const code = commanderErrorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  if (code === "commander.unknownOption") {
    const option = /unknown option '([^']+)'/.exec(message)?.[1];
    return `Unknown option: ${option ?? message}`;
  }
  if (code === "commander.optionMissingArgument") {
    const option = /option '([^' <]+)/.exec(message)?.[1];
    if (option === "--limit") return "--limit must be a positive integer";
    if (option === "--port") return "--port must be a non-negative integer";
    if (option === "--logs-root") return "--logs-root requires a path";
    if (option) return `${option} requires a value`;
  }
  if (code === "commander.invalidArgument") return message.split(". ").at(-1) ?? message;
  return message;
}

export function isCommanderHelp(error: unknown): boolean {
  return commanderErrorCode(error) === "commander.helpDisplayed";
}

function commanderErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}
