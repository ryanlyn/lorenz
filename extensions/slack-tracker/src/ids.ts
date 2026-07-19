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

/**
 * Compare Slack timestamps without converting them to floating-point numbers. Slack timestamps
 * carry microsecond precision, which a JavaScript number cannot preserve at current epoch values.
 */
export function compareSlackTs(left: string, right: string): number {
  const leftParts = slackTsParts(left);
  const rightParts = slackTsParts(right);
  if (!leftParts || !rightParts) {
    throw new Error(`invalid Slack timestamp: ${!leftParts ? left : right}`);
  }
  if (leftParts.integer.length !== rightParts.integer.length) {
    return leftParts.integer.length - rightParts.integer.length;
  }
  if (leftParts.integer !== rightParts.integer) {
    return leftParts.integer < rightParts.integer ? -1 : 1;
  }
  const width = Math.max(leftParts.fraction.length, rightParts.fraction.length);
  const leftFraction = leftParts.fraction.padEnd(width, "0");
  const rightFraction = rightParts.fraction.padEnd(width, "0");
  if (leftFraction === rightFraction) return 0;
  return leftFraction < rightFraction ? -1 : 1;
}

/** Whether a value has Slack's numeric message-timestamp shape. */
export function isSlackTs(value: string): boolean {
  return slackTsParts(value) !== null;
}

function slackTsParts(value: string): { integer: string; fraction: string } | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return null;
  const integer = match[1]!.replace(/^0+(?=\d)/, "");
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  return { integer, fraction };
}
