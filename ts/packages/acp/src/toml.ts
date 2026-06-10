import { isRecord } from "@symphony/domain";

export function toToml(obj: Record<string, unknown>, prefix = ""): string {
  return toTomlLines(obj, prefix ? prefix.split(".") : []).join("\n") + "\n";
}

function toTomlLines(obj: Record<string, unknown>, prefix: string[]): string[] {
  const lines: string[] = [];
  const sections: [string[], Record<string, unknown>][] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    if (isRecord(value)) {
      sections.push([[...prefix, key], value]);
    } else {
      lines.push(`${toTomlKey(key)} = ${toTomlValue(value)}`);
    }
  }
  for (const [section, nested] of sections) {
    lines.push(`\n[${section.map(toTomlKey).join(".")}]`);
    lines.push(...toTomlLines(nested, section));
  }
  return lines;
}

function toTomlKey(key: string): string {
  if (/[\r\n]/u.test(key)) throw new Error("TOML key cannot contain newline");
  if (hasControlCharacter(key)) {
    throw new Error("TOML key cannot contain control characters");
  }
  if (/^[A-Za-z0-9_-]+$/u.test(key)) return key;
  return JSON.stringify(key);
}

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function toTomlValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map(toTomlValue).join(", ")}]`;
  return JSON.stringify(value);
}
