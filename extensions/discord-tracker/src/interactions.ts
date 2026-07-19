import type { Settings } from "@lorenz/domain";

import { inProgressState, resolveStateName } from "./threadState.js";
import type { DiscordApplicationCommand, DiscordInteraction } from "./transport.js";

export const DISCORD_TRACK_MESSAGE_COMMAND = "Track with Lorenz";
export const DISCORD_STATUS_COMPONENT_PREFIX = "lorenz:status:";
export const DISCORD_STATUS_SELECT_ID = "lorenz:status";

export type DiscordInteractionAction =
  | { kind: "status"; status: string }
  | { kind: "track"; messageId: string };

export function discordApplicationCommands(settings: Settings): DiscordApplicationCommand[] {
  const states = uniqueStates(settings);
  const commands: DiscordApplicationCommand[] = [
    {
      type: 1,
      name: "status",
      description: "Set this Lorenz issue's workflow status",
      options: [
        {
          type: 3,
          name: "state",
          description: "The new workflow status",
          required: true,
          choices: states.slice(0, 25).map((state) => ({ name: state, value: state })),
        },
      ],
    },
    { type: 3, name: DISCORD_TRACK_MESSAGE_COMMAND },
  ];

  for (const alias of statusAliases(settings)) {
    commands.push({
      type: 1,
      name: alias.name,
      description: alias.description,
    });
  }
  return commands;
}

export function interactionAction(
  interaction: DiscordInteraction,
  settings: Settings,
): DiscordInteractionAction | null {
  if (interaction.type === "component") {
    const requested =
      interaction.customId === DISCORD_STATUS_SELECT_ID
        ? interaction.componentValues?.[0]
        : interaction.customId?.startsWith(DISCORD_STATUS_COMPONENT_PREFIX)
          ? safeDecode(interaction.customId.slice(DISCORD_STATUS_COMPONENT_PREFIX.length))
          : undefined;
    const status = requested ? resolveStateName(requested, settings) : null;
    return status ? { kind: "status", status } : null;
  }

  if (interaction.commandName === DISCORD_TRACK_MESSAGE_COMMAND && interaction.targetId) {
    return { kind: "track", messageId: interaction.targetId };
  }
  if (interaction.commandName === "status") {
    const state = interaction.commandOptions?.state;
    const status = state ? resolveStateName(state, settings) : null;
    return status ? { kind: "status", status } : null;
  }
  const alias = statusAliases(settings).find(
    (candidate) => candidate.name === interaction.commandName,
  );
  return alias ? { kind: "status", status: alias.status } : null;
}

export function statusButtonId(status: string): string {
  return `${DISCORD_STATUS_COMPONENT_PREFIX}${encodeURIComponent(status)}`.slice(0, 100);
}

export function interactiveStatuses(settings: Settings): string[] {
  return uniqueStates(settings).slice(0, 25);
}

function statusAliases(settings: Settings): Array<{
  name: string;
  status: string;
  description: string;
}> {
  const out: Array<{ name: string; status: string; description: string }> = [];
  const add = (name: "start" | "done" | "cancel", description: string): void => {
    const status = workflowStatus(name, settings);
    if (status) out.push({ name, status, description });
  };
  add("done", "Mark this Lorenz issue as done");
  add("cancel", "Cancel this Lorenz issue");
  const reopen = settings.tracker.activeStates[0];
  if (reopen) {
    out.push({ name: "reopen", status: reopen, description: "Reopen this Lorenz issue" });
  }
  add("start", "Mark this Lorenz issue as in progress");
  return out;
}

function workflowStatus(action: "start" | "done" | "cancel", settings: Settings): string | null {
  if (action === "start") {
    return inProgressState(settings);
  }
  if (action === "done") {
    return resolveStateName("Done", settings) ?? settings.tracker.terminalStates[0] ?? null;
  }
  const explicit =
    resolveStateName("Cancelled", settings) ?? resolveStateName("Canceled", settings);
  if (explicit) return explicit;
  const done = workflowStatus("done", settings);
  return (
    settings.tracker.terminalStates.find((status) => status !== done) ??
    settings.tracker.terminalStates[0] ??
    null
  );
}

function uniqueStates(settings: Settings): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const state of [...settings.tracker.activeStates, ...settings.tracker.terminalStates]) {
    const key = state.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(state);
  }
  return out;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}
