/**
 * Resolve the `pi-herdr-subagents` source this repository tests against.
 *
 * The package is vendored at `vendor/pi-herdr-subagents` (see its VENDORED.md), so the
 * default is repository-relative and works on any machine and in CI. `HERDR_ROOT`
 * stays as an escape hatch for pointing the seam tests at a live upstream checkout
 * while developing the Herdr patch itself.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** tests/fixtures → repository root. */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function candidates(): string[] {
  return [process.env.HERDR_ROOT, join(repoRoot, "vendor", "pi-herdr-subagents")]
    .filter((root): root is string => Boolean(root));
}

/** The vendored snapshot (or `HERDR_ROOT`), when it carries a session seeder at all. */
export function herdrRoot(): string | undefined {
  return candidates().find((root) => existsSync(join(root, "src", "session.ts")));
}

/**
 * The same root, but only if it writes `subagent-context:v1`.
 *
 * Only the patched source emits the provenance contract, and picking a checkout that
 * merely exists would silently test an unpatched seed.
 */
export function patchedHerdrRoot(): string | undefined {
  return candidates().find((root) => {
    const file = join(root, "src", "session.ts");
    return existsSync(file) && readFileSync(file, "utf8").includes("subagent-context:v1");
  });
}
