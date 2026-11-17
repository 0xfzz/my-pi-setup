#!/usr/bin/env node
/**
 * Token-frugal reader for the pi-web server log. Prints a bounded digest (or a
 * short record list) instead of the raw file, which is mostly request noise.
 * All logic lives in lib/web-log-*.ts; this file only does argv, env and I/O.
 *
 * Usage: node scripts/web-log-digest.mjs [--help]
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const lib = (name) => import(pathToFileURL(join(import.meta.dirname, "..", "lib", name)).href);
const { parseLogLines } = await lib("web-log-parse.ts");
const { buildDigest, DEFAULT_DIGEST_OPTIONS } = await lib("web-log-digest.ts");
const { buildQuery, inWindow, needsAnchor, parseCliArgs, selectRecords, USAGE } = await lib("web-log-query.ts");
const { DEFAULT_RENDER_OPTIONS, renderDigest, renderRecordList } = await lib("web-log-render.ts");

const fail = (message) => {
  console.error(`web-log-digest: ${message}\n\n${USAGE}`);
  process.exit(2);
};

const defaultLogPath = () => {
  if (process.env.PI_WEB_LOG_FILE) return process.env.PI_WEB_LOG_FILE;
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(agentDir, "logs", "pi-web.log");
};

const parsed = parseCliArgs(process.argv.slice(2));
if (!parsed.ok) fail(parsed.error);
const { args } = parsed;
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

const file = args.file ?? defaultLogPath();
let text;
try {
  text = readFileSync(file, "utf8");
} catch (error) {
  fail(`cannot read ${file}: ${error.code ?? error.message}. Is the web server running, and is PI_WEB_LOG_FILE=off set?`);
}
const lines = text.split("\n");

// Relative specs ("30m", "20:15") hang off the newest record, not the wall clock,
// so they still make sense when the server stopped hours ago.
let anchorMs = 0;
if (needsAnchor(args)) for (const record of parseLogLines(lines)) anchorMs = record.ms;

const built = buildQuery(args, anchorMs);
if (!built.ok) fail(built.error);
const { query } = built;
const frames = args.frames ?? DEFAULT_RENDER_OPTIONS.frames;

if (query.list) {
  console.log(renderRecordList(selectRecords(parseLogLines(lines), query), query, frames));
} else {
  const records = [...parseLogLines(lines)].filter((record) => inWindow(record, query));
  const options = { slowMs: args.slowMs ?? DEFAULT_DIGEST_OPTIONS.slowMs, minProblemLevel: query.minLevel ?? DEFAULT_DIGEST_OPTIONS.minProblemLevel };
  console.log(renderDigest(buildDigest(records, options), { ...DEFAULT_RENDER_OPTIONS, frames }));
}
