// The sidebar launcher: up to three pinned feature icons ahead of a single
// ⋯ overflow menu. The ⋯ menu lists every installed panel (pinned or not)
// with its icon and full title, and a per-panel submenu carries the Open and
// Pin/Unpin actions. Menu focus, keyboard navigation, typeahead and Escape
// layering come from Radix Dropdown Menu — no hand-rolled popup here.

import {
  ChartBar, Check, DotsThree, Files, ListChecks, PushPin, PuzzlePiece, Sliders,
  Spinner, TreeStructure, Users, type Icon,
} from "@phosphor-icons/react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { WebPluginIcon } from "./contract.ts";
import { type PanelEntry } from "./panel-entry.ts";
import { MAX_PINS } from "./pin-policy.ts";

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

function PanelIcon({ icon, size = 16 }: { icon: WebPluginIcon; size?: number }) {
  const IconComponent = PANEL_ICONS[icon] ?? PuzzlePiece;
  return <IconComponent size={size} aria-hidden="true" />;
}

export interface PanelLauncherProps {
  /** Every installed, sidebar-eligible panel in display order. */
  entries: readonly PanelEntry[];
  /** Resolved (seeded/capped) pin list, in pin order. */
  pinnedIds: readonly string[];
  activePanelId: string | null;
  onToggle: (id: string) => void;
  onPin: (id: string) => void;
  onUnpin: (id: string) => void;
  /** The refusal message from the last pin attempt, cleared on retry. */
  pinError: string | null;
}

export function PanelLauncher({
  entries,
  pinnedIds,
  activePanelId,
  onToggle,
  onPin,
  onUnpin,
  pinError,
}: PanelLauncherProps) {
  // Hide the launcher entirely when nothing can be opened right now.
  if (entries.every((entry) => !entry.available)) return null;

  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  const maxedOut = pinnedIds.length >= MAX_PINS;

  // The rail: pinned ids in pin order, kept only while their panel is openable.
  const railEntries = pinnedIds
    .map((id) => entryById.get(id))
    .filter((entry): entry is PanelEntry => entry !== undefined && entry.available);

  // Pinned ids whose panel is temporarily unavailable or no longer installed:
  // kept in their slot, hidden from the rail, removable from the ⋯ menu.
  const unavailablePinned = pinnedIds.filter((id) => {
    const entry = entryById.get(id);
    return entry === undefined || !entry.available;
  });

  return (
    <DropdownMenu.Root>
      {/* The leading rail, one icon button per pinned panel. */}
      <nav className="app-plugin-panel-nav" aria-label="Plugin panels">
        {railEntries.map((entry) => {
          const active = entry.id === activePanelId;
          return (
            <button
              key={entry.id}
              type="button"
              className={`app-plugin-panel-button${active ? " is-active" : ""}`}
              data-panel-id={entry.id}
              aria-label={entry.title}
              aria-pressed={active}
              title={`${active ? "Close" : "Open"} ${entry.title}`}
              onClick={() => onToggle(entry.id)}
            >
              <PanelIcon icon={entry.icon} size={18} />
            </button>
          );
        })}
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className="app-plugin-panel-button app-plugin-panel-more"
            aria-label="More panels"
            aria-haspopup="menu"
            title="More panels"
          >
            <DotsThree size={18} weight="bold" aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>
      </nav>

      <DropdownMenu.Portal>
        <DropdownMenu.Content className="app-panel-menu" align="end" sideOffset={6}>
          <DropdownMenu.Label className="app-panel-menu-label">
            {maxedOut ? `${MAX_PINS} of ${MAX_PINS} pinned` : "Panels"}
          </DropdownMenu.Label>
          {entries.map((entry) => {
            if (!entry.available) {
              return (
                <DropdownMenu.Item
                  key={entry.id}
                  className="app-panel-menu-item app-panel-menu-item-unavailable"
                  disabled
                  title={entry.unavailableReason}
                >
                  <span className="app-panel-menu-icon"><PanelIcon icon={entry.icon} /></span>
                  <span className="app-panel-menu-title">{entry.title}</span>
                  <span className="app-panel-menu-reason">{entry.unavailableReason}</span>
                </DropdownMenu.Item>
              );
            }
            const active = entry.id === activePanelId;
            const pinned = pinnedIds.includes(entry.id);
            const pinDisabled = !pinned && maxedOut;
            return (
              <DropdownMenu.Sub key={entry.id}>
                <DropdownMenu.SubTrigger className="app-panel-menu-row">
                  <span className="app-panel-menu-icon"><PanelIcon icon={entry.icon} /></span>
                  <span className="app-panel-menu-title">{entry.title}</span>
                  {active ? <Check className="app-panel-menu-active" size={14} aria-label="active" /> : null}
                  {pinned ? <PushPin className="app-panel-menu-pin" size={13} aria-label="pinned" /> : null}
                </DropdownMenu.SubTrigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.SubContent className="app-panel-menu" sideOffset={2} alignOffset={-4}>
                    <DropdownMenu.Item
                      className="app-panel-menu-item"
                      onSelect={() => onToggle(entry.id)}
                    >
                      {active ? "Close panel" : "Open panel"}
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      className="app-panel-menu-item"
                      disabled={pinDisabled}
                      onSelect={() => {
                        if (pinned) onUnpin(entry.id);
                        else onPin(entry.id);
                      }}
                    >
                      {pinned ? "Unpin" : "Pin"}
                    </DropdownMenu.Item>
                  </DropdownMenu.SubContent>
                </DropdownMenu.Portal>
              </DropdownMenu.Sub>
            );
          })}

          {unavailablePinned.length > 0 ? (
            <>
              <DropdownMenu.Separator className="app-panel-menu-separator" />
              <DropdownMenu.Label className="app-panel-menu-label">Unavailable pins</DropdownMenu.Label>
              {unavailablePinned.map((id) => (
                <DropdownMenu.Item
                  key={id}
                  className="app-panel-menu-item app-panel-menu-item-unavailable"
                  onSelect={() => onUnpin(id)}
                >
                  <span className="app-panel-menu-title">{entryById.get(id)?.title ?? id}</span>
                  <span className="app-panel-menu-unpin">Remove pin</span>
                </DropdownMenu.Item>
              ))}
            </>
          ) : null}

          {pinError !== null ? (
            <>
              <DropdownMenu.Separator className="app-panel-menu-separator" />
              <DropdownMenu.Item className="app-panel-menu-error" disabled>
                {pinError}
              </DropdownMenu.Item>
            </>
          ) : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}