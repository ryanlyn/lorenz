import { execaSync } from "execa";
import { isRecord, registerDiagnosticSecret } from "@lorenz/domain";
import { resolveEnvReference } from "@lorenz/tracker-sdk";

import { nonEmptyString } from "./leaf-utils.js";

const DEFAULT_SECRET_RESOLUTION_TIMEOUT_MS = 30_000;
const SECRET_RESOLUTION_TIMEOUT_ENV = "LORENZ_SECRET_RESOLUTION_TIMEOUT_MS";
const SECRET_PROVIDER_ENV_KEYS = new Set([
  "HOME",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TMPDIR",
  "USER",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
]);

/**
 * Resolve one normalized config secret, including an optional provider-specific environment
 * fallback. Resolved provider values are registered at this boundary so later diagnostics can
 * redact them without callers handling the raw secret again.
 */
export function resolveConfiguredSecret(
  value: string | undefined,
  env: NodeJS.ProcessEnv,
  options: {
    fallbackEnvName?: string | undefined;
    register?: boolean | undefined;
  } = {},
): string | undefined {
  const fallback =
    options.fallbackEnvName === undefined
      ? undefined
      : nonEmptyString(env[options.fallbackEnvName]);
  const shouldRegister =
    options.register === true ||
    (value !== undefined && value.startsWith("op://")) ||
    (fallback !== undefined && fallback.startsWith("op://"));
  let secret: string | undefined;
  if (value === undefined) {
    secret = resolveOnePasswordRef(fallback, env);
  } else {
    const resolved = resolveEnvReference(value, env);
    const candidate = nonEmptyString(resolved) ?? fallback;
    secret = resolveOnePasswordRef(candidate, env);
  }
  if (shouldRegister) registerDiagnosticSecret(secret);
  return secret;
}

function resolveOnePasswordRef(
  value: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (value === undefined || !value.startsWith("op://")) return value;
  const providerEnv = secretProviderEnv(env);
  const timeout = secretResolutionTimeoutMs(env);
  try {
    const result = execaSync("op", ["read", value], {
      env: providerEnv,
      extendEnv: false,
      timeout,
    });
    return result.stdout.trim();
  } catch (error) {
    if (isTimeoutError(error)) {
      // eslint-disable-next-line preserve-caught-error -- Secret-boundary rethrows must not retain provider error objects.
      throw new Error(
        `Timed out resolving 1Password reference after ${timeout}ms; check 1Password CLI sign-in, network access, and vault permissions.`,
      );
    }
    if (isMissingExecutableError(error)) {
      // eslint-disable-next-line preserve-caught-error -- Secret-boundary rethrows must not retain provider error objects.
      throw new Error(
        "1Password CLI (op) is required to resolve op:// references but was not found. " +
          "Install it from https://developer.1password.com/docs/cli/get-started - it cannot be managed by mise.",
      );
    }
    // eslint-disable-next-line preserve-caught-error -- Secret-boundary rethrows must not retain provider error objects.
    throw new Error(
      "Failed to resolve 1Password reference; check the redacted op:// reference, vault access, and 1Password sign-in.",
    );
  }
}

function secretProviderEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const source of [process.env, env]) {
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined || !isSecretProviderEnvKey(key)) continue;
      out[key] = value;
    }
  }
  return out;
}

function isSecretProviderEnvKey(key: string): boolean {
  return SECRET_PROVIDER_ENV_KEYS.has(key) || key.startsWith("OP_");
}

function secretResolutionTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env[SECRET_RESOLUTION_TIMEOUT_ENV] ?? process.env[SECRET_RESOLUTION_TIMEOUT_ENV];
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_SECRET_RESOLUTION_TIMEOUT_MS;
}

function isTimeoutError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  return error.timedOut === true || error.code === "ETIMEDOUT";
}

function isMissingExecutableError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  return error.code === "ENOENT";
}
