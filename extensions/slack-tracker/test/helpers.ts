import { parseConfig } from "@lorenz/config";
import type { Settings } from "@lorenz/domain";
import { TrackerRegistry } from "@lorenz/tracker-sdk";

import { slackTrackerProvider } from "@lorenz/slack-tracker";

// Private registry: slack options in the tracker config section are normalized by the
// registered provider during parsing, exactly as the CLI composition root wires it.
export const slackTrackers = new TrackerRegistry();
slackTrackers.register(slackTrackerProvider);

export function parseSlackConfig(
  raw: Record<string, unknown>,
  env: NodeJS.ProcessEnv = {},
): Settings {
  return parseConfig(raw, env, {}, slackTrackers);
}
