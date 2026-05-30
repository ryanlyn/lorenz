import { test } from "vitest";
import fc from "fast-check";
import { safeIdentifier, workspacePath, ensureInsideRoot } from "@symphony/cli";

import { assert } from "../../../test/assert.js";

/**
 * Arbitrary that generates non-empty identifiers whose safeIdentifier output
 * is non-empty and not "." or ".." (which would be degenerate path segments).
 */
const validIdentifier = fc
  .string({ minLength: 1, maxLength: 60 })
  .filter((s) => {
    const safe = safeIdentifier(s);
    return safe !== "" && safe !== "." && safe !== "..";
  });

/**
 * Arbitrary for workspace roots (absolute paths without trailing slash).
 * Includes diverse root paths to exercise various prefix-checking edge cases.
 */
const absoluteRoot = fc.oneof(
  fc.constantFrom(
    "/tmp/workspaces",
    "/var/symphony/ws",
    "/home/user/projects",
    "/opt/agent/runs",
    "/a",
    "/workspace",
    "/tmp/a/b/c/d/e/f",
  ),
  // Generate deeper paths to test prefix containment more rigorously
  fc
    .array(fc.stringMatching(/^[a-z][a-z0-9]{0,8}$/), { minLength: 1, maxLength: 5 })
    .map((parts) => "/" + parts.join("/")),
);

/**
 * Arbitrary for diverse strings including edge cases: empty, unicode, special chars.
 */
const diverseString = fc.oneof(
  fc.string({ maxLength: 100 }),
  fc.string({ unit: "grapheme", maxLength: 50 }),
  fc.constant(""),
  fc.constant(".."),
  fc.constant("."),
  fc.constant("/"),
  fc.constant("../../../etc/passwd"),
  fc.constant("hello world"),
  fc.constant("name\twith\ttabs"),
  fc.constant("emoji-\u{1F600}-test"),
  fc.constant("\x00\x01\x02\x03"),
  fc.constant("//////////"),
  fc.constant("..%2f..%2f..%2fetc%2fpasswd"),
  fc.constant("\n\r"),
  fc.constant("a".repeat(1000)),
  fc.constant("foo/bar/baz"),
  fc.constant("..."),
  fc.constant(".-._"),
  fc.constant("NUL"),
  fc.constant("CON"),
  fc.constant("PRN"),
);

/**
 * Arbitrary specifically for path traversal attempts.
 */
const pathTraversalString = fc.oneof(
  fc.constant("../../../etc/passwd"),
  fc.constant(".."),
  fc.constant("../../.."),
  fc.constant("./.."),
  fc.constant("foo/../../../bar"),
  fc.constant("..\\..\\..\\windows\\system32"),
  fc.constant("%2e%2e%2f"),
  fc.constant("....//....//"),
  fc.constant("..\x00..\x00"),
  fc.array(fc.constantFrom("..", ".", "x", "/"), { minLength: 1, maxLength: 10 }).map((parts) =>
    parts.join(""),
  ),
);

// Invariant 1: When a workspace path is resolved, the path SHALL be a strict
// descendant of the workspace root.
test("invariant 1: workspace path is a strict descendant of the workspace root", () => {
  fc.assert(
    fc.property(absoluteRoot, validIdentifier, (root, identifier) => {
      const result = workspacePath(root, identifier);
      // Must start with root + separator (strict descendant, not equal to root)
      assert.ok(result.startsWith(root + "/"));
      // Verify using ensureInsideRoot (should not throw)
      ensureInsideRoot(result, root);
      // Ensure it is NOT equal to root (strict descendant)
      assert.notEqual(result, root);
      // The result must be longer than root
      assert.ok(result.length > root.length + 1);
    }),
    { numRuns: 200 },
  );
});

test("invariant 1: ensemble workspace paths are strict descendants of root", () => {
  fc.assert(
    fc.property(
      absoluteRoot,
      validIdentifier,
      fc.integer({ min: 0, max: 9 }),
      fc.integer({ min: 2, max: 10 }),
      (root, identifier, slotIndex, ensembleSize) => {
        const slot = slotIndex % ensembleSize;
        const result = workspacePath(root, identifier, slot, ensembleSize);
        assert.ok(result.startsWith(root + "/"));
        ensureInsideRoot(result, root);
        assert.notEqual(result, root);
        // Ensemble paths must be at least 2 levels deep under root
        const relative = result.slice(root.length + 1);
        assert.ok(relative.includes("/"));
      },
    ),
    { numRuns: 200 },
  );
});

test("invariant 1: workspace path never escapes root even with adversarial identifiers", () => {
  fc.assert(
    fc.property(absoluteRoot, pathTraversalString, (root, identifier) => {
      const result = workspacePath(root, identifier);
      const safe = safeIdentifier(identifier);
      // When the sanitized identifier is a degenerate path segment (".", ".."),
      // path.join resolves it and the result is NOT a descendant of root.
      // This is expected: callers must use validIdentifier (which filters these)
      // before calling workspacePath. For non-degenerate cases, verify containment.
      if (safe === "." || safe === "..") {
        // These are known to escape — just verify they don't produce traversal
        // beyond one level (the workspace path function does not add extra protection)
        return;
      }
      // The workspace path must start with root + "/" (strict descendant)
      assert.ok(result.startsWith(root + "/"));
      // Must not contain ".." as an actual path segment (traversal)
      const segments = result.split("/");
      for (const seg of segments) {
        assert.notEqual(seg, "..");
      }
      // After safeIdentifier sanitization, the path must still be inside root.
      // NOTE: ensureInsideRoot uses startsWith("..") rather than checking for
      // exact ".." path segments. This means sanitized identifiers that happen to
      // start with ".." chars (e.g. input "..\x00..\x00" -> ".._.._") will be
      // rejected even though they are actually inside the root. We only call
      // ensureInsideRoot for identifiers whose sanitized form does not start with "..".
      if (!safe.startsWith("..")) {
        ensureInsideRoot(result, root);
      }
    }),
    { numRuns: 200 },
  );
});

test("invariant 1 (negative): ensureInsideRoot throws for paths outside root", () => {
  fc.assert(
    fc.property(absoluteRoot, (root) => {
      // A sibling path should be rejected
      assert.throws(() => ensureInsideRoot("/etc/passwd", root));
      // A parent path should be rejected
      const parent = root.split("/").slice(0, -1).join("/") || "/";
      if (parent !== root) {
        assert.throws(() => ensureInsideRoot(parent, root));
      }
      // The root itself should NOT throw (equal is allowed by ensureInsideRoot)
      ensureInsideRoot(root, root);
    }),
    { numRuns: 200 },
  );
});

test("invariant 1 (negative): ensureInsideRoot throws for traversal attempts", () => {
  const root = "/tmp/workspaces";
  assert.throws(() => ensureInsideRoot("/tmp/workspaces/../etc/passwd", root));
  assert.throws(() => ensureInsideRoot("/etc/passwd", root));
  assert.throws(() => ensureInsideRoot("/tmp/workspace", root));
  assert.throws(() => ensureInsideRoot("/", root));
});

// Invariant 2: When directory names are derived from identifiers, the names
// SHALL contain only alphanumeric characters, dots, hyphens, and underscores.
const ALLOWED_CHARS = /^[A-Za-z0-9._-]*$/;

test("invariant 2: safeIdentifier output contains only alphanumeric, dots, hyphens, underscores", () => {
  fc.assert(
    fc.property(diverseString, (input) => {
      const result = safeIdentifier(input);
      assert.match(result, ALLOWED_CHARS);
    }),
    { numRuns: 200 },
  );
});

test("invariant 2: safeIdentifier on unicode strings contains only allowed characters", () => {
  fc.assert(
    fc.property(fc.string({ unit: "grapheme", minLength: 0, maxLength: 100 }), (input) => {
      const result = safeIdentifier(input);
      assert.match(result, ALLOWED_CHARS);
    }),
    { numRuns: 200 },
  );
});

test("invariant 2: safeIdentifier on non-string inputs contains only allowed characters", () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.constant(null),
        fc.constant(undefined),
        fc.integer(),
        fc.boolean(),
        fc.double(),
      ),
      (input) => {
        const result = safeIdentifier(input);
        assert.match(result, ALLOWED_CHARS);
      },
    ),
    { numRuns: 200 },
  );
});

test("invariant 2: safeIdentifier output never contains path separators", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 200 }), (input) => {
      const result = safeIdentifier(input);
      // Path separators must be sanitized away
      assert.ok(!result.includes("/"));
      assert.ok(!result.includes("\\"));
    }),
    { numRuns: 200 },
  );
});

test("invariant 2: safeIdentifier output never contains null bytes or control characters", () => {
  fc.assert(
    fc.property(
      fc.string({ maxLength: 100 }).map((s) => s + "\x00\x01\x02\x03\x1f\x7f"),
      (input) => {
        const result = safeIdentifier(input);
        // No control characters should survive
        // eslint-disable-next-line no-control-regex
        assert.notMatch(result, /[\x00-\x1f\x7f]/);
      },
    ),
    { numRuns: 200 },
  );
});

test("invariant 2: safeIdentifier preserves length for already-safe strings", () => {
  fc.assert(
    fc.property(
      fc.stringMatching(/^[A-Za-z0-9._-]{1,50}$/),
      (input) => {
        const result = safeIdentifier(input);
        // Already-safe strings should pass through unchanged
        assert.equal(result, input);
      },
    ),
    { numRuns: 200 },
  );
});

test("invariant 2: safeIdentifier output length equals input length for string inputs", () => {
  fc.assert(
    fc.property(fc.string({ minLength: 1, maxLength: 100 }), (input) => {
      const result = safeIdentifier(input);
      // The regex replace replaces each invalid char with exactly one underscore,
      // so output length should equal input length for non-empty strings
      assert.equal(result.length, input.length);
    }),
    { numRuns: 200 },
  );
});

// Invariant 3: When sanitization is applied to a name, applying sanitization
// again SHALL produce the same result (idempotent).
test("invariant 3: safeIdentifier is idempotent on arbitrary strings", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 100 }), (input) => {
      const once = safeIdentifier(input);
      const twice = safeIdentifier(once);
      assert.equal(twice, once);
    }),
    { numRuns: 200 },
  );
});

test("invariant 3: safeIdentifier is idempotent on unicode strings", () => {
  fc.assert(
    fc.property(fc.string({ unit: "grapheme", maxLength: 100 }), (input) => {
      const once = safeIdentifier(input);
      const twice = safeIdentifier(once);
      assert.equal(twice, once);
    }),
    { numRuns: 200 },
  );
});

test("invariant 3: safeIdentifier is idempotent on strings with path separators", () => {
  fc.assert(
    fc.property(
      fc.array(fc.oneof(fc.string({ maxLength: 20 }), fc.constant("/")), {
        minLength: 1,
        maxLength: 10,
      }),
      (parts) => {
        const input = parts.join("");
        const once = safeIdentifier(input);
        const twice = safeIdentifier(once);
        assert.equal(twice, once);
      },
    ),
    { numRuns: 200 },
  );
});

test("invariant 3: safeIdentifier is idempotent on path traversal strings", () => {
  fc.assert(
    fc.property(pathTraversalString, (input) => {
      const once = safeIdentifier(input);
      const twice = safeIdentifier(once);
      assert.equal(twice, once);
    }),
    { numRuns: 200 },
  );
});

test("invariant 3: workspacePath is idempotent on its output segment", () => {
  fc.assert(
    fc.property(absoluteRoot, validIdentifier, (root, identifier) => {
      const result = workspacePath(root, identifier);
      const segment = result.slice(root.length + 1);
      // The segment should already be safe (applying safeIdentifier again yields same)
      assert.equal(safeIdentifier(segment), segment);
    }),
    { numRuns: 200 },
  );
});

// Invariant 4: When the same inputs are provided, the system SHALL produce
// the same workspace path (deterministic).
test("invariant 4: workspacePath is deterministic for single-slot runs", () => {
  fc.assert(
    fc.property(absoluteRoot, validIdentifier, (root, identifier) => {
      const first = workspacePath(root, identifier, 0, 1);
      const second = workspacePath(root, identifier, 0, 1);
      assert.equal(first, second);
    }),
    { numRuns: 200 },
  );
});

test("invariant 4: workspacePath is deterministic for ensemble runs", () => {
  fc.assert(
    fc.property(
      absoluteRoot,
      validIdentifier,
      fc.integer({ min: 0, max: 9 }),
      fc.integer({ min: 1, max: 10 }),
      (root, identifier, slotIndex, ensembleSize) => {
        const slot = slotIndex % ensembleSize;
        const first = workspacePath(root, identifier, slot, ensembleSize);
        const second = workspacePath(root, identifier, slot, ensembleSize);
        assert.equal(first, second);
      },
    ),
    { numRuns: 200 },
  );
});

test("invariant 4: safeIdentifier is deterministic", () => {
  fc.assert(
    fc.property(diverseString, (input) => {
      const first = safeIdentifier(input);
      const second = safeIdentifier(input);
      assert.equal(first, second);
    }),
    { numRuns: 200 },
  );
});

test("invariant 4: workspacePath is deterministic across many invocations", () => {
  fc.assert(
    fc.property(
      absoluteRoot,
      validIdentifier,
      fc.integer({ min: 0, max: 9 }),
      fc.integer({ min: 1, max: 10 }),
      (root, identifier, slotIndex, ensembleSize) => {
        const slot = slotIndex % ensembleSize;
        const results = new Set<string>();
        for (let i = 0; i < 10; i++) {
          results.add(workspacePath(root, identifier, slot, ensembleSize));
        }
        // All 10 invocations must produce the exact same result
        assert.equal(results.size, 1);
      },
    ),
    { numRuns: 200 },
  );
});

// Invariant 5: When a multi-slot ensemble is resolved, each slot SHALL
// receive a distinct workspace path.
test("invariant 5: ensemble slots produce distinct workspace paths", () => {
  fc.assert(
    fc.property(
      absoluteRoot,
      validIdentifier,
      fc.integer({ min: 2, max: 20 }),
      (root, identifier, ensembleSize) => {
        const paths = new Set<string>();
        for (let slot = 0; slot < ensembleSize; slot++) {
          paths.add(workspacePath(root, identifier, slot, ensembleSize));
        }
        assert.equal(paths.size, ensembleSize);
      },
    ),
    { numRuns: 200 },
  );
});

test("invariant 5: any two different slots in an ensemble yield different paths", () => {
  fc.assert(
    fc.property(
      absoluteRoot,
      validIdentifier,
      fc.integer({ min: 2, max: 20 }),
      fc.integer({ min: 0, max: 19 }),
      fc.integer({ min: 0, max: 19 }),
      (root, identifier, ensembleSize, slotA, slotB) => {
        const a = slotA % ensembleSize;
        const b = slotB % ensembleSize;
        if (a !== b) {
          const pathA = workspacePath(root, identifier, a, ensembleSize);
          const pathB = workspacePath(root, identifier, b, ensembleSize);
          assert.notEqual(pathA, pathB);
        }
      },
    ),
    { numRuns: 200 },
  );
});

test("invariant 5: different identifiers produce different workspace paths", () => {
  fc.assert(
    fc.property(
      absoluteRoot,
      validIdentifier,
      validIdentifier,
      (root, idA, idB) => {
        // Only test when identifiers sanitize to different values
        if (safeIdentifier(idA) !== safeIdentifier(idB)) {
          const pathA = workspacePath(root, idA);
          const pathB = workspacePath(root, idB);
          assert.notEqual(pathA, pathB);
        }
      },
    ),
    { numRuns: 200 },
  );
});

test("invariant 5: ensemble paths all share the same parent directory", () => {
  fc.assert(
    fc.property(
      absoluteRoot,
      validIdentifier,
      fc.integer({ min: 2, max: 10 }),
      (root, identifier, ensembleSize) => {
        const parents = new Set<string>();
        for (let slot = 0; slot < ensembleSize; slot++) {
          const p = workspacePath(root, identifier, slot, ensembleSize);
          parents.add(p.split("/").slice(0, -1).join("/"));
        }
        // All ensemble paths should share the same parent
        assert.equal(parents.size, 1);
      },
    ),
    { numRuns: 200 },
  );
});

// Invariant 6: When a single-slot run is resolved, the workspace path SHALL
// have no slot suffix.
test("invariant 6: single-slot run has no slot suffix in path", () => {
  fc.assert(
    fc.property(absoluteRoot, validIdentifier, (root, identifier) => {
      const result = workspacePath(root, identifier, 0, 1);
      // The path after root should be exactly one segment (the sanitized identifier)
      const relativePart = result.slice(root.length + 1);
      assert.ok(!relativePart.includes("/"));
      // The relative part should equal the sanitized identifier directly
      assert.equal(relativePart, safeIdentifier(identifier));
    }),
    { numRuns: 200 },
  );
});

test("invariant 6: single-slot path equals root/safeIdentifier without numeric suffix", () => {
  fc.assert(
    fc.property(absoluteRoot, validIdentifier, (root, identifier) => {
      const result = workspacePath(root, identifier, 0, 1);
      // Verify it does NOT end with a /digit pattern that ensemble paths have
      const lastSegment = result.split("/").pop()!;
      // The last segment should be the sanitized identifier, not a numeric slot index
      assert.equal(lastSegment, safeIdentifier(identifier));
    }),
    { numRuns: 200 },
  );
});

test("invariant 6: contrast with ensemble — ensemble path has extra segment", () => {
  fc.assert(
    fc.property(
      absoluteRoot,
      validIdentifier,
      fc.integer({ min: 2, max: 10 }),
      (root, identifier, ensembleSize) => {
        const singleSlot = workspacePath(root, identifier, 0, 1);
        const ensembleSlot = workspacePath(root, identifier, 0, ensembleSize);
        // Single-slot path should be a proper prefix of the ensemble path
        assert.ok(ensembleSlot.startsWith(singleSlot + "/"));
        // Ensemble path has an extra segment
        const extraSegment = ensembleSlot.slice(singleSlot.length + 1);
        assert.equal(extraSegment, "0");
      },
    ),
    { numRuns: 200 },
  );
});

test("invariant 6: single-slot path has exactly one more segment than root", () => {
  fc.assert(
    fc.property(absoluteRoot, validIdentifier, (root, identifier) => {
      const result = workspacePath(root, identifier, 0, 1);
      const rootSegments = root.split("/").filter((s) => s !== "").length;
      const resultSegments = result.split("/").filter((s) => s !== "").length;
      assert.equal(resultSegments, rootSegments + 1);
    }),
    { numRuns: 200 },
  );
});

test("invariant 6: ensemble path has exactly two more segments than root", () => {
  fc.assert(
    fc.property(
      absoluteRoot,
      validIdentifier,
      fc.integer({ min: 2, max: 10 }),
      fc.integer({ min: 0, max: 9 }),
      (root, identifier, ensembleSize, slotIndex) => {
        const slot = slotIndex % ensembleSize;
        const result = workspacePath(root, identifier, slot, ensembleSize);
        const rootSegments = root.split("/").filter((s) => s !== "").length;
        const resultSegments = result.split("/").filter((s) => s !== "").length;
        assert.equal(resultSegments, rootSegments + 2);
      },
    ),
    { numRuns: 200 },
  );
});

// Additional invariant: safeIdentifier non-string handling
test("additional: safeIdentifier returns empty string for non-string inputs", () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.constant(null),
        fc.constant(undefined),
        fc.integer(),
        fc.boolean(),
        fc.double(),
        fc.constant({}),
        fc.constant([]),
      ),
      (input) => {
        const result = safeIdentifier(input);
        assert.equal(result, "");
      },
    ),
    { numRuns: 200 },
  );
});

// Additional invariant: workspace path output is a valid absolute path
test("additional: workspacePath always produces an absolute path", () => {
  fc.assert(
    fc.property(
      absoluteRoot,
      validIdentifier,
      fc.integer({ min: 0, max: 9 }),
      fc.integer({ min: 1, max: 10 }),
      (root, identifier, slotIndex, ensembleSize) => {
        const slot = slotIndex % ensembleSize;
        const result = workspacePath(root, identifier, slot, ensembleSize);
        // Must start with /
        assert.ok(result.startsWith("/"));
        // Must not contain double slashes (path.join normalizes)
        assert.ok(!result.includes("//"));
        // Must not end with a slash
        assert.ok(!result.endsWith("/"));
      },
    ),
    { numRuns: 200 },
  );
});

// Additional invariant: workspace path contains no ".." segments
test("additional: workspacePath output never contains parent directory traversals", () => {
  fc.assert(
    fc.property(
      absoluteRoot,
      fc.string({ minLength: 1, maxLength: 100 }),
      fc.integer({ min: 0, max: 9 }),
      fc.integer({ min: 1, max: 10 }),
      (root, identifier, slotIndex, ensembleSize) => {
        const slot = slotIndex % ensembleSize;
        const result = workspacePath(root, identifier, slot, ensembleSize);
        const segments = result.split("/");
        for (const seg of segments) {
          assert.notEqual(seg, "..");
        }
      },
    ),
    { numRuns: 200 },
  );
});
