import { test } from "vitest";
import fc from "fast-check";
import { safeIdentifier, workspacePath, ensureInsideRoot } from "@symphony/cli";

import { assert } from "../../../test/assert.js";

/**
 * Arbitrary that generates non-empty identifiers whose safeIdentifier output
 * is non-empty and not "." or ".." (which would be degenerate path segments).
 */
const validIdentifier = fc.string({ minLength: 1, maxLength: 60 }).filter((s) => {
  const safe = safeIdentifier(s);
  return safe !== "" && safe !== "." && safe !== "..";
});

/**
 * Arbitrary for workspace roots (absolute paths).
 * Includes diverse root paths to exercise various prefix-checking edge cases,
 * including trailing slashes, paths with spaces, and varied depth.
 * workspacePath uses path.join which normalizes, so double-slashes and trailing
 * slashes in the root are handled transparently.
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
    "/tmp/workspaces/",
    "/home/user/my projects",
    "/tmp/path with spaces/ws",
  ),
  // Generate deeper paths to test prefix containment more rigorously
  fc
    .array(fc.stringMatching(/^[a-z][a-z0-9]{0,8}$/), { minLength: 1, maxLength: 5 })
    .map((parts) => "/" + parts.join("/")),
  // Roots with trailing slashes
  fc
    .array(fc.stringMatching(/^[a-z][a-z0-9]{0,6}$/), { minLength: 1, maxLength: 4 })
    .map((parts) => "/" + parts.join("/") + "/"),
  // Roots with spaces in segments
  fc
    .array(fc.stringMatching(/^[a-z][a-z0-9 ]{0,8}$/), { minLength: 1, maxLength: 3 })
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
  fc
    .array(fc.constantFrom("..", ".", "x", "/"), { minLength: 1, maxLength: 10 })
    .map((parts) => parts.join("")),
);

/**
 * Helper: get the effective root prefix as it appears in workspacePath output.
 * path.join(root, segment) strips trailing slashes from root when joining,
 * so the effective prefix is root without trailing slashes.
 */
function effectivePrefix(root: string): string {
  const stripped = root.replace(/\/+$/, "");
  return stripped || "/";
}

// INVARIANT: When a workspace path is resolved, it SHALL be a strict descendant of the workspace root.
test("workspace path is a strict descendant of the workspace root", () => {
  fc.assert(
    fc.property(absoluteRoot, validIdentifier, (root, identifier) => {
      const result = workspacePath(root, identifier);
      const prefix = effectivePrefix(root);
      // Must start with effective root + separator (strict descendant)
      assert.ok(result.startsWith(prefix + "/"));
      // Verify using ensureInsideRoot (should not throw for valid identifiers
      // whose sanitized form does not start with "..")
      const safe = safeIdentifier(identifier);
      if (!safe.startsWith("..")) {
        ensureInsideRoot(result, root);
      }
      // Ensure result is NOT equal to the effective root (strict descendant)
      assert.notEqual(result, prefix);
      // The result must be longer than the effective root + separator
      assert.ok(result.length > prefix.length + 1);
    }),
    { numRuns: 500 },
  );
});

test("ensemble workspace paths are strict descendants of root", () => {
  fc.assert(
    fc.property(
      absoluteRoot,
      validIdentifier,
      fc.integer({ min: 0, max: 9 }),
      fc.integer({ min: 2, max: 10 }),
      (root, identifier, slotIndex, ensembleSize) => {
        const slot = slotIndex % ensembleSize;
        const result = workspacePath(root, identifier, slot, ensembleSize);
        const prefix = effectivePrefix(root);
        assert.ok(result.startsWith(prefix + "/"));
        const safe = safeIdentifier(identifier);
        if (!safe.startsWith("..")) {
          ensureInsideRoot(result, root);
        }
        assert.notEqual(result, prefix);
        // Ensemble paths must be at least 2 levels deep under root
        const relative = result.slice(prefix.length + 1);
        assert.ok(relative.includes("/"));
      },
    ),
    { numRuns: 500 },
  );
});

test("adversarial identifiers that sanitize to degenerate values are caught by validation", () => {
  // Tests that the security boundary works: when safeIdentifier produces
  // degenerate outputs (".", ".."), either the path collapses to root (which
  // callers must reject), or ensureInsideRoot rejects traversal attempts.
  fc.assert(
    fc.property(absoluteRoot, pathTraversalString, (root, identifier) => {
      const safe = safeIdentifier(identifier);
      const result = workspacePath(root, identifier);
      const prefix = effectivePrefix(root);

      if (safe === "..") {
        // ".." causes path.join to resolve to parent -- this MUST be caught.
        // ensureInsideRoot will throw for this case.
        assert.throws(() => ensureInsideRoot(result, root));
      } else if (safe === ".") {
        // "." resolves to root itself -- callers must reject root==workspace.
        // path.join(root, ".") normalizes to the effective root
        assert.equal(result, prefix);
      } else if (safe.startsWith("..")) {
        // Identifiers starting with ".." (e.g. ".._.._") are rejected by
        // ensureInsideRoot's conservative prefix check even though the path
        // is structurally under root. This is a security-conservative choice.
        assert.throws(() => ensureInsideRoot(result, root));
        // But verify the path IS structurally under the effective root prefix
        assert.ok(result.startsWith(prefix + "/"));
      } else {
        // Non-degenerate sanitized identifiers: path MUST be inside root
        assert.ok(result.startsWith(prefix + "/"));
        ensureInsideRoot(result, root);
        // Must not contain ".." as a path segment
        const segments = result.split("/");
        for (const seg of segments) {
          assert.notEqual(seg, "..");
        }
      }
    }),
    { numRuns: 500 },
  );
});

test("negative: ensureInsideRoot throws for paths outside root", () => {
  fc.assert(
    fc.property(absoluteRoot, (root) => {
      // A clearly unrelated sibling path should be rejected
      assert.throws(() => ensureInsideRoot("/etc/passwd", root));
      // The root itself should NOT throw (equal is allowed by ensureInsideRoot)
      ensureInsideRoot(root, root);
      // A path that is genuinely above root should be rejected
      const prefix = effectivePrefix(root);
      const segments = prefix.split("/").filter((s) => s !== "");
      if (segments.length >= 2) {
        // Go two levels up to ensure we are truly outside
        const ancestor = "/" + segments.slice(0, -2).join("/");
        if (ancestor !== prefix && ancestor !== "/") {
          assert.throws(() => ensureInsideRoot(ancestor, root));
        }
      }
    }),
    { numRuns: 500 },
  );
});

// INVARIANT: When directory names are derived from identifiers, they SHALL contain only alphanumeric characters, dots, hyphens, and underscores.
const ALLOWED_CHARS = /^[A-Za-z0-9._-]*$/;

test("safeIdentifier output contains only alphanumeric, dots, hyphens, underscores", () => {
  fc.assert(
    fc.property(diverseString, (input) => {
      const result = safeIdentifier(input);
      assert.match(result, ALLOWED_CHARS);
    }),
    { numRuns: 200 },
  );
});

test("safeIdentifier is a fixed-point for strings already in the safe alphabet", () => {
  fc.assert(
    fc.property(fc.stringMatching(/^[A-Za-z0-9._-]{1,50}$/), (input) => {
      const result = safeIdentifier(input);
      // Strings consisting entirely of allowed characters pass through unchanged
      assert.equal(result, input);
    }),
    { numRuns: 200 },
  );
});

test("safeIdentifier produces non-empty output for non-empty string inputs", () => {
  fc.assert(
    fc.property(fc.string({ minLength: 1, maxLength: 100 }), (input) => {
      const result = safeIdentifier(input);
      // A non-empty string must produce a non-empty sanitized identifier
      assert.ok(result.length > 0);
    }),
    { numRuns: 200 },
  );
});

// INVARIANT: When sanitization is applied to a name, applying it again SHALL produce the same result.
test("safeIdentifier is idempotent on arbitrary strings", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 100 }), (input) => {
      const once = safeIdentifier(input);
      const twice = safeIdentifier(once);
      assert.equal(twice, once);
    }),
    { numRuns: 200 },
  );
});

test("workspacePath output segment is already fully sanitized", () => {
  fc.assert(
    fc.property(absoluteRoot, validIdentifier, (root, identifier) => {
      const result = workspacePath(root, identifier);
      const prefix = effectivePrefix(root);
      const segment = result.slice(prefix.length + 1);
      // The segment should already be safe (applying safeIdentifier again yields same)
      assert.equal(safeIdentifier(segment), segment);
    }),
    { numRuns: 200 },
  );
});

// INVARIANT: When a multi-slot ensemble is resolved, each slot SHALL receive a distinct workspace path.
test("ensemble slots produce distinct workspace paths", () => {
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

test("different identifiers produce different workspace paths", () => {
  fc.assert(
    fc.property(absoluteRoot, validIdentifier, validIdentifier, (root, idA, idB) => {
      // Only test when identifiers sanitize to different values
      if (safeIdentifier(idA) !== safeIdentifier(idB)) {
        const pathA = workspacePath(root, idA);
        const pathB = workspacePath(root, idB);
        assert.notEqual(pathA, pathB);
      }
    }),
    { numRuns: 200 },
  );
});

test("ensemble paths all share the same parent directory", () => {
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

// INVARIANT: When a single-slot run is resolved, the workspace path SHALL have no slot suffix.
test("single-slot run has no slot suffix in path", () => {
  fc.assert(
    fc.property(absoluteRoot, validIdentifier, (root, identifier) => {
      const result = workspacePath(root, identifier, 0, 1);
      const prefix = effectivePrefix(root);
      // The path after root should be exactly one segment (the sanitized identifier)
      const relativePart = result.slice(prefix.length + 1);
      assert.ok(!relativePart.includes("/"));
      // The relative part should equal the sanitized identifier directly
      assert.equal(relativePart, safeIdentifier(identifier));
    }),
    { numRuns: 200 },
  );
});

test("contrast with ensemble -- ensemble path has extra segment", () => {
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

test("ensemble path has exactly two more segments than normalized root", () => {
  fc.assert(
    fc.property(
      absoluteRoot,
      validIdentifier,
      fc.integer({ min: 2, max: 10 }),
      fc.integer({ min: 0, max: 9 }),
      (root, identifier, ensembleSize, slotIndex) => {
        const slot = slotIndex % ensembleSize;
        const result = workspacePath(root, identifier, slot, ensembleSize);
        const prefix = effectivePrefix(root);
        const rootSegments = prefix.split("/").filter((s) => s !== "").length;
        const resultSegments = result.split("/").filter((s) => s !== "").length;
        assert.equal(resultSegments, rootSegments + 2);
      },
    ),
    { numRuns: 200 },
  );
});

// INVARIANT: When a workspace path is produced, it SHALL be a valid absolute path.
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

// INVARIANT: When a workspace path is produced, it SHALL contain no ".." segments.
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
