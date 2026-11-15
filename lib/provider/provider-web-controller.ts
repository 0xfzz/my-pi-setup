import type { ActionRequestPayload } from "../../web/core/plugin-contracts/actions.ts";
import type { DialogWebView } from "../../web/core/plugin-contracts/view.ts";
import type { ConfigSnapshot, ModelsConfig } from "./provider-config.ts";
import { DiscoveryError, type DiscoveredModel } from "./provider-discovery.ts";
import {
  applyDiscoveredModels, discoveringView, discoveryFailedView, discoveryPickerView, matchingModels,
  siblingAccounts, syncModelsToSiblings, syncOfferView, toggleModel, type DiscoveryState,
} from "./provider-web-discovery.ts";
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
  /** Fetch the provider's own model list; only DiscoveryError messages may be shown. */
  discover(id: string): Promise<DiscoveredModel[]>;
}

/** Plugin-owned controller: guarded edits reuse the TUI's drafts, account plans and save path. */
export class ProviderWebManager {
  private state: ProviderManagerState | null = null;
  private snapshot: ConfigSnapshot | null = null;
  private pending: { config: ModelsConfig; id: string; from: string; to: string } | null = null;
  /** The discovery picker in flight, when the pick-models screen is showing. */
  private discovery: DiscoveryState | null = null;
  /** Why the last discovery refused, so Retry can run again. */
  private discoveryFailure: { id: string; reason: string } | null = null;
  /** A saved model list waiting for the family-sync answer. */
  private pendingSync: { config: ModelsConfig; id: string; count: number } | null = null;
  private busy = false;
  private readonly host: ManagerHost;

  constructor(host: ManagerHost) { this.host = host; }

  reset(): void {
    this.state = null;
    this.snapshot = null;
    this.pending = null;
    this.discovery = null;
    this.discoveryFailure = null;
    this.pendingSync = null;
  }

  async open(id: string, notice?: string): Promise<void> {
    this.snapshot = await this.host.read();
    if (this.snapshot.config.providers[id] === undefined) {
      await this.host.list();
      return;
    }
    this.state = { id, screen: "detail" };
    this.pending = null;
    this.discovery = null;
    this.discoveryFailure = null;
    this.pendingSync = null;
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
    // The discovery picker replaces the management body; ticks and filters
    // live here, republished as whole views.
    if (this.discovery !== null && this.state.screen === "pick-models") {
      this.host.publish(discoveryPickerView(this.discovery, options));
      return;
    }
    this.host.publish(providerManagerView({ state: this.state, providers: this.snapshot.config.providers, ...options }));
  }

  private async apply(request: Partial<ActionRequestPayload>): Promise<void> {
    const values = request.values ?? {};
    if (values.providerId !== undefined) { await this.open(values.providerId); return; }
    if (this.state === null || this.snapshot === null) return;
    if (request.confirm === "Back to providers") { await this.host.list(); return; }
    if (request.confirm === "Back to provider") { await this.open(this.state.id); return; }
    if (this.discoveryFailure !== null) {
      const failure = this.discoveryFailure;
      this.discoveryFailure = null;
      if (request.confirm === "Retry discovery") { await this.startDiscovery(failure.id); return; }
      if (request.confirm === "Enter model ID manually") { this.host.model(failure.id); return; }
      this.host.publish(discoveryFailedView(failure.id, failure.reason));
      return;
    }
    if (this.discovery !== null) { this.pickModels(request); return; }
    if (this.state.screen === "detail") { this.navigate(request); return; }
    if (this.state.screen === "edit" || this.state.screen === "clone") {
      const expected = this.state.screen === "clone" ? "Save new account" : "Save connection";
      if (request.confirm !== expected) return;
      await this.saveEditor(values);
      return;
    }
    if (this.state.screen === "pick-model") { this.reviewModelRemoval(values.modelId); return; }
    if (this.state.screen === "sync") {
      if (request.confirm === "Copy to all accounts") await this.answerSync(true);
      else if (request.confirm === "Keep only this account") await this.answerSync(false);
      return;
    }
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
    if (request.confirm === "Add/update model") {
      this.discoveryFailure = null;
      void this.startDiscovery(this.state.id);
      return;
    }
    if (modelId !== undefined) {
      const provider = this.snapshot.config.providers[this.state.id]!;
      if (!modelRows(provider).some((model) => model.id === modelId)) throw new Error("Model is no longer configured.");
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

  /** The TUI's add-models flow, one published dialog at a time. */
  private async startDiscovery(id: string): Promise<void> {
    if (this.state === null) return;
    this.state = { id, screen: "pick-models" };
    this.discovery = null;
    this.host.publish(discoveringView(id));
    let models: DiscoveredModel[];
    try {
      models = await this.host.discover(id);
    } catch (error) {
      // Never display arbitrary errors: servers and auth resolvers can include
      // secrets in them. Only the discovery module's safe reasons surface.
      const reason = error instanceof DiscoveryError ? error.message : "The model list could not be fetched.";
      this.discoveryFailure = { id, reason };
      this.state = { id, screen: "detail" };
      this.host.publish(discoveryFailedView(id, reason));
      return;
    }
    if (models.length === 0) {
      this.discoveryFailure = { id, reason: "The model list is empty." };
      this.state = { id, screen: "detail" };
      this.host.publish(discoveryFailedView(id, "The model list is empty."));
      return;
    }
    const configured = new Set(modelRows(this.snapshot?.config.providers[id] ?? {}).map((model) => model.id));
    this.discovery = {
      providerId: id, models,
      selected: new Set(models.filter((model) => configured.has(model.id)).map((model) => model.id)),
      filter: "",
    };
    this.publish();
  }

  private pickModels(request: Partial<ActionRequestPayload>): void {
    const state = this.discovery;
    if (state === null) return;
    const modelId = request.values?.modelId;
    if (modelId !== undefined && state.models.some((model) => model.id === modelId)) {
      this.discovery = toggleModel(state, modelId);
      this.publish();
      return;
    }
    if (request.confirm === "Select all matching") {
      this.discovery = { ...state, selected: new Set([...state.selected, ...matchingModels(state).map((model) => model.id)]) };
      this.publish();
      return;
    }
    if (request.confirm === "Clear selection") {
      this.discovery = { ...state, selected: new Set() };
      this.publish();
      return;
    }
    if (request.confirm === "Enter model ID manually") {
      this.discovery = null;
      this.host.model(state.providerId);
      return;
    }
    if (request.confirm?.startsWith("Save selected models")) {
      this.saveDiscovered();
      return;
    }
    // The search box's Enter (or the Apply filter button) sends its text as
    // the confirm label: it is the filter, not an action.
    if (request.confirm !== undefined && request.values === undefined) {
      this.discovery = { ...state, filter: request.confirm };
      this.publish();
    }
  }

  private saveDiscovered(): void {
    const state = this.discovery;
    if (state === null || this.snapshot === null || this.state === null) return;
    const picked = state.models.filter((model) => state.selected.has(model.id));
    if (picked.length === 0) {
      this.publish({ problem: "Tick at least one model to save." });
      return;
    }
    const provider = this.snapshot.config.providers[state.providerId];
    if (provider === undefined) {
      this.discovery = null;
      this.host.publish(discoveryFailedView(state.providerId, `${state.providerId} is no longer configured.`));
      return;
    }
    const { provider: updated, defaulted } = applyDiscoveredModels(provider, picked);
    const config = structuredClone(this.snapshot.config);
    config.providers[state.providerId] = updated;
    this.discovery = null;
    void (async () => {
      try {
        await this.host.commit(this.snapshot!, config);
        const siblings = siblingAccounts(config.providers, state.providerId);
        const notice = `Saved ${picked.length} model${picked.length === 1 ? "" : "s"} to ${state.providerId}.`
          + (defaulted.length ? ` No context window reported for ${defaulted.join(", ")}; defaulted to 128000.` : "");
        if (siblings.length > 0) {
          this.pendingSync = { config, id: state.providerId, count: picked.length };
          this.state = { ...this.state!, screen: "sync" };
          this.host.publish(syncOfferView(state.providerId, siblings, picked.length));
          return;
        }
        await this.open(state.providerId, notice);
      } catch (error) {
        await this.open(state.providerId).catch(() => this.host.list());
        this.host.publish(discoveryFailedView(state.providerId, error instanceof Error ? error.message : "The save failed."));
      }
    })();
  }

  private async answerSync(accept: boolean): Promise<void> {
    const pending = this.pendingSync;
    if (pending === null) return;
    this.pendingSync = null;
    if (!accept) {
      await this.open(pending.id, `Saved ${pending.count} model${pending.count === 1 ? "" : "s"} to ${pending.id}.`);
      return;
    }
    // The first commit already changed the file, so the opening snapshot is
    // stale; a fresh read keeps the save's not-overwrite guarantee intact.
    const current = await this.host.read();
    if (current.config.providers[pending.id] === undefined) {
      await this.open(pending.id, "Saved models, but the account disappeared before the sync.");
      return;
    }
    const config = syncModelsToSiblings(current.config, pending.id);
    await this.host.commit(current, config);
    await this.open(pending.id, "Saved models and copied them to this family's other accounts.");
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
