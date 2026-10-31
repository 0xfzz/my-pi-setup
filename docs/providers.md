# Custom providers in the TUI

> Part of [pi-workflow-extensions](../README.md). Add and edit providers and models without hand-editing JSON.

Command: **`/provider`** only. The redundant `/providers` alias has been removed. Opens Pi dialogs—no AI request or generated extension code.

```text
/provider             # the editor in the TUI (a dialog menu in RPC)
/provider add         # provider ID, display name, API key, connection, fetched model
/provider edit        # change a configured provider's connection
/provider model       # add/update one or more models on a configured provider
/provider remove      # remove only its models.json entry
/provider list        # list configured providers (not the entire built-in catalog)
```

## The editor

Bare `/provider` in the TUI opens an editor over `models.json`:

```text
╭ Providers ───────────────────────────────── ↑↓ move · Enter open · a add · Esc close ╮
│ file       /home/you/.pi/agent/models.json                                         │
│ providers  2 · 5 configured models                                                 │
│                                                                                    │
│ What would you like to do?                                                         │
│ › List available providers 2 configured — open one to edit, clone or delete         │
│   Add a new provider…  starts the connection wizard                                 │
╰────────────────────────────────────────────────────────────────────────────────────╯
```

Entering the list shows every provider in `models.json`, with its protocol, model
count and endpoint, and an `+ add a provider…` row:

```text
│ PROVIDERS                                                                        │
│ › acme      Acme Cloud          account 1/2                                      │
│     OpenAI Chat Completions · 3 models · https://api.acme.com/v1                 │
│   acme-2    Acme (Account 2)    account 2/2                                      │
│     OpenAI Chat Completions · 3 models · https://api.acme.com/v1                 │
│   + add a provider…                                                              │
```

- **Add (`a`)** walks the connection: id, display name, protocol, base URL, key — one screen each. `Enter` continues, `Esc` goes back.
- **The draft is durable while you walk it, and only while you walk it.** Going back keeps every answer: each keypress lands in the draft, so even half-typed text survives, and returning to the list and picking `add` again resumes the unfinished draft. Closing the popup discards it, so a new `/provider` starts blank and a half-finished provider can never reach `models.json`.
- **Each step validates on its own**, so a bad id or URL names the problem and stays on that screen instead of rejecting a whole form. A duplicate id is refused where it is typed; the display name defaults to the id.
- **The key field is masked** and its input is never rendered. Editing a provider starts that step blank — the stored credential is not re-displayed — and a blank key means "keep what is stored", which is how `/login` credentials survive an edit. A typed literal is escaped exactly as the dialog flow escapes it, so `$` and a leading `!` cannot become interpolation or a command.
- **`Enter` on a provider** shows its endpoint, protocol, how its stored authentication resolves, its account family, and what you can do: **edit** the connection, add models, review or remove a model, **clone** it, **delete** the entry. `e` edits the connection directly, `c` clones, `d` deletes.
- **Models** lists each model with its limits, reasoning flag and whether a native `modelOverrides` entry also describes it. Removing one deletes that override too, so it does not come back on reload.
- **A new connection saves by itself** and the editor reopens on it, because discovery is a separate dialog. The dialog flow still collects models before saving; from the editor, a connection saved without models says so, and its `Add models…` step is one keypress away.
- **Delete** asks once and names what is *not* deleted: built-in providers, extension-owned providers, and credentials stored through `/login`.
- **Cloning** (`Clone with a new key…`) creates the next `{provider_slug}-{n}` — `acme-3` for a family, or `acme-2` for a lone `acme`, which is renamed to `acme-1` first so the clone has a sibling. The clone inherits the connection and the model list, and **must supply its own key**: two accounts sharing one credential would bill the same account twice. The menu says which id it will create (and which rename it will do) before the wizard opens.
- A `models.json` that cannot be parsed is shown in the header instead of opened as an empty file, so a broken file is never overwritten by the editor.

Every edit re-reads the file first and `saveConfig` compares that snapshot with what is on disk, so a change made elsewhere while the popup was open is detected instead of overwritten. The dialog commands below remain for RPC clients, print mode, and scripted use.

Supports OpenAI Chat Completions (`openai-completions`), OpenAI Responses (`openai-responses`), Anthropic Messages, and Google Generative AI compatible endpoints. For Ollama/LM Studio/vLLM and gateways, use the exact base URL (including `/v1` when required).

**Setup flow:** enter the provider **ID**, its separate **display name**, and an **API key** in a masked input. Then select the API protocol and enter the base URL (these are required to contact a custom service). The wizard fetches its model list. Select a model and save—returned context/output limits and explicit capabilities are applied automatically, without retyping them.

**Automatic model list:** `/provider add` and `/provider model` try the selected protocol's read-only model-list endpoint and show a searchable, scrollable multi-select picker. Type to search model IDs or display names (case-insensitive). **↑/↓** scroll, **PgUp/PgDn** page, **Space** toggles a model, and **Ctrl+A** selects/deselects all matching models. Selections survive search changes. **Enter** continues with all selected models (or just the highlighted model if none are checked); **Ctrl+G** switches to manual ID entry; **Esc/Ctrl+C** cancels without saving. Fullscreen also supports wheel scrolling and clicking checkboxes; regular mode uses the keyboard because the terminal owns mouse scrollback. The picker opens as a focused, centered overlay instead of replacing the prompt/editor dock, so widgets and the footer cannot clip it. Its viewport adapts to terminal height, using a compact layout on very short screens while keeping the highlighted model visible. RPC clients use repeated standard selection dialogs with a **Use selected models** action instead of the terminal picker.

Selected models are configured together and saved only after one final confirmation. Missing context limits are requested separately with the model ID shown. Existing unselected models are kept; cancelling any step saves none of the batch. If discovery is missing, unauthorized, empty, malformed, unsupported, or unreachable, the wizard falls back to the same manual-entry form without discarding your setup.

- OpenAI-compatible: `GET <base-url>/models` (typically `/v1/models`, including Ollama's OpenAI compatibility API).
- Anthropic: `GET <base-url>/v1/models`, without duplicating an existing trailing `/v1`.
- Gemini: `GET <base-url>/models`; a host-only base uses `/v1beta/models`. `models/` resource prefixes are removed for Pi's model IDs, and explicitly non-chat entries are excluded.

`/models` is a convention, not a universal standard. Native Ollama `/api/tags`, unusual gateway paths and unsupported APIs may need manual entry. Discovery uses the entered key, environment references or existing native Pi API-key credentials and provider headers. No key is included in notifications or session messages. OAuth, extension-owned providers and `!command` authentication use manual entry rather than guessing service-specific auth or executing credential commands.

Discovery has a five-second HTTP timeout and bounds of ten pages, 2 MiB and 2,000 unique models. Pagination stays on the original endpoint; redirects are rejected. `--offline` or `PI_OFFLINE=1` skips discovery. No inference request is made, but read-only discovery requests can occur before final save confirmation; rejecting save does not undo those reads. Endpoint trust confirmation for reused authentication occurs **before** discovery. Returned IDs alone do not describe capabilities. When supplied, the wizard uses validated `context_length`/`context_window`/`contextWindow`/`max_model_len`, OpenRouter `top_provider` limits, or Gemini `inputTokenLimit`/`outputTokenLimit`. It also accepts explicit returned model names, reasoning flags and input modalities; it never infers limits from a model ID. **If a fetched model omits its context window, only that limit must be entered manually**—many standard `/models` responses expose IDs only. Missing/invalid output limits retain a valid existing limit or use `min(8192, contextWindow)`, with a visible notice. Missing capabilities retain existing values or default to text-only/non-reasoning; review these fields in `models.json` if the server does not advertise them. The full manual-entry form remains available whenever discovery fails or you choose manual entry.

API-key input:

- **Paste a key**: masked in the terminal and used immediately for discovery. On final confirmation, its literal value is saved in the private `models.json` file (`0600`). Treat that file as a credential file; do not commit or share it. `$` and leading `!` in literal keys are escaped so they cannot trigger environment interpolation or commands.
- **Environment variable**: type `$ACME_API_KEY` or `${ACME_API_KEY}` in the key field. Only the reference is written. Export the variable **before starting Pi**; shell exports inside the running agent do not change its environment.
- **Blank on a new provider**: configures a dummy `pi-local` key for local servers. This is not an anonymous/no-header transport mode; the server must accept or ignore a dummy key.
- **Blank when editing**: keeps existing authentication unchanged, including credentials stored through `/login`. RPC clients cannot display the masked TUI input; they accept an environment-variable name instead, not a raw key.

**Credential precedence matters:** stored `/login` and runtime keys override model-file/environment keys. The wizard blocks changing the key/local/environment setting while such a credential is active: use `/logout` first, restart without a runtime override, or choose a new provider ID. It also refuses authentication changes on extension-owned provider IDs or when existing provider/model headers are present, since extension auth and custom headers may override the selected method. Use a unique ID, keep existing authentication, or review advanced configuration manually. Changing an endpoint with existing authentication/custom headers requires explicit confirmation showing the current source and destination. Use a unique ID to isolate a new service from existing provider credentials. Removing configuration does **not** log out, revoke keys or delete built-in/extension providers; use `/logout` separately.

Configuration is saved to `<agent-dir>/models.json` (normally `~/.pi/agent/models.json`, respecting `PI_CODING_AGENT_DIR`). Pi reloads it immediately with network catalog refresh disabled; select the new model through `/model`. The current selection is not changed. Restarted Pi sessions and `pi --list-models` load the same native configuration without this extension needing to register competing providers. SDK hosts with a nonstandard `modelsPath` must manage that path themselves; the command targets the standard agent directory.

Other providers, headers, compatibility flags, costs and advanced metadata are preserved. Existing `modelOverrides` are synchronized for the fields edited in the model form, so they cannot silently hide its changes. Model-level endpoint/API overrides still take precedence over provider connection edits. **New model prices are recorded as zero/unknown**, not a promise that the model is free; edit `cost` in `models.json` for accurate billing. Advanced compatibility flags, custom headers, OAuth integrations, nonstandard model discovery and unsupported streaming protocols remain manual configuration/provider-extension work; see the [custom-provider guide](https://pi.dev/docs/latest/custom-provider).

Escape or rejecting confirmation saves nothing. Writes use a private temporary file (`0600`), atomic replacement, Pi's file-mutation queue and a cooperative cross-process wizard lock, with conflict checks before/after staging. Stale dialogs fail instead of intentionally overwriting detected changes. Arbitrary external editors do not honor the lock, so this is **not an OS-wide compare-and-swap guarantee**; avoid simultaneous manual edits. A crashed save can leave `models.json.workflow.lock`; remove it only after confirming no provider save is running. Symlinks, malformed JSON and JSON-with-comments are refused without rewriting them. Saving normalizes strict JSON formatting; no backup copies of credentials are created. A failed refresh after saving is reported as saved-but-not-loaded, not cancellation or automatic rollback.

Main session only, idle between runs. RPC clients supporting native dialogs use environment references instead of masked key entry; print mode and Herdr children do not open setup UI. Already included in this package: **restart Pi or use `/reload` after all children finish**, then run `/provider add`. No real provider configuration is changed merely by installing this extension.

Verification: `node --experimental-strip-types --test tests/providers.test.ts tests/provider-settings.test.ts tests/provider-settings-popup.test.ts tests/provider-discovery.test.ts tests/provider-key-input.test.ts tests/provider-model-picker.test.ts tests/provider-model-picker-layout.test.ts` covers the editor's steps, per-step validation, the durable draft (back keeps answers, closing discards them), the masked key step, account migration and model inheritance, model removal including its override, fetched metadata, separate native provider display names, masked key rendering/editing/cancellation, literal-key escaping, and discovery protocol paths, authentication, pagination, timeouts/redirects/response limits, automatic selection, manual fallback, cancellation, trust-before-network, field validation, auth precedence guards, native secret login, private/atomic writes, stale/concurrent saves, model override precedence, advanced-field preservation, removal, failed refresh, and real Pi 1.3.0 model loading across fresh runtimes. Tests use fixture credentials and injected responses or loopback HTTP, never real provider inference.
