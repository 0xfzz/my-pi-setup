// Vendored type shim (see ../VENDORED.md).
//
// Upstream targeted Pi 0.86, where `ProviderModelConfig` was a single
// chat-model interface. Pi 1.3 turned it into a union of chat, image, and
// classifier configs, so property access to chat-only fields (`reasoning`,
// `contextWindow`, `maxTokens`, `thinkingLevelMap`) no longer type-checks
// against the union even though every entry in this catalog is a chat model.
//
// This alias narrows the union back to its chat member. It changes types only;
// no runtime behaviour differs.
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export type ProviderChatModelConfig = Extract<ProviderModelConfig, { type?: "chat" }>;
export type { ProviderChatModelConfig as ProviderModelConfig };
