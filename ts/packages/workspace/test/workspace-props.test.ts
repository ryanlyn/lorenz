import { test } from "vitest";
import fc from "fast-check";
import { safeIdentifier, workspacePath, ensureInsideRoot } from "@lorenz/cli";
import { assert } from "@lorenz/test-utils";

const SAFE_CHARS = /^[A-Za-z0-9._-]*$/;

test("INVARIANT: safeIdentifier is idempotent for all inputs", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 50 }), (input) => {
      const once = safeIdentifier(input);
      const twice = safeIdentifier(once);
      assert.equal(twice, once);
    }),
  );
});

test("INVARIANT: safeIdentifier output contains only safe characters", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 50 }), (input) => {
      const result = safeIdentifier(input);
      assert.match(result, SAFE_CHARS);
    }),
  );
});

test("INVARIANT: safeIdentifier output length does not exceed input length", () => {
  fc.assert(
    fc.property(fc.string({ minLength: 1, maxLength: 50 }), (input) => {
      const result = safeIdentifier(input);
      assert.ok(result.length <= input.length);
    }),
  );
});

test("INVARIANT: safeIdentifier returns empty string for non-string inputs", () => {
  fc.assert(
    fc.property(
      fc.oneof(fc.constant(null), fc.constant(undefined), fc.integer(), fc.boolean()),
      (input) => {
        assert.equal(safeIdentifier(input), "");
      },
    ),
  );
});

test("INVARIANT: safeIdentifier preserves strings already in the safe alphabet", () => {
  const safeChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-";
  fc.assert(
    fc.property(
      fc
        .array(fc.constantFrom(...safeChars), { minLength: 1, maxLength: 30 })
        .map((a) => a.join("")),
      (input) => {
        assert.equal(safeIdentifier(input), input);
      },
    ),
  );
});

test("INVARIANT: workspacePath result starts with root prefix", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("/tmp/workspaces", "/var/lorenz", "/home/user/ws"),
      fc
        .string({ minLength: 1, maxLength: 15 })
        .filter(
          (s) =>
            safeIdentifier(s) !== "" && safeIdentifier(s) !== "." && safeIdentifier(s) !== "..",
        ),
      (root, identifier) => {
        const result = workspacePath(root, identifier);
        assert.ok(result.startsWith(root + "/"));
      },
    ),
  );
});

test("INVARIANT: workspacePath for solo run has no slot suffix", () => {
  fc.assert(
    fc.property(
      fc.constant("/tmp/ws"),
      fc
        .string({ minLength: 1, maxLength: 15 })
        .filter(
          (s) =>
            safeIdentifier(s) !== "" && safeIdentifier(s) !== "." && safeIdentifier(s) !== "..",
        ),
      (root, identifier) => {
        const solo = workspacePath(root, identifier, 0, 1);
        const segments = solo.slice(root.length + 1).split("/");
        assert.equal(segments.length, 1);
      },
    ),
  );
});

test("INVARIANT: workspacePath for ensemble adds slot directory", () => {
  fc.assert(
    fc.property(
      fc.constant("/tmp/ws"),
      fc
        .string({ minLength: 1, maxLength: 15 })
        .filter(
          (s) =>
            safeIdentifier(s) !== "" && safeIdentifier(s) !== "." && safeIdentifier(s) !== "..",
        ),
      fc.integer({ min: 0, max: 9 }),
      fc.integer({ min: 2, max: 10 }),
      (root, identifier, slotIndex, ensembleSize) => {
        const slotIdx = slotIndex % ensembleSize;
        const result = workspacePath(root, identifier, slotIdx, ensembleSize);
        assert.ok(result.endsWith(`/${slotIdx}`));
      },
    ),
  );
});

test("INVARIANT: workspacePath produces distinct paths for distinct slots", () => {
  fc.assert(
    fc.property(
      fc.constant("/tmp/ws"),
      fc
        .string({ minLength: 1, maxLength: 15 })
        .filter(
          (s) =>
            safeIdentifier(s) !== "" && safeIdentifier(s) !== "." && safeIdentifier(s) !== "..",
        ),
      fc.integer({ min: 2, max: 5 }),
      (root, identifier, ensembleSize) => {
        const paths = new Set<string>();
        for (let slot = 0; slot < ensembleSize; slot += 1) {
          paths.add(workspacePath(root, identifier, slot, ensembleSize));
        }
        assert.equal(paths.size, ensembleSize);
      },
    ),
  );
});

test("INVARIANT: ensureInsideRoot rejects paths outside root", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("/tmp/ws", "/var/data", "/home/user"),
      fc.constantFrom("../escape", "../../etc/passwd", "/absolute/other"),
      (root, suffix) => {
        const target = suffix.startsWith("/") ? suffix : `${root}/${suffix}`;
        let threw = false;
        try {
          ensureInsideRoot(target, root);
        } catch {
          threw = true;
        }
        if (target.startsWith("/") && !target.startsWith(root + "/") && target !== root) {
          assert.ok(threw);
        }
      },
    ),
  );
});

test("INVARIANT: ensureInsideRoot accepts paths inside root", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("/tmp/ws", "/var/data"),
      fc
        .string({ minLength: 1, maxLength: 10 })
        .filter((s) => !s.includes("..") && !s.startsWith("/")),
      (root, child) => {
        const target = `${root}/${child}`;
        ensureInsideRoot(target, root);
      },
    ),
  );
});
