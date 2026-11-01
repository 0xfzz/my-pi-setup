import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { atLeastVersion, parseVersion } from "../../lib/sidebar/sidebar-layout.ts";

/**
 * The sidebar mounts by wrapping Pi's private fullscreen `layoutRoot`, so it must
 * feature-check that API instead of trusting a version number.
 *
 * It used to check `VERSION !== "1.3.0"` — an equality pin. When Pi 1.4.0 was
 * installed, every capability the adapter needs was still present (`h-stack.js` is
 * byte-identical between the two releases), but the pin refused the mount, so a
 * fullscreen session showed "Sidebar unavailable: this Pi version does not expose
 * a compatible layout" and the sidebar never appeared at all.
 *
 * The install here pins `tuiMode: "fullscreen"`, which is the mode that broke, so
 * these tests cover it directly.
 */

// ── Version comparison is a floor, compared numerically ────────────────────

test("parseVersion reads major.minor.patch and nothing else", () => {
  assert.deepEqual(parseVersion("1.3.0"), [1, 3, 0]);
  assert.deepEqual(parseVersion("1.4.0"), [1, 4, 0]);
  assert.deepEqual(parseVersion(" 2.0.1 "), [2, 0, 1]);
  // Prerelease and build metadata describe the same release line.
  assert.deepEqual(parseVersion("1.4.0-beta.1"), [1, 4, 0]);
  assert.deepEqual(parseVersion("1.4.0+build.7"), [1, 4, 0]);
  // Pi falls back to "0.0.0" when it cannot read its own version; that must not
  // be mistaken for a real version.
  assert.deepEqual(parseVersion("0.0.0"), [0, 0, 0]);
  assert.equal(parseVersion("unknown"), undefined);
  assert.equal(parseVersion(""), undefined);
});

test("atLeastVersion accepts the floor and everything newer", () => {
  // THE REGRESSION: 1.4.0 satisfied every capability check but was refused by an
  // equality pin. A floor keeps it working.
  assert.equal(atLeastVersion("1.4.0", "1.3.0"), true, "the release that broke must be accepted");
  assert.equal(atLeastVersion("1.3.0", "1.3.0"), true, "the floor itself is supported");
  assert.equal(atLeastVersion("1.3.1", "1.3.0"), true);
  assert.equal(atLeastVersion("2.0.0", "1.3.0"), true);
  // Numeric, not lexicographic: "1.10.0" < "1.3.0" as strings, but is newer.
  assert.equal(atLeastVersion("1.10.0", "1.3.0"), true, "string comparison would wrongly reject this");
  assert.equal(atLeastVersion("1.10.0", "1.9.0"), true);
});

test("atLeastVersion rejects older releases and unreadable versions", () => {
  assert.equal(atLeastVersion("1.2.9", "1.3.0"), false);
  assert.equal(atLeastVersion("0.9.0", "1.3.0"), false);
  // Pi's own fallback when it cannot determine its version: not evidence of a
  // compatible layout, so it must not be optimistically accepted.
  assert.equal(atLeastVersion("0.0.0", "1.3.0"), false);
  assert.equal(atLeastVersion("unknown", "1.3.0"), false);
});

// ── The installed release actually mounts ───────────────────────────────────

/**
 * Load the real adapter against the *installed* Pi, using the same alias map the
 * host's extension loader builds (`dist/core/extensions/loader.js` `getAliases()`).
 * That makes the extension and the TUI a single instance of the installed release
 * rather than this package's peer copies — without it, the test would silently
 * exercise whichever version happens to be in `node_modules`.
 */
function installedRelease() {
  const install = join(homedir(), ".pi", "agent", "install");
  const currentVersion = join(install, "current-version");
  if (!existsSync(currentVersion)) return undefined;
  const version = readFileSync(currentVersion, "utf8").trim();
  const releaseRoot = join(install, "releases", version, "node_modules", "@earendil-works");
  const piRoot = join(releaseRoot, "pi-coding-agent");
  const tuiRoot = join(releaseRoot, "pi-tui");
  if (!existsSync(join(piRoot, "dist", "index.js")) || !existsSync(join(tuiRoot, "dist", "index.js"))) {
    return undefined;
  }
  return { version, piRoot, tuiRoot };
}

test("the sidebar mounts on the installed Pi release, in fullscreen", async () => {
  const release = installedRelease();
  if (!release) return; // no local install to verify against

  const piRequire = createRequire(join(release.piRoot, "package.json"));
  const { createJiti } = piRequire("jiti");
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    alias: {
      "@earendil-works/pi-coding-agent": join(release.piRoot, "dist", "index.js"),
      "@earendil-works/pi-tui": join(release.tuiRoot, "dist", "index.js"),
      typebox: piRequire.resolve("typebox"),
    },
  });

  const probe = await jiti.import("../fixtures/sidebar-mount-probe.ts");
  const result = await probe.probeFullscreenMount(release.version);

  assert.equal(result.seenVersion, release.version, "the probe must see the installed release, not a peer copy");
  assert.equal(result.isViewportTUI, true, "fullscreen TUI must expose the viewport brand");
  assert.equal(result.hasLayoutRoot, true);
  assert.equal(result.hasSetLayoutRoot, "function");
  assert.equal(
    result.ensured,
    true,
    `the sidebar must mount on Pi ${release.version}; refusing it is the reported "Sidebar unavailable" bug`,
  );
  assert.equal(result.rendered, true, "the sidebar must appear in the rendered frame");
  assert.equal(result.wrappedRoot, true, "the original root must be wrapped, not replaced");
  assert.equal(result.disposeRestoredRoot, true, "cleanup must restore the host's original root");
});
