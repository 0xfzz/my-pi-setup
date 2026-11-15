import type { ActionRequestPayload } from "../../web/core/plugin-contracts/actions.ts";
import type { DialogWebView } from "../../web/core/plugin-contracts/view.ts";
import type { ConfigSnapshot, ModelsConfig } from "./provider-config.ts";
import { modelRows, withoutModel } from "./provider-settings.ts";
import {
  providerAccountPlan, providerEdit, providerManagerView, type ManagerAuth, type ProviderManagerState,
} from "./provider-web-manager.ts";
import { PROVIDERS_MANAGE_ACTION } from "../../web/plugins/providers/contract.ts";

interface ManagerHost {
  read(): Promise<ConfigSnapshot>;
  commit(snapshot: ConfigSnapshot, config: ModelsConfig): Promise<void>;
  auth(id: string): ManagerAuth;
  publish(view: DialogWebView): void;
  list(): Promise<void>;
  model(id: string, modelId?: string): void;
}

/** Plugin-owned controller: guarded edits reuse the TUI's drafts, account plans and save path. */
export class ProviderWebManager {
  private state: ProviderManagerState | null = null;
  private snapshot: ConfigSnapshot | null = null;
  private pending: { config: ModelsConfig; id: string; from: string; to: string } | null = null;
  private busy = false;
  private readonly host: ManagerHost;

  constructor(host: ManagerHost) { this.host = host; }

  reset(): void {
    this.state = null;
    this.snapshot = null;
    this.pending = null;
  }

  async open(id: string, notice?: string): Promise<void> {
    this.snapshot = await this.host.read();
    if (this.snapshot.config.providers[id] === undefined) {
      await this.host.list();
      return;
    }
    this.state = { id, screen: "detail" };
    this.pending = null;
    this.publish(notice ? { notice } : {});
  }

  async action(request: Partial<ActionRequestPayload>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try { await this.apply(request); }
    catch (error) { this.publish({ problem: error instanceof Error ? error.message : "The provider change failed." }); }
    finally { this.busy = false; }
  }

  private publish(options: { problem?: string; notice?: string } = {}): void {
    if (this.state === null || this.snapshot === null) return;
    this.host.publish(providerManagerView({ state: this.state, providers: this.snapshot.config.providers, ...options }));
  }

  private async apply(request: Partial<ActionRequestPayload>): Promise<void> {
    const values = request.values ?? {};
    if (values.providerId !== undefined) { await this.open(values.providerId); return; }
    if (this.state === null || this.snapshot === null) return;
    if (request.confirm === "Back to providers") { await this.host.list(); return; }
    if (request.confirm === "Back to provider") { await this.open(this.state.id); return; }
    if (this.state.screen === "detail") { this.navigate(request); return; }
    if (this.state.screen === "edit" || this.state.screen === "clone") {
      const expected = this.state.screen === "clone" ? "Save new account" : "Save connection";
      if (request.confirm !== expected) return;
      await this.saveEditor(values);
      return;
    }
    if (this.state.screen === "pick-model") { this.reviewModelRemoval(values.modelId); return; }
    if (this.state.screen === "trust") {
      if (request.confirm === "Trust endpoint and save" && this.pending !== null) await this.save(this.pending);
      return;
    }
    if (request.confirm === "Remove configuration" && this.state.screen === "remove") await this.removeProvider();
    if (request.confirm === "Remove model configuration" && this.state.screen === "remove-model") await this.removeModel();
  }

  private navigate(request: Partial<ActionRequestPayload>): void {
    if (this.state === null || this.snapshot === null) return;
    const modelId = request.values?.modelId;
    if (modelId !== undefined || request.confirm === "Add/update model") {
      const provider = this.snapshot.config.providers[this.state.id]!;
      if (modelId !== undefined && !modelRows(provider).some((model) => model.id === modelId)) throw new Error("Model is no longer configured.");
      this.host.model(this.state.id, modelId);
      return;
    }
    const screens = { "Edit connection": "edit", "Clone with a new key": "clone", "Remove provider": "remove", "Remove model": "pick-model" } as const;
    const screen = screens[request.confirm as keyof typeof screens];
    if (screen === undefined) return;
    this.state = { id: this.state.id, screen };
    this.publish();
  }

  private async saveEditor(values: Record<string, string>): Promise<void> {
    if (this.state === null || this.snapshot === null) return;
    const id = this.state.screen === "clone" ? providerAccountPlan(this.snapshot.config.providers, this.state.id)?.draft.id ?? this.state.id : this.state.id;
    const result = providerEdit({ state: this.state, config: this.snapshot.config, values, auth: this.host.auth(id) });
    if (!result.ok) { this.publish({ problem: result.problem }); return; }
    if (result.trust !== undefined) {
      this.pending = { config: result.config, id: result.id, ...result.trust };
      this.state = { ...this.state, screen: "trust" };
      this.host.publish({
        type: "dialog", id: "provider-manager:trust", title: "Trust new endpoint?",
        lines: [`Current endpoint: ${result.trust.from}`, `New endpoint: ${result.trust.to}`, "Existing authentication and custom headers may be sent to the new endpoint. Save only if you trust it."],
        actions: [{ id: PROVIDERS_MANAGE_ACTION, label: "Trust endpoint and save", tone: "primary" }, { id: PROVIDERS_MANAGE_ACTION, label: "Back to provider" }],
      });
      return;
    }
    await this.save(result);
  }

  private async save(change: { config: ModelsConfig; id: string }): Promise<void> {
    if (this.snapshot === null) return;
    await this.host.commit(this.snapshot, change.config);
    await this.open(change.id, "Saved provider configuration.");
  }

  private reviewModelRemoval(modelId: string | undefined): void {
    if (this.state === null || this.snapshot === null) return;
    const provider = this.snapshot.config.providers[this.state.id]!;
    if (!modelRows(provider).some((model) => model.id === modelId)) throw new Error("Choose a configured model.");
    this.state = { ...this.state, screen: "remove-model", modelId: modelId! };
    this.publish();
  }

  private async removeProvider(): Promise<void> {
    if (this.state === null || this.snapshot === null) return;
    const config = structuredClone(this.snapshot.config);
    delete config.providers[this.state.id];
    await this.host.commit(this.snapshot, config);
    await this.host.list();
  }

  private async removeModel(): Promise<void> {
    if (this.state === null || this.snapshot === null || this.state.modelId === undefined) return;
    const config = structuredClone(this.snapshot.config);
    config.providers[this.state.id] = withoutModel(config.providers[this.state.id]!, this.state.modelId);
    await this.save({ config, id: this.state.id });
  }
}
