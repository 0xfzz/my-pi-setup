#!/usr/bin/env node
/**
 * Stamp which sessions are subagent (child) sessions.
 *
 * `pi --resume` lists a child beside its parent, because a child session is a
 * normal session in the same per-project directory. This walks the session store,
 * proves which files are children, and writes the one entry pi's picker reads:
 * a `session_info` name (`child · <task>`).
 *
 * Dry run by default: prints what it would write and changes nothing.
 *
 *   node --experimental-strip-types scripts/stamp-sessions.ts
 *   node --experimental-strip-types scripts/stamp-sessions.ts --write
 *   node --experimental-strip-types scripts/stamp-sessions.ts --write --all
 *
 * Flags:
 *   --write     apply the stamps (default: report only)
 *   --all       also label main sessions (`main · <task>`); off by default
 *   --force     overwrite a name the user set by hand (off by default)
 *   --root DIR  session store to scan (default ~/.pi/agent/sessions)
 *   --json      machine-readable report
 *   --quiet     summary only
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { isStampedName, readSessionFacts, stampSessionText, type StampPlan } from "../lib/session-stamp.ts";

interface Flags {
  write: boolean;
  all: boolean;
  force: boolean;
  json: boolean;
  quiet: boolean;
  root: string;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {
    write: argv.includes("--write"),
    all: argv.includes("--all"),
    force: argv.includes("--force"),
    json: argv.includes("--json"),
    quiet: argv.includes("--quiet"),
    root: join(homedir(), ".pi", "agent", "sessions"),
  };
  const at = argv.indexOf("--root");
  if (at >= 0 && argv[at + 1]) flags.root = argv[at + 1]!;
  return flags;
}

/** Session files only. `.jsonl.context-usage` and `.progress-checkpoint.json` are sidecars. */
function sessionFiles(root: string): string[] {
  const out: string[] = [];
  for (const project of readdirSync(root)) {
    if (project === "artifacts") continue;
    const dir = join(root, project);
    let entries: string[];
    try {
      if (!statSync(dir).isDirectory()) continue;
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) if (entry.endsWith(".jsonl")) out.push(join(dir, entry));
  }
  return out.sort();
}

interface Row {
  file: string;
  plan: StampPlan;
  wrote: boolean;
}

function main(): void {
  const flags = parseFlags(process.argv.slice(2));
  const rows: Row[] = [];
  let skippedSidecar = 0;

  for (const file of sessionFiles(flags.root)) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      skippedSidecar++;
      continue;
    }
    const { text: next, plan } = stampSessionText(text, {
      includeMain: flags.all,
      force: flags.force,
    });
    let wrote = false;
    if (flags.write && next !== text) {
      writeFileSync(file, next);
      wrote = true;
    }
    rows.push({ file, plan, wrote });
  }

  const children = rows.filter((row) => row.plan.facts.kind === "child");
  const mains = rows.filter((row) => row.plan.facts.kind === "main");
  const wouldWrite = rows.filter((row) => row.plan.action === "stamp" || row.plan.action === "update");
  const kept = rows.filter((row) => row.plan.action === "keep");
  const ungrouped = children.filter((row) => !row.plan.facts.parentSession);

  if (flags.json) {
    console.log(JSON.stringify({
      root: flags.root,
      write: flags.write,
      sessions: rows.length,
      children: children.length,
      mains: mains.length,
      childEvidence: children.reduce<Record<string, number>>((acc, row) => {
        acc[row.plan.facts.evidence] = (acc[row.plan.facts.evidence] ?? 0) + 1;
        return acc;
      }, {}),
      stamped: wouldWrite.length,
      wrote: rows.filter((row) => row.wrote).length,
      kept: kept.length,
      childrenWithoutParent: ungrouped.length,
      plans: rows.map((row) => ({
        file: row.file,
        kind: row.plan.facts.kind,
        evidence: row.plan.facts.evidence,
        action: row.plan.action,
        name: row.plan.name,
        wrote: row.wrote,
      })),
    }, null, 2));
    return;
  }

  const verb = flags.write ? "wrote" : "would write";
  console.log(`sessions: ${rows.length}  ·  child: ${children.length}  ·  main: ${mains.length}`);
  console.log(`names   : ${verb} ${wouldWrite.length}  ·  already stamped/kept: ${kept.length}`);
  console.log(`evidence: ${JSON.stringify(children.reduce<Record<string, number>>((acc, row) => {
    acc[row.plan.facts.evidence] = (acc[row.plan.facts.evidence] ?? 0) + 1;
    return acc;
  }, {}))}`);
  // A child with no recorded parent cannot be grouped under it by the picker; the
  // label is then the only thing that distinguishes it from a session you opened.
  console.log(`no parent recorded: ${ungrouped.length} child session(s) — labelled, not grouped`);
  if (skippedSidecar) console.log(`unreadable: ${skippedSidecar}`);

  if (!flags.quiet) {
    const sample = wouldWrite.slice(0, flags.write ? 0 : 12);
    for (const row of sample) {
      console.log(`  ${flags.write ? "" : "[dry] "}${row.plan.name}  ←  ${row.file.split("/").slice(-2).join("/")}`);
    }
    const already = kept.filter((row) => isStampedName(row.plan.facts.currentName));
    if (already.length) console.log(`  (${already.length} already stamped)`);
  }
  if (!flags.write && wouldWrite.length) console.log("\nre-run with --write to apply.");
}

main();
