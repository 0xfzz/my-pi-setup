---
name: read-web-log
description: "Use to find the root cause of a pi-web server problem from ~/.pi/agent/logs/pi-web.log without reading the raw file: a crash, a 4xx/5xx or 503 on a route, a session that will not start, a blank or stuck web UI, plugin host or safe-mode trouble, a browser error, or 'what went wrong at HH:MM'. Runs a digest that groups failures by cause and caps its output, so a multi-megabyte log costs about a thousand tokens."
---

# Reading the pi-web log cheaply

`pi-web.log` grows without rotation and is ~99% `incoming request` / `request completed`
pairs. Reading it directly (`cat`, `tail -n 500`, `read`, a broad `grep`) burns the context
window on noise and still misses the cause. **Never open the raw file.** Run the digest.

```sh
npm run -s web-log -- [options]      # from the repo root; prints a bounded digest
npm run -s web-log -- --help         # every option
```

It understands both on-disk formats (old JSON lines and the current multi-line pretty text)
and groups repeated failures, so a crash loop of 500 identical errors is one entry with `×500`.

## Workflow: widen to narrow, three calls at most

1. **Digest the recent past.** Start with the window the user cares about, not the whole file.

   ```sh
   npm run -s web-log -- --since 30m        # relative to the NEWEST record, not the wall clock
   npm run -s web-log -- --since 20:15      # clock time on the newest record's day
   npm run -s web-log -- --pid 790746       # one server process (pids come from the PROCESSES section)
   ```

   No time given by the user? Use the default (whole file) once, read `PROCESSES`, then re-run
   with `--since` or `--pid` for the newest process. Old, already-fixed failures sit at the top
   of a whole-file digest and will mislead you.

2. **Zoom on one failure.** Pick the group from `PROBLEMS`, then fetch its surroundings:

   ```sh
   npm run -s web-log -- --around 20:22:39 --window 30s   # what else happened near it
   npm run -s web-log -- --pid 784109 --req req-y          # the full story of one request
   npm run -s web-log -- --grep "EADDRINUSE|ENOENT"        # every record matching a pattern
   ```

3. **Only now read code.** The stack frames in the digest are application frames first, with
   `file:line`; open those, not the log.

`--req` ids restart from `req-1` in every process, so always pair `--req` with `--pid`.
List mode hides request records; add `--requests` to see them (the digest tells you when
a list came back empty only because of that).

## Reading the digest

| Section | What it tells you |
|---|---|
| `PROBLEMS` | warn/error/fatal grouped by message + error text. Most severe first, then earliest. `×N a→b` is a repeat count and time span. `ctx:` names the request being served (`during GET /api/agent/:id`) and the session id. |
| `FAILED REQUESTS` | `status ×count route`, ids folded to `:id`. 5xx before 4xx. Compare the time span with `LIFECYCLE` to see whether failures cluster around a restart. |
| `SLOW REQUESTS` | over `--slow-ms` (default 2000). Long-lived `…/attach` and `…/events` streams are excluded on purpose; their duration is not latency. |
| `LIFECYCLE` | listening / stopped / safe mode, newest 12. A `stopped (SIGTERM)` followed by a new `listening` is a restart. |
| `PROCESSES` | one row per pid with its record, request and problem counts. Failures in a pid that is no longer the newest are usually already fixed. |

The earliest error in the newest process is the best root-cause candidate. Later errors are
often consequences of it; check the `--around` window before fixing the loudest one.

## Signatures seen in this log, and what they mean

| You see | Meaning |
|---|---|
| `listen EADDRINUSE … :30142` | A second server instance tried to bind a port a live one already holds. Look at `PROCESSES`/`LIFECYCLE` for two overlapping pids. |
| `503` on `/api/health` or `POST …/events` right after `stopped (SIGTERM)` | The server was draining for a restart (`routes.ts` answers 503 while draining). Expected during a restart; a problem only if it persists after the next `listening`. |
| `503 … Password protection is configured but unreadable` | `auth_unavailable`: the stored password cannot be read; re-run `/web set-password`. |
| `web plugin host entered safe mode (2 starts within 60s)` | Two boots inside the window tripped safe mode, so only core plugins load (`plugin-contracts/kernel/state.ts`). Find what caused the rapid restart in `LIFECYCLE`. |
| `uncaught exception … spawn pi ENOENT` with `failed to spawn a session host for <id>` | The server could not launch the `pi` executable for a session. Fixed in `d68d443` (host executable resolution); on an older build, `pi` was not on the server process's `PATH`. |
| `session host stderr` | stderr of a spawned `pi` session host, quoted verbatim, e.g. `No models match pattern "…"` means the requested model id matched no configured provider. |
| `source=browser` records | Browser `console.warn/error` batched to `POST /api/client/log`. The `during POST /api/client/log` context is the log upload, not the failing page request; the real failing request is named in the message. |

If a signature is not here, do not guess: take the `file:line` frame and read that code.

## Limits

- Time specs `30m`/`2h`/`20:15` hang off the newest record. If the server has been down for
  hours, `--since 30m` still shows the last 30 minutes it was alive.
- The file is read whole and parsed in memory: ~8 MB takes about 0.3 s. Expect it to stay
  practical into the tens of MB; beyond that, point `--file` at a trimmed copy.
- A missing file means logging is off (`PI_WEB_LOG_FILE=off`) or the server never started.
  The path is `$PI_WEB_LOG_FILE`, else `$PI_CODING_AGENT_DIR/logs/pi-web.log`, else
  `~/.pi/agent/logs/pi-web.log`; override it with `--file`.
- Secrets are redacted by the server before they reach the file, so nothing here needs scrubbing.
- Records the parser cannot classify appear as `unparsed log line: …` warnings instead of
  being dropped; raw crash output from outside pino lands there.

The parsing and digest logic lives in `lib/web-log-*.ts` (tests in `tests/web-log-*.test.ts`);
`scripts/web-log-digest.mjs` is only argv and file I/O. Format of the log itself:
[`docs/pi-web.md`](../../../docs/pi-web.md#logging).
