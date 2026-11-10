# Web plugin extension-point catalog

> Part of [pi-workflow-extensions](../README.md). Every extension point a web plugin can use, with its stability, version and whether it is protected. Web plugins are interface bridging — the boundary rule lives in [web-plugin-architecture.md](web-plugin-architecture.md).

Generated from `lib/web-plugins/kernel/catalog.ts` by `scripts/gen-web-plugin-catalog.mjs`. Do not edit by hand.

| Id | Kind | Stability | Description |
| --- | --- | --- | --- |
| `app.header@1` | slot | experimental | Application header, right of the title. |
| `session.header@1` | slot | experimental | Header of the selected session. |
| `session.sidebar.row.actions@1` | slot | experimental | Action area of a sidebar session row. |
| `chat.before@1` | slot | experimental | Above the message list. (was `ui.chat-before.v1`) |
| `chat.composer.toolbar@1` | slot | experimental | Toolbar beside the composer's attach button. |
| `chat.composer.above@1` | slot | experimental | Strip above the composer. |
| `file-panel.header@1` | slot | experimental | Header of the file panel. |
| `settings.sections@1` | slot | experimental | Sections of the settings page. |
| `chat.message.user@1` | component | experimental | A user message row. |
| `chat.message.assistant@1` | component | experimental | An assistant message row. |
| `chat.tool.<name>@1` | component | experimental | A tool call, keyed by tool name. |
| `chat.tool.result.<name>@1` | component | experimental | A tool result, keyed by tool name. |
| `chat.working@1` | component | experimental | The working indicator under the message list. (was `ui.working-indicator.v1`) |
| `chat.input@1` | component | experimental | The chat input. |
| `sidebar.session-row@1` | component | experimental | A sidebar session row. (was `ui.session-sidebar-row.v1`) |
| `file.viewer.<mime>@1` | component | experimental | The file viewer for a MIME type. |
| `settings.panel.<id>@1` | component | experimental | A settings panel. |
| `ui.extension-status@1` | component | experimental | Extension status chip. (was `ui.extension-status.v1`) |
| `ui.plugin-view@1` | component | experimental | Declarative plugin view renderer. (was `ui.plugin-view.v1`) |
| `ui.floating-layer@1` | component | experimental | Floating overlay layer. (was `ui.floating-layer.v1`) |
| `route.page@1` | route | experimental | A plugin page under /p/<plugin-id>/… |
| `command@1` | command | experimental | A palette command, optionally a slash command. |
| `keybinding@1` | keybinding | experimental | A keyboard shortcut, checked for conflicts with the core map. |
| `theme@1` | theme | experimental | A validated design-token theme. |
| `session.created@1` | event | experimental | A hosted session was created. |
| `session.settled@1` | event | experimental | A hosted session finished a turn. |
| `message.appended@1` | event | experimental | A message was appended to a session. |
| `tool.finished@1` | event | experimental | A tool call finished. |
| `plugin.enabled@1` | event | experimental | A plugin was enabled. |
| `prompt.before-send@1` | waterfall | stable | Transform the prompt before it is sent to the agent. |
| `message.before-render-model@1` | waterfall | experimental | Transform a message before it is rendered. |
| `session.list.sort@1` | waterfall | experimental | Reorder the session list. |
| `session.title.generate@1` | waterfall | experimental | Produce a session title. |
| `session.before-delete@1` | bail | stable | Veto deleting a session with a user-visible reason. |
| `file.before-read@1` | bail | experimental | Veto reading a file. |
| `attachment.before-upload@1` | waterfall | experimental | Transform an attachment before upload. |
| `service:session.search@1` | service | experimental | Session search. |
| `service:model.pick@1` | service | experimental | Model selection. |
| `service:notifier@1` | service | experimental | User notifications. |
| `service:title-generator@1` | service | experimental | Session title generation. |
| `job.schedule@1` | job | experimental | A scheduled or event-triggered background job. |
| `storage.scope@1` | storage | experimental | Scoped key-value storage: global, project, or session. |
| `bridge.call@1` | bridge | experimental | A typed browser-to-server call owned by a plugin. |
| `tap.pi-events@1` | tap | experimental | Read-only projection of a session's pi event stream. |
| `core.auth.session@1` | protected | stable, protected | Signed-session authentication and proxy. |
| `core.transport@1` | protected | stable, protected | SSE transport integrity and loopback binding. |
| `core.plugin-manager@1` | protected | stable, protected | Plugin manager and safe-mode entry. |
| `core.capability-gate@1` | protected | stable, protected | The capability gate and the audit log. |
| `core.confirm.destructive@1` | protected | stable, protected | Destructive-action confirmation dialogs (add, never skip). |
