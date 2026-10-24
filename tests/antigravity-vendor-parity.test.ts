// Regression: `npm:pi-antigravity` was removed from settings and replaced by the
// vendored copy under `vendor/antigravity`. That swap is only safe if the local
// entrypoints still supply everything the npm package declared: the provider,
// its subcommands, and the two optional model-facing tools.
import test from "node:test";
import assert from "node:assert/strict";
import antigravity from "../vendor/antigravity/index.ts";
import googleSearch from "../vendor/antigravity/features/google-search.ts";
import generateImage from "../vendor/antigravity/features/generate-image.ts";

function recorder() {
  const providers: string[] = [];
  const commands: string[] = [];
  const tools: string[] = [];
  const pi: any = {
    registerProvider: (id: string) => providers.push(id),
    registerCommand: (name: string) => commands.push(name),
    registerTool: (tool: any) => tools.push(tool.name),
    on() {},
  };
  return { pi, providers, commands, tools };
}

test("vendored antigravity registers the provider, its commands and both tools", () => {
  const { pi, providers, commands, tools } = recorder();
  antigravity(pi);
  googleSearch(pi);
  generateImage(pi);

  assert.ok(providers.includes("antigravity"), `provider must register, got ${providers.join(",")}`);
  for (const command of ["antigravity.usage", "antigravity.models", "antigravity.accounts",
    "antigravity.refresh", "antigravity.doctor", "antigravity.image", "antigravity.search"]) {
    assert.ok(commands.includes(command), `${command} must register, got ${commands.join(",")}`);
  }
  assert.ok(tools.includes("google_search"), `google_search must register, got ${tools.join(",")}`);
  assert.ok(tools.includes("generate_image"), `generate_image must register, got ${tools.join(",")}`);
});
