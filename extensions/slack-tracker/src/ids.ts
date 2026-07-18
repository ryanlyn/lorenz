/**
 * Split a `<channel>:<ts>` Slack issue id at the FIRST colon (the ts itself contains a dot,
 * never a colon). Returns `null` for anything that does not carry the separator. Lives in its
 * own module because both the client and the interaction handlers need it - the handlers must
 * not import the client (which imports them back).
 */
export function splitIssueId(id: string): [string, string] | null {
  const idx = id.indexOf(":");
  if (idx === -1) return null;
  return [id.slice(0, idx), id.slice(idx + 1)];
}
