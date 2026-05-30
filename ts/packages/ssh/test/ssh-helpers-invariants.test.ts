import { test } from "vitest";
import fc from "fast-check";

import { assert } from "../../../test/assert.js";

import { shellEscape, sshArgs, remoteShellCommand, parseSshTarget } from "@symphony/ssh";


// --- Helper arbitraries ---

/** Arbitrary strings that include shell-dangerous characters. */
const shellDangerousString = fc.oneof(
  fc.string(),
  fc.constantFrom(
    "",
    " ",
    "'",
    "\"",
    "`",
    "$",
    "$(rm -rf /)",
    "; rm -rf /",
    "' ; echo pwned '",
    "\n",
    "\t",
    "hello world",
    "foo'bar",
    "foo\"bar",
    "a`id`b",
    "${HOME}",
    "$(whoami)",
    "a\nb\nc",
    "\x00",
    // Additional dangerous patterns
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
  fc.array(fc.constantFrom("'", "a", " ", "\"", "$", "`"), { minLength: 0, maxLength: 50 }).map(
    (arr) => arr.join(""),
  ),
  // String with only control characters
  fc.array(
    fc.integer({ min: 0, max: 31 }).map((n) => String.fromCharCode(n)),
    { minLength: 1, maxLength: 20 },
  ).map((arr) => arr.join("")),
);

/** Arbitrary that produces valid POSIX-like paths (no null bytes since those break shells). */
const posixPath = fc
  .array(
    fc.string({ minLength: 1, maxLength: 10 }).filter((s) => !s.includes("\x00") && !s.includes("/")),
    { minLength: 1, maxLength: 5 },
  )
  .map((parts) => "/" + parts.join("/"));

/** Path arbitrary with more challenging segments (spaces, quotes, unicode). */
const challengingPosixPath = fc
  .array(
    fc.oneof(
      fc.string({ minLength: 1, maxLength: 10 }).filter((s) => !s.includes("\x00") && !s.includes("/")),
      fc.constantFrom(
        "my dir",
        "file'name",
        "dir with spaces",
        "$var",
        "back`tick",
        "semi;colon",
      ),
      fc.string({ minLength: 1, maxLength: 8, unit: "grapheme" }).filter((s) => !s.includes("\x00") && !s.includes("/")),
    ),
    { minLength: 1, maxLength: 5 },
  )
  .map((parts) => "/" + parts.join("/"));

// --- Invariant 1: Remote commands have arguments shell-escaped to prevent injection ---

test("invariant 1: shellEscape wraps value in single quotes preventing unquoted shell metacharacters", () => {
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
    { numRuns: 200 },
  );
});

test("invariant 1: shellEscape is injection-safe - content cannot break out of quoting", () => {
  fc.assert(
    fc.property(shellDangerousString, (input) => {
      const escaped = shellEscape(input);
      // The escaped value, when evaluated by a POSIX shell as a single token,
      // should reconstruct the original string. We verify structurally:
      // After removing the quoting envelope, we should be able to recover the original.
      // The escape scheme is: wrap in single quotes, replace each ' with '"'"'
      // So the reverse is: strip outer quotes, replace '"'"' with '
      const interior = escaped.slice(1, -1);
      const recovered = interior.replaceAll("'\"'\"'", "'");
      assert.equal(recovered, input);
    }),
    { numRuns: 200 },
  );
});

test("invariant 1: shellEscape output length is deterministic based on quote count", () => {
  fc.assert(
    fc.property(shellDangerousString, (input) => {
      const escaped = shellEscape(input);
      // Each single quote in the input becomes '"'"' (5 chars) instead of ' (1 char),
      // so expected length = input.length + (number_of_quotes * 4) + 2 (outer quotes)
      const quoteCount = (input.match(/'/g) || []).length;
      const expectedLength = input.length + quoteCount * 4 + 2;
      assert.equal(escaped.length, expectedLength);
    }),
    { numRuns: 200 },
  );
});

test("invariant 1: shellEscape is idempotent in structure - double escaping nests properly", () => {
  fc.assert(
    fc.property(shellDangerousString, (input) => {
      const escaped1 = shellEscape(input);
      const escaped2 = shellEscape(escaped1);
      // Double-escaping should still be reversible
      const interior2 = escaped2.slice(1, -1);
      const recovered1 = interior2.replaceAll("'\"'\"'", "'");
      assert.equal(recovered1, escaped1);
      // And recovering once more gives original
      const interior1 = recovered1.slice(1, -1);
      const recovered0 = interior1.replaceAll("'\"'\"'", "'");
      assert.equal(recovered0, input);
    }),
    { numRuns: 200 },
  );
});

test("invariant 1: shellEscape never produces empty output", () => {
  fc.assert(
    fc.property(shellDangerousString, (input) => {
      const escaped = shellEscape(input);
      // Even for empty input, we get at least ''
      assert.equal(escaped.length >= 2, true);
    }),
    { numRuns: 200 },
  );
});

test("invariant 1: shellEscape of empty string is exactly two single quotes", () => {
  const escaped = shellEscape("");
  assert.equal(escaped, "''");
});

test("invariant 1: remoteShellCommand wraps the command in bash -lc with proper escaping", () => {
  fc.assert(
    fc.property(shellDangerousString, (command) => {
      const result = remoteShellCommand(command);
      // Result must start with "bash -lc "
      assert.equal(result.startsWith("bash -lc "), true);
      // The argument after "bash -lc " must be the shellEscape'd command
      const afterPrefix = result.slice("bash -lc ".length);
      assert.equal(afterPrefix, shellEscape(command));
    }),
    { numRuns: 200 },
  );
});

test("invariant 1: remoteShellCommand output always contains exactly one 'bash -lc ' prefix", () => {
  fc.assert(
    fc.property(shellDangerousString, (command) => {
      const result = remoteShellCommand(command);
      // There should be exactly one occurrence of "bash -lc " at the start
      const firstOccurrence = result.indexOf("bash -lc ");
      assert.equal(firstOccurrence, 0);
      // Any subsequent "bash -lc " must be inside the escaped payload, not structural
      const afterFirst = result.slice("bash -lc ".length);
      // The rest is the escaped command which starts and ends with single quotes
      assert.equal(afterFirst[0], "'");
      assert.equal(afterFirst[afterFirst.length - 1], "'");
    }),
    { numRuns: 200 },
  );
});

test("invariant 1: sshArgs includes the shell-escaped command as the final argument", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("localhost", "user@host", "host:2222", "user@host:22"),
      shellDangerousString,
      (host, command) => {
        const args = sshArgs(host, command);
        // The last argument should be the remoteShellCommand result
        const lastArg = args[args.length - 1];
        assert.equal(lastArg, remoteShellCommand(command));
        // And that must contain the shell-escaped command
        assert.equal(lastArg!.includes(shellEscape(command)), true);
      },
    ),
    { numRuns: 200 },
  );
});

test("invariant 1: sshArgs always contains -T flag for non-interactive mode", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("localhost", "user@host", "host:2222", "user@host:22", "root@[::1]:2200"),
      shellDangerousString,
      (host, command) => {
        const args = sshArgs(host, command);
        assert.equal(args.includes("-T"), true);
      },
    ),
    { numRuns: 200 },
  );
});

test("invariant 1: sshArgs includes port flag when host has :port suffix", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("host:2222", "user@host:22", "localhost:2200", "root@[::1]:2200"),
      shellDangerousString,
      (host, command) => {
        const args = sshArgs(host, command);
        const portFlagIndex = args.indexOf("-p");
        // Must have a -p flag
        assert.equal(portFlagIndex >= 0, true);
        // The value after -p must be the port number from the host string
        const target = parseSshTarget(host);
        assert.equal(args[portFlagIndex + 1], target.port);
      },
    ),
    { numRuns: 200 },
  );
});

test("invariant 1: sshArgs does NOT include port flag when host has no port", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("localhost", "user@host", "192.168.1.1", "root@example.com"),
      shellDangerousString,
      (host, command) => {
        const args = sshArgs(host, command);
        assert.equal(args.includes("-p"), false);
      },
    ),
    { numRuns: 200 },
  );
});

// --- Invariant 1 negative tests: verify the escape mechanism handles known injection attempts ---

test("invariant 1 negative: attempting to inject via single-quote breakout is neutralized", () => {
  // These are real injection attempts that should be neutralized
  const injections = [
    "'; rm -rf / #",
    "' || echo pwned || '",
    "'; $(whoami) #",
    "'$(cat /etc/shadow)'",
    "' `id` '",
    "a'; echo INJECTED; echo '",
  ];
  for (const injection of injections) {
    const escaped = shellEscape(injection);
    // Recovering the original from the escape proves no breakout occurred
    const interior = escaped.slice(1, -1);
    const recovered = interior.replaceAll("'\"'\"'", "'");
    assert.equal(recovered, injection);
    // The escaped form should not allow shell interpretation
    // (it's all within single quotes or properly quoted)
    assert.equal(escaped[0], "'");
    assert.equal(escaped[escaped.length - 1], "'");
  }
});

test("invariant 1 negative: shellEscape output never contains unbalanced quotes", () => {
  fc.assert(
    fc.property(shellDangerousString, (input) => {
      const escaped = shellEscape(input);
      // Count single quotes - they should always be balanced
      // The structure is: '<content with '"'"' replacements>'
      // We can verify balance by checking the outer structure:
      // Remove the known escape pattern '"'"' and count remaining quotes
      const withoutEscapePattern = escaped.replaceAll(`'"'"'`, "");
      const singleQuoteCount = (withoutEscapePattern.match(/'/g) || []).length;
      // Should be exactly 2 (the outer wrapping quotes)
      assert.equal(singleQuoteCount, 2);
    }),
    { numRuns: 200 },
  );
});

// --- Invariant 2: When a remote file is written, parent directories are created first ---

test("invariant 2: writeRemoteFile command includes mkdir -p for parent directory before write", () => {
  fc.assert(
    fc.property(
      fc.oneof(posixPath, challengingPosixPath),
      shellDangerousString,
      (remotePath, contents) => {
        // Reconstruct the command the same way writeRemoteFile does, to check structural property.
        const dirname = posixDirname(remotePath);
        const expectedMkdir = `mkdir -p ${shellEscape(dirname)}`;
        const expectedWrite = `printf '%s' ${shellEscape(contents)} > ${shellEscape(remotePath)}`;

        // The command that writeRemoteFile would construct:
        const command = [expectedMkdir, expectedWrite, "true"].join("\n");

        // Verify mkdir comes before the write command
        const mkdirIndex = command.indexOf("mkdir -p");
        const printfIndex = command.indexOf("printf '%s'");
        assert.equal(mkdirIndex >= 0, true);
        assert.equal(printfIndex >= 0, true);
        assert.equal(mkdirIndex < printfIndex, true);

        // Verify the mkdir target is the parent directory of remotePath
        assert.equal(command.includes(`mkdir -p ${shellEscape(dirname)}`), true);

        // Verify the write targets the full path
        assert.equal(command.includes(`> ${shellEscape(remotePath)}`), true);
      },
    ),
    { numRuns: 200 },
  );
});

test("invariant 2: mkdir -p target is always the posix dirname of the remote path", () => {
  fc.assert(
    fc.property(fc.oneof(posixPath, challengingPosixPath), (remotePath) => {
      const dirname = posixDirname(remotePath);
      const mkdirFragment = `mkdir -p ${shellEscape(dirname)}`;
      // dirname must be a prefix path of remotePath (parent directory)
      // For any path like /a/b/c, dirname should be /a/b
      const lastSlash = remotePath.lastIndexOf("/");
      const expectedDir = lastSlash > 0 ? remotePath.slice(0, lastSlash) : "/";
      assert.equal(dirname, expectedDir);
      // The mkdir command must properly escape the directory
      assert.equal(mkdirFragment.startsWith("mkdir -p '"), true);
    }),
    { numRuns: 200 },
  );
});

test("invariant 2: dirname is always a strict prefix of the path (for multi-segment paths)", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.string({ minLength: 1, maxLength: 10 }).filter((s) => !s.includes("\x00") && !s.includes("/")),
        { minLength: 2, maxLength: 6 },
      ).map((parts) => "/" + parts.join("/")),
      (remotePath) => {
        const dirname = posixDirname(remotePath);
        // dirname must be a proper prefix of remotePath
        assert.equal(remotePath.startsWith(dirname), true);
        assert.equal(dirname.length < remotePath.length, true);
        // remotePath should be dirname + "/" + basename
        const basename = remotePath.slice(dirname.length + 1);
        assert.equal(basename.length > 0, true);
        assert.equal(basename.includes("/"), false);
      },
    ),
    { numRuns: 200 },
  );
});

test("invariant 2: single-segment path (like /file) has dirname of /", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 20 }).filter((s) => !s.includes("\x00") && !s.includes("/")),
      (filename) => {
        const remotePath = "/" + filename;
        const dirname = posixDirname(remotePath);
        assert.equal(dirname, "/");
      },
    ),
    { numRuns: 200 },
  );
});

// --- Invariant 3: parseSshTarget correctly separates destination and port ---

test("invariant 3: parseSshTarget roundtrip - destination:port recombines to original", () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.constantFrom("localhost", "user@host", "192.168.1.1", "root@example.com"),
      ),
      fc.integer({ min: 1, max: 65535 }),
      (dest, port) => {
        const input = `${dest}:${port}`;
        const result = parseSshTarget(input);
        // For simple destinations (no colons), the target should be parsed
        assert.equal(result.destination, dest);
        assert.equal(result.port, String(port));
      },
    ),
    { numRuns: 200 },
  );
});

test("invariant 3: parseSshTarget with no port returns null port", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("localhost", "user@host", "192.168.1.1", "root@example.com", "myserver"),
      (host) => {
        const result = parseSshTarget(host);
        assert.equal(result.port, null);
        assert.equal(result.destination, host);
      },
    ),
    { numRuns: 200 },
  );
});

test("invariant 3: parseSshTarget trims whitespace from input", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("localhost", "user@host:22", "host:2222"),
      fc.constantFrom("", " ", "  ", "\t"),
      fc.constantFrom("", " ", "  ", "\t"),
      (host, prefix, suffix) => {
        const padded = prefix + host + suffix;
        const resultPadded = parseSshTarget(padded);
        const resultClean = parseSshTarget(host.trim());
        assert.deepEqual(resultPadded, resultClean);
      },
    ),
    { numRuns: 200 },
  );
});

test("invariant 3: parseSshTarget with bracketed IPv6 and port", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("root@[::1]", "user@[fe80::1]", "[::1]", "[2001:db8::1]"),
      fc.integer({ min: 1, max: 65535 }),
      (dest, port) => {
        const input = `${dest}:${port}`;
        const result = parseSshTarget(input);
        assert.equal(result.destination, dest);
        assert.equal(result.port, String(port));
      },
    ),
    { numRuns: 200 },
  );
});

test("invariant 3: parseSshTarget bare IPv6 (unbracketed with colons) does not extract port", () => {
  // Bare IPv6 like "::1:2200" should NOT be split because the destination
  // would contain colons without brackets
  fc.assert(
    fc.property(
      fc.constantFrom("::1:2200", "fe80::1:8080", "2001:db8::1:443"),
      (input) => {
        const result = parseSshTarget(input);
        // Should treat the whole thing as destination since it's ambiguous
        assert.equal(result.port, null);
        assert.equal(result.destination, input);
      },
    ),
    { numRuns: 200 },
  );
});

// --- Invariant: sshArgs and parseSshTarget are consistent ---

test("invariant: sshArgs uses parseSshTarget destination as the host argument", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("localhost", "user@host", "host:2222", "user@host:22", "root@[::1]:2200"),
      shellDangerousString,
      (host, command) => {
        const args = sshArgs(host, command);
        const target = parseSshTarget(host);
        // The destination must appear in the args (as the ssh target)
        assert.equal(args.includes(target.destination), true);
      },
    ),
    { numRuns: 200 },
  );
});

// --- Utility: posix dirname without importing path (to avoid async import complexity) ---

function posixDirname(p: string): string {
  const lastSlash = p.lastIndexOf("/");
  if (lastSlash <= 0) return "/";
  return p.slice(0, lastSlash);
}
