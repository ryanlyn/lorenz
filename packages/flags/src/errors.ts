import type { z } from "zod";

import { featureKeys, flagKeys } from "./keys.js";
import type { FlagDef, FlagIssue, FlagManifest } from "./types.js";

/** Accumulates problems across every layer so one resolve reports them all at once. */
export class FlagIssueCollector {
  private readonly issues: FlagIssue[] = [];

  add(issue: FlagIssue): void {
    this.issues.push(issue);
  }

  addAll(issues: readonly FlagIssue[]): void {
    for (const issue of issues) this.issues.push(issue);
  }

  get isEmpty(): boolean {
    return this.issues.length === 0;
  }

  list(): readonly FlagIssue[] {
    return this.issues;
  }

  throwIfAny(): void {
    if (this.issues.length > 0) throw new Error(formatFlagIssues(this.issues));
  }
}

function formatFlagIssues(issues: readonly FlagIssue[]): string {
  const header =
    issues.length === 1 ? "lorenz flags: 1 problem:" : `lorenz flags: ${issues.length} problems:`;
  return `${header}\n${issues.map((issue) => `  - ${issue.message}`).join("\n")}`;
}

export function unknownFlagError(
  sourceLabel: string,
  key: string,
  manifest: FlagManifest,
): FlagIssue {
  return {
    kind: "unknown_flag",
    message: `${sourceLabel} sets unknown flag \`${key}\` (known flags: ${flagKeys(manifest).join(", ")})`,
  };
}

export function unknownFeatureError(
  sourceLabel: string,
  name: string,
  manifest: FlagManifest,
): FlagIssue {
  return {
    kind: "unknown_feature",
    message: `${sourceLabel} sets unknown feature \`${name}\` (known features: ${featureKeys(manifest).join(", ")})`,
  };
}

/**
 * Map a Zod validation error for one flag value to friendly text. The message is keyed off the
 * flag's `kind` rather than the raw Zod issue, because the coercion unions (`numericInput`,
 * `coercedBoolean`) surface as `invalid_union` issues whose default wording is unhelpful, and enum
 * allowed-values come from the manifest (`def.values`) rather than a Zod-internal field. A `custom`
 * refine failure (e.g. a per-flag bound) keeps its own message so callers can express constraints.
 */
export function flagValueErrorMessage(error: z.ZodError, def: FlagDef): string {
  const first = error.issues[0];
  switch (def.kind) {
    case "int":
      return first?.code === "custom" ? first.message : "must be an integer";
    case "float":
      return first?.code === "custom" ? first.message : "must be a number";
    case "bool":
      return "must be true or false";
    case "enum":
      return `must be one of: ${(def.values ?? []).join(", ")}`;
    default:
      return first ? first.message : "is invalid";
  }
}
