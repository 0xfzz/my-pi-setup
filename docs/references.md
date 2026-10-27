# Research / design references

> Part of [pi-workflow-extensions](../README.md). Upstream projects and prior art this package builds on.

- [Pi extension guide](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md): native tools, sequential execution, branch-aware state, lifecycle hooks, nested tool calls, and UI availability.
- [Official todo example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/todo.ts): session-local todo state and branch reconstruction. The example does not itself conditionally enforce a work plan.
- [Official question example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/question.ts): model-callable clarification. Native dialogs were preferred here to keep RPC compatibility and avoid another custom UI/keybinding layer.
- [pi-model-router](https://github.com/yeliu84/pi-model-router/): prior art for virtual-model routing in Pi. This implementation keeps routing provider-agnostic and adds per-provider account pools, which that project does not provide.
- [Pi virtual models](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/virtual-models.md): `registerVirtualModel`, route reasons (`user`/`continuation`/`retry`/`direct`), and why continuations stay on the answering model.
- [Herdr subagents](https://github.com/modem-dev/pi-herdr-subagents), especially its completion/question handshake (ported here as `orch_done` / `orch_ping` and parent `orch_resume`; the vendored `orch-child.ts` is the local fork). Herdr's completion/question protocol is unchanged; only the control-tool allowlist adds the companion milestone and workflow assessment tools.
- [pi-antigravity](https://github.com/Rahularya01/pi-antigravity) by Rahul Arya (MIT): the Antigravity / Cloud Code Assist provider, vendored under `vendor/antigravity/` so this package needs no npm dependency for it. The multi-account layer on top — one provider per account — is this package's own.
- [ascii.rest/aquarium](https://ascii.rest/aquarium/) by @bas3line (MIT): ASCII fish tank art, physics, and swimming animation equations. Adapted for compact terminal dimensions and sidebar lifecycle.

Implementation targets the **installed** Pi API (`@earendil-works`, `typebox`, actionable `turn_end`) rather than assuming upstream example versions match this fork.
