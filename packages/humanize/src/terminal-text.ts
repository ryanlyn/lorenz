const escapeCharacter = String.fromCharCode(27);
const asciiControlCharacters = `${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}`;
const ANSI_CONTROL_SEQUENCE = new RegExp(`${escapeCharacter}\\[[0-9;]*[A-Za-z]`, "g");
const ANSI_ESCAPE_SEQUENCE = new RegExp(`${escapeCharacter}.`, "g");
const ASCII_CONTROL_CHARACTER = new RegExp(`[${asciiControlCharacters}]`, "g");

export function stripAnsiSequences(value: string): string {
  return value.replace(ANSI_CONTROL_SEQUENCE, "").replace(ANSI_ESCAPE_SEQUENCE, "");
}

export function sanitizeTerminalText(value: string): string {
  return stripAnsiSequences(value).replace(ASCII_CONTROL_CHARACTER, "").trim();
}

export function truncateTerminalText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 3))}...` : value;
}
