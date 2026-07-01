import { test, describe } from "vitest";
import fc from "fast-check";
import { PORT_MAX } from "@lorenz/domain";
import { assert } from "@lorenz/test-utils";

import { shellEscape, sshArgs, remoteShellCommand, parseSshTarget } from "@lorenz/ssh";

// --- Helper arbitraries ---

/** Arbitrary strings that include shell-dangerous characters. */
const shellDangerousString = fc.oneof(
  fc.string(),
  fc.constantFrom(
    "",
    " ",
    "'",
    '"',
    "`",
    "$",
    "$(rm -rf /)",
    "; rm -rf /",
    "' ; echo pwned '",
    "\n",
    "\t",
    "hello world",
    "foo'bar",
    'foo"bar',
    "a`id`b",
    "${HOME}",
    "$(whoami)",
    "a\nb\nc",
    "\x00",
    "''''",
    "'\"'\"'",
    "\\",
    "\\\\",
    "\\n",
    "\\t",
    "\\x00",
    "$((1+1))",
    "$(cat /etc/passwd)",
    "`cat /etc/passwd`",
    "foo\x01bar",
    "foo\x1bbar",
    "\r\n",
    "a".repeat(1000),
    "'".repeat(50),
    "$'\\x41'",
    "!$_",
    "{a,b,c}",
    "~root",
    "../../../etc/passwd",
    "foo bar\tbaz\nqux",
  ),
  // Unicode strings including multi-byte, combining chars, RTL
  fc.string({ minLength: 0, maxLength: 100, unit: "grapheme" }),
  // Strings with many consecutive single quotes (stress the escape mechanism)
  fc
    .array(fc.constantFrom("'", "a", " ", '"', "$", "`"), { minLength: 0, maxLength: 50 })
    .map((arr) => arr.join("")),
  // String with only control characters
  fc
    .array(
      fc.integer({ min: 0, max: 31 }).map((n) => String.fromCharCode(n)),
      { minLength: 1, maxLength: 20 },
    )
    .map((arr) => arr.join("")),
);

/** Arbitrary that generates valid SSH usernames (alphanumeric, dots, hyphens, underscores). */
const sshUsername = fc.stringMatching(/^[a-z][a-z0-9._-]{0,15}$/);

/** Arbitrary that generates valid hostnames (labels separated by dots). */
const sshHostname = fc.oneof(
  // Simple hostname
  fc.stringMatching(/^[a-z][a-z0-9-]{0,10}$/),
  // FQDN with dots
  fc
    .tuple(
      fc.stringMatching(/^[a-z][a-z0-9-]{0,8}$/),
      fc.stringMatching(/^[a-z][a-z0-9-]{0,6}$/),
      fc.constantFrom("com", "org", "net", "io", "dev", "internal"),
    )
    .map(([sub, domain, tld]) => `${sub}.${domain}.${tld}`),
  // IPv4
  fc
    .tuple(
      fc.integer({ min: 1, max: 255 }),
      fc.integer({ min: 0, max: 255 }),
      fc.integer({ min: 0, max: 255 }),
      fc.integer({ min: 1, max: 254 }),
    )
    .map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`),
);

/** Arbitrary that generates bracketed IPv6 addresses. */
const bracketedIpv6 = fc.oneof(
  fc.constantFrom("[::1]", "[fe80::1]", "[2001:db8::1]", "[::ffff:192.168.1.1]"),
  fc
    .tuple(
      fc.integer({ min: 0, max: 0xffff }),
      fc.integer({ min: 0, max: 0xffff }),
      fc.integer({ min: 0, max: 0xffff }),
      fc.integer({ min: 0, max: 0xffff }),
    )
    .map(
      ([a, b, c, d]) =>
        `[${a.toString(16)}:${b.toString(16)}::${c.toString(16)}:${d.toString(16)}]`,
    ),
);

/** Arbitrary SSH destination (user@host, host, user@[ipv6]). */
const sshDestination = fc.oneof(
  // bare hostname
  sshHostname,
  // user@hostname
  fc.tuple(sshUsername, sshHostname).map(([user, host]) => `${user}@${host}`),
  // bracketed IPv6
  bracketedIpv6,
  // user@[ipv6]
  fc.tuple(sshUsername, bracketedIpv6).map(([user, ipv6]) => `${user}@${ipv6}`),
);

/** Arbitrary valid port number. */
const sshPort = fc.integer({ min: 1, max: PORT_MAX });

/** Arbitrary SSH target string (destination with optional port). */
const sshTargetWithPort = fc
  .tuple(sshDestination, sshPort)
  .map(([dest, port]) => `${dest}:${port}`);

const sshTargetWithoutPort = sshDestination;

const sshTargetAny = fc.oneof(sshTargetWithPort, sshTargetWithoutPort);

describe("INVARIANT: When shellEscape is applied, the output SHALL be reversible to the original input by a POSIX shell", () => {
  test("shellEscape wraps value in single quotes preventing unquoted shell metacharacters", () => {
    fc.assert(
      fc.property(shellDangerousString, (input) => {
        const escaped = shellEscape(input);
        // The escaped output must start and end with single quotes
        assert.equal(escaped[0], "'");
        assert.equal(escaped[escaped.length - 1], "'");
        // The interior (between outer quotes) must not contain an unescaped single quote.
        // The only valid pattern for a single quote inside is: '"'"'
        // So if we remove all occurrences of '"'"' from the interior, no single quotes should remain.
        const interior = escaped.slice(1, -1);
        const sanitized = interior.replaceAll("'\"'\"'", "");
        assert.equal(sanitized.includes("'"), false);
      }),
      { numRuns: 500 },
    );
  });

  test("shellEscape roundtrip - the escape is reversible to recover the original input", () => {
    fc.assert(
      fc.property(shellDangerousString, (input) => {
        const escaped = shellEscape(input);
        // The escaped value, when evaluated by a POSIX shell as a single token,
        // should reconstruct the original string. We verify structurally:
        // The escape scheme is: wrap in single quotes, replace each ' with '"'"'
        // So the reverse is: strip outer quotes, replace '"'"' with '
        const interior = escaped.slice(1, -1);
        const recovered = interior.replaceAll("'\"'\"'", "'");
        assert.equal(recovered, input);
      }),
      { numRuns: 500 },
    );
  });

  test("remoteShellCommand wraps the command in bash -lc with proper escaping", () => {
    fc.assert(
      fc.property(shellDangerousString, (command) => {
        const result = remoteShellCommand(command);
        // Result must start with "bash -lc "
        assert.equal(result.startsWith("bash -lc "), true);
        // The argument after "bash -lc " must be the shellEscape'd command
        const afterPrefix = result.slice("bash -lc ".length);
        assert.equal(afterPrefix, shellEscape(command));
      }),
      { numRuns: 500 },
    );
  });

  test("sshArgs includes the shell-escaped command as the final argument", () => {
    fc.assert(
      fc.property(sshTargetAny, shellDangerousString, (host, command) => {
        const args = sshArgs(host, command, process.env);
        // The last argument should be the remoteShellCommand result
        const lastArg = args[args.length - 1];
        assert.equal(lastArg, remoteShellCommand(command));
        // And that must contain the shell-escaped command
        assert.equal(lastArg!.includes(shellEscape(command)), true);
      }),
      { numRuns: 500 },
    );
  });

  test("sshArgs always contains -T flag for non-interactive mode", () => {
    fc.assert(
      fc.property(sshTargetAny, shellDangerousString, (host, command) => {
        const args = sshArgs(host, command, process.env);
        assert.equal(args.includes("-T"), true);
      }),
      { numRuns: 500 },
    );
  });

  test("negative: shellEscape output never contains unbalanced quotes", () => {
    fc.assert(
      fc.property(shellDangerousString, (input) => {
        const escaped = shellEscape(input);
        // Count single quotes - they should always be balanced
        // The structure is: '<content with '"'"' replacements>'
        // Remove the known escape pattern '"'"' and count remaining quotes
        const withoutEscapePattern = escaped.replaceAll(`'"'"'`, "");
        const singleQuoteCount = (withoutEscapePattern.match(/'/g) || []).length;
        // Should be exactly 2 (the outer wrapping quotes)
        assert.equal(singleQuoteCount, 2);
      }),
      { numRuns: 500 },
    );
  });
});

describe("INVARIANT: When an SSH target is parsed, destination and port SHALL be correctly separated", () => {
  test("parseSshTarget roundtrip - destination:port recombines correctly", () => {
    fc.assert(
      fc.property(sshDestination, sshPort, (dest, port) => {
        const input = `${dest}:${port}`;
        const result = parseSshTarget(input);
        // The destination and port should be correctly extracted
        assert.equal(result.destination, dest);
        assert.equal(result.port, String(port));
      }),
      { numRuns: 500 },
    );
  });

  test("parseSshTarget with no port returns null port and preserves destination", () => {
    fc.assert(
      fc.property(sshDestination, (host) => {
        const result = parseSshTarget(host);
        assert.equal(result.port, null);
        assert.equal(result.destination, host);
      }),
      { numRuns: 500 },
    );
  });

  test("parseSshTarget trims whitespace from input", () => {
    fc.assert(
      fc.property(
        sshTargetAny,
        fc.stringMatching(/^[ \t]{1,5}$/),
        fc.stringMatching(/^[ \t]{1,5}$/),
        (host, prefix, suffix) => {
          const padded = prefix + host + suffix;
          const resultPadded = parseSshTarget(padded);
          const resultClean = parseSshTarget(host.trim());
          assert.deepEqual(resultPadded, resultClean);
        },
      ),
      { numRuns: 500 },
    );
  });

  test("parseSshTarget with bracketed IPv6 and port", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          bracketedIpv6,
          fc.tuple(sshUsername, bracketedIpv6).map(([user, ipv6]) => `${user}@${ipv6}`),
        ),
        sshPort,
        (dest, port) => {
          const input = `${dest}:${port}`;
          const result = parseSshTarget(input);
          assert.equal(result.destination, dest);
          assert.equal(result.port, String(port));
        },
      ),
      { numRuns: 500 },
    );
  });

  test("parseSshTarget bare IPv6 (unbracketed with colons) does not extract port", () => {
    // Bare IPv6 addresses contain colons but without brackets, so parsing as host:port is ambiguous.
    // The parser should treat the whole thing as destination.
    fc.assert(
      fc.property(
        fc
          .tuple(
            fc.integer({ min: 0, max: 0xffff }),
            fc.integer({ min: 0, max: 0xffff }),
            fc.integer({ min: 0, max: 0xffff }),
            fc.integer({ min: 1, max: PORT_MAX }),
          )
          .map(
            ([a, b, c, port]) => `${a.toString(16)}:${b.toString(16)}::${c.toString(16)}:${port}`,
          ),
        (input) => {
          const result = parseSshTarget(input);
          // Should treat the whole thing as destination since it's ambiguous
          assert.equal(result.port, null);
          assert.equal(result.destination, input);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("INVARIANT: When sshArgs constructs arguments, they SHALL be consistent with parseSshTarget output", () => {
  test("sshArgs uses parseSshTarget destination as the host argument", () => {
    fc.assert(
      fc.property(sshTargetAny, shellDangerousString, (host, command) => {
        const args = sshArgs(host, command, process.env);
        const target = parseSshTarget(host);
        // The destination must appear in the args (as the ssh target)
        assert.equal(args.includes(target.destination), true);
      }),
      { numRuns: 500 },
    );
  });

  test("sshArgs port argument matches parseSshTarget port when present", () => {
    fc.assert(
      fc.property(sshTargetAny, shellDangerousString, (host, command) => {
        const args = sshArgs(host, command, process.env);
        const target = parseSshTarget(host);
        const portFlagIndex = args.indexOf("-p");
        if (target.port !== null) {
          // If parseSshTarget finds a port, sshArgs must include -p with that port
          assert.equal(portFlagIndex >= 0, true);
          assert.equal(args[portFlagIndex + 1], target.port);
        } else {
          // If no port, -p must be absent
          assert.equal(portFlagIndex, -1);
        }
      }),
      { numRuns: 500 },
    );
  });
});
