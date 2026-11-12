import {
  ChartBar, Files, ListChecks, PuzzlePiece, Sliders, Spinner, TreeStructure, Users,
  type Icon,
} from "@phosphor-icons/react";
import type { WebPluginDescriptor, WebPluginIcon } from "./contract.ts";

const PANEL_ICONS: Record<WebPluginIcon, Icon> = {
  files: Files,
  "list-checks": ListChecks,
  "tree-structure": TreeStructure,
  users: Users,
  "chart-bar": ChartBar,
  sliders: Sliders,
  spinner: Spinner,
  "puzzle-piece": PuzzlePiece,
};

interface PluginPanelNavProps {
  plugins: readonly WebPluginDescriptor[];
  activePluginId: string | null;
  onToggle: (pluginId: string) => void;
}

export function PluginPanelNav({ plugins, activePluginId, onToggle }: PluginPanelNavProps) {
  if (plugins.length === 0) return null;
  return (
    <nav className="app-plugin-panel-nav" aria-label="Plugin panels">
      {plugins.map((plugin) => {
        const active = plugin.id === activePluginId;
        const Icon = PANEL_ICONS[plugin.icon ?? "puzzle-piece"] ?? PuzzlePiece;
        return (
          <button
            key={plugin.id}
            type="button"
            className={`app-plugin-panel-button${active ? " is-active" : ""}`}
            data-plugin-id={plugin.id}
            aria-label={plugin.title}
            aria-pressed={active}
            aria-controls={active ? "plugin-side-panel" : undefined}
            title={`${active ? "Close" : "Open"} ${plugin.title}`}
            onClick={() => onToggle(plugin.id)}
          >
            <Icon size={18} aria-hidden="true" />
          </button>
        );
      })}
    </nav>
  );
}
