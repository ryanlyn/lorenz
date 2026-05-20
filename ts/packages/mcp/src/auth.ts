import { randomBytes } from "node:crypto";

const activeTokens = new Set<string>();

export function issueMcpToken(): string {
  const token = randomBytes(32).toString("base64url");
  activeTokens.add(token);
  return token;
}

export function revokeMcpToken(token: string | null | undefined): void {
  if (token) activeTokens.delete(token);
}

export function validMcpToken(token: string | null | undefined): boolean {
  return typeof token === "string" && activeTokens.has(token);
}
