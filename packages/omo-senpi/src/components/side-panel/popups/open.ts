import type { PanelOverlayUi, PanelRow } from "../types"
import { createTextPopup } from "./text-popup"

/** The popup owns its own height; a percentage cap here would fight it and cost the bottom border. */
const OVERLAY_OPTIONS: Record<string, unknown> = {
  overlay: true,
  overlayOptions: { width: "70%", minWidth: 52, maxHeight: "100%", anchor: "center" },
}

/**
 * Open the shared framed viewer. One function for every entry point, so a click and a command
 * cannot drift apart on borders, scrolling or close keys - and a host without the overlay seam
 * still gets the content, just not a scrollable copy of it.
 */
export async function openPanelViewer(ui: PanelOverlayUi, title: string, rows: readonly PanelRow[]): Promise<void> {
  if (ui.custom === undefined) {
    ui.notify(rows.map((row) => row.text).join("\n"), "info")
    return
  }
  await ui.custom(
    (tui, theme, _keybindings, done) =>
      createTextPopup(tui, theme, { title, rows: () => rows, close: () => done(undefined) }),
    OVERLAY_OPTIONS,
  )
}
