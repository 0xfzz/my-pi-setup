import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const crateDir = join(root, "crates", "nowrite-guard");
const manifestPath = join(crateDir, "Cargo.toml");
const targetBin = join(crateDir, "target", "release", "nowrite-guard");
const outBin = join(root, "lib", "nowrite-guard");

console.log("Building nowrite-guard (Rust Landlock helper)...");
execFileSync("cargo", ["build", "--manifest-path", manifestPath, "--release"], {
  stdio: "inherit",
});

if (existsSync(targetBin)) {
  mkdirSync(dirname(outBin), { recursive: true });
  copyFileSync(targetBin, outBin);
  console.log(`Copied nowrite-guard binary to ${outBin}`);
}
