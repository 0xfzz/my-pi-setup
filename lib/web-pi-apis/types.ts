/**
 * web-pi-apis — the pluggable pi_api facade.
 *
 * The web client never reimplements pi features. Each web capability maps to
 * a PiApiModule that CALLS pi's built-in implementation (pi-tui / pi core
 * modules). A registry owns the modules and their lifecycle so any host —
 * the extension inside pi, or the web server in-process — can dispatch the
 * same api names.
 *
 * Adding an api:
 *   1. extend PiApiName/PiApiParams/PiApiResult in web/shared/pi-api.ts,
 *   2. implement a PiApiModule (one file per api family),
 *   3. register it in lib/web-pi-apis/index.ts.
 * See docs/pi-web.md — "The pi_api interface map".
 */

/** What a pi_api module may need from its host. */
export interface PiApiContext {
  /** The session's working directory — the root for path-sensitive apis. */
  readonly cwd: string;
  /** Aborted when the host detaches; modules must stop in-flight work. */
  readonly signal: AbortSignal;
}

/**
 * A single pi built-in api exposed to the web.
 *
 * Modules are stateless across requests; anything expensive is built in
 * `init` (lazily, on first dispatch) and released in `dispose`.
 */
export interface PiApiModule {
  /** The wire name from web/shared/pi-api.ts. */
  readonly api: string;
  /** Parse + validate params, then call pi's native implementation. */
  handle(params: unknown, ctx: PiApiContext): Promise<unknown>;
  /** Lifecycle: first-use initializer (provider setup, tool discovery). */
  init?(ctx: PiApiContext): Promise<void>;
  /** Lifecycle: host detach — release resources, cancel work. */
  dispose?(): void | Promise<void>;
}

export type PiApiHandlerResult = { ok: true; result: unknown } | { ok: false; error: string };
