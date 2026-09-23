# BharatCode Desktop Icons

The icon set uses the BharatCode refresh-v5 app icon from the website brand pack:
orange code brackets on the warm light app-icon field.

The upstream catch-up preserves the accepted icon bytes from release-line
`3d8360d79261199abc96b68170ef7c715b88e17d` for all three channels. Do not substitute
upstream artwork during a dependency sync.

`scripts/copy-icons.ts` stages the selected channel into `resources/icons`.
Electron Builder consumes `icon.icns` on macOS, `icon.ico` on Windows and the
PNG size set on Linux. These are build inputs, not generated during publication.
Any future artwork refresh must regenerate and visually verify all three native
formats from the approved brand source; the removed Tauri tree is not an icon
generation target.

For unpackaged Electron on macOS, `app.dock.setIcon()` should use a PNG. Keep `dock.png` in each channel folder synced with the
extracted `icon_128x128@2x.png` from that channel's `icon.icns` so the dev Dock icon matches the packaged app inset.
