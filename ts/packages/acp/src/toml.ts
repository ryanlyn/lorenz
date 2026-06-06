import { isRecord } from "@symphony/domain";

export function toToml(obj: Record<string, unknown>, prefix = ""): string {
  const lines: string[] = [];
  const sections: [string, Record<string, unknown>][] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    if (isRecord(value)) {
      sections.push([prefix ? `${prefix}.${key}` : key, value]);
    } else {
      lines.push(`${key} = ${toTomlValue(value)}`);
    }
  }
  for (const [section, nested] of sections) {
    lines.push(`\n[${section}]`);
    lines.push(toToml(nested, section).trim());
  }
  return lines.join("\n") + "\n";
}

function toTomlValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map(toTomlValue).join(", ")}]`;
  return JSON.stringify(value);
}
