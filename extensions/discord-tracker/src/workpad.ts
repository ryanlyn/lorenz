import type { Settings } from "@lorenz/domain";

import { interactiveStatuses, statusButtonId } from "./interactions.js";
import type { DiscordWorkpad } from "./transport.js";

export const DISCORD_COMPONENTS_V2_FLAG = 1 << 15;
export const DISCORD_WORKPAD_ACCENT = 0x5865f2;
const MAX_SECTION_CHUNKS = 3;

export interface DiscordComponentsV2Message {
  flags: number;
  components: Array<Record<string, unknown>>;
  allowed_mentions: { parse: [] };
}

export function workpadMessage(
  settings: Settings,
  workpad: DiscordWorkpad,
): DiscordComponentsV2Message {
  const children: Array<Record<string, unknown>> = [
    textDisplay(`# Workpad\n-# Environment: ${inlineCode(workpad.environment)}`),
  ];
  appendSection(children, "Plan", numbered(workpad.plan));
  appendSection(children, "Acceptance criteria", bullets(workpad.acceptanceCriteria));
  appendSection(children, "Validation", codeBlock(workpad.validationCommands));
  appendSection(children, "Progress", bullets(workpad.progress));

  const buttons = interactiveStatuses(settings).map((action) => ({
    type: 2,
    style: action.style,
    label: action.label,
    emoji: { name: action.emoji },
    custom_id: statusButtonId(action.status),
  }));
  if (buttons.length > 0) {
    children.push({ type: 14, divider: true, spacing: 1 });
    children.push({ type: 1, components: buttons });
  }

  return {
    flags: DISCORD_COMPONENTS_V2_FLAG,
    components: [
      {
        type: 17,
        accent_color: DISCORD_WORKPAD_ACCENT,
        components: children,
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

function appendSection(
  children: Array<Record<string, unknown>>,
  title: string,
  content: string,
): void {
  if (!content) return;
  children.push({ type: 14, divider: true, spacing: 1 });
  for (const chunk of markdownChunks(`### ${title}\n${content}`, 3800).slice(
    0,
    MAX_SECTION_CHUNKS,
  )) {
    children.push(textDisplay(chunk));
  }
}

function textDisplay(content: string): Record<string, unknown> {
  return { type: 10, content };
}

function numbered(items: string[]): string {
  return items.map((item, index) => `${index + 1}. ${clean(item)}`).join("\n");
}

function bullets(items: string[]): string {
  return items.map((item) => `- ${clean(item)}`).join("\n");
}

function codeBlock(commands: string[]): string {
  if (commands.length === 0) return "";
  return `\`\`\`sh\n${commands.map((command) => clean(command).replaceAll("```", "'''")).join("\n")}\n\`\`\``;
}

function inlineCode(value: string): string {
  return `\`${clean(value).replaceAll("`", "'")}\``;
}

function clean(value: string): string {
  return value.trim().replaceAll("\u0000", "");
}

function markdownChunks(text: string, limit: number): string[] {
  const points = Array.from(text);
  if (points.length <= limit) return [text];
  const chunks: string[] = [];
  let offset = 0;
  while (offset < points.length) {
    const end = Math.min(points.length, offset + limit);
    chunks.push(points.slice(offset, end).join(""));
    offset = end;
  }
  return chunks;
}
