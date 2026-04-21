# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]
Target: 1.2.6

- Log all new changes here for the upcoming 1.2.6 release.

## [1.2.5] - 2026-04-16

- Overview contour editing now allows dragging existing contour anchors to new positions and deleting the selected anchor with the `Delete` key.
- Overview contour editing now highlights draggable anchors on hover and shows a translucent anchor preview when hovering a contour segment before inserting a new anchor.
- Coordinate warning banners in Metadata and Coordinates now derive from the current resolved metadata rows, so they clear correctly after image/sample links are corrected.
- Overview crop image export now uses the overview layer visibility shown in the viewer, instead of always exporting the post-cut image.

## [1.2.4] - 2026-04-11

- Coordinates now includes `Frame cut points` and `Frame images` actions that reset the viewer zoom and axes to encompass the currently visualized cut points or images.
- CSV rows that contain only a single linked image are now treated as unresolved image assignments instead of resolved coordinates, while keeping their stored pixel coordinates available in the orphan-assignment workflow.
- Closing LMDmapper no longer auto-saves the current session file; session data is only written when the user explicitly saves.
- `Assign orphan image` now shows only orphan images inside the expected image-number range by default, with a top-right button to reveal the full collector image set when needed.
- The default orphan-image range is now bounded by the previous and next resolved source columns, not by nearby rows, so re-cuts within the same column do not hide valid candidate images.

## [1.2.3] - 2026-04-10

- Persist shared CSV source-group identities in saved sessions so reused cryosections continue to consume source columns `1–6`, then `7–12`, even after reopening a session and rebinding one cryosection to a different local file path.
- Ignore suspicious CSV rows (non-`Ellipse` or zero-area) when reconstructing source columns, and warn when such rows are present or when the resolved source-column count does not match the current session layout.
- Set the default `µm per pixel` value to `0.326137` so new sessions match the voxel size of `pre_wil` / `cut_wol` coordinate images more closely.
- Rename user-facing `Project` wording to `Session` across the app, including setup labels, file dialogs, status messages, and menu actions.
- Update Coordinates hover feedback so cut-point tooltips show microsample, plate, well, and coordinates, while the normal hover cursor shows live `X/Y` stage coordinates and the hand cursor is reserved for right-click panning.
- Update Overview hover feedback so cut-point tooltips match the Coordinates layout and the hand cursor only appears when hovering the draggable overview image.

## [1.2.2] - 2026-03-24

- Shared CSV reuse across cryosections now consumes source columns in group order, so when two cryosections point to the same CSV/LIF set the later one uses the next source block (`1–6`, then `7–12`) instead of reloading the first half again; older shared-source projects now also attempt to repair those mappings on load and warn if the original CSV files cannot be reopened.
- Coordinates now includes a `Detach sources` action per cryosection, clearing imported LIF/CSV files, parsed mappings, and cached coordinates so a shared-source cryosection can be reimported or rebuilt cleanly.
- CSV plate building now resolves the source CSV columns first and only then maps them onto cryosection targets, fixing shared-source cases where the second cryosection was still replaying the first six source columns.

## [1.2.1] - 2026-03-24

- Double-clicking or opening a saved `.lmd` file from the OS now launches LMDmapper directly into that project instead of opening the app and requiring a second manual load.
- Overview image-alignment value fields now keep the typed draft intact and only apply the new scale/offset when the user presses `Enter` or leaves the field.
- Overview image alignment now includes an `Import from` control that can copy scale/offset values from another cryosection in the same session, with the button shown before the dropdown.
- Right-clicking a stationary point in Coordinates now opens a manual-coordinate modal with prefilled stage coordinates and a metadata-row selector, creating a new cut point and marking the Images column as `Manual coordinate` when assigned.
- Coordinates and Overview now show a default coordinate grid before LIF/CSV files are loaded, spanning roughly `10,000–50,000` on the vertical axis and auto-fitting the horizontal axis from `0` to preserve the viewer aspect ratio.
- Manual coordinate assignment now writes `Manual coordinate` into the Metadata `Images` column and keeps the row in warning state until the user confirms it.
- The manual-coordinate popup now includes a `Size` field with a default value of `5000`.
- Manual coordinate rows now transfer their `Size` value into Metadata reliably, keep the `Manual coordinate` label visible in `Images`, and expose the warning-status actions for validation or unlinking.
- Right-clicking in Coordinates now keeps the viewer fixed while opening the manual-coordinate popup and uses the original click position, instead of drifting the view before assignment.
- The Metadata status popup now uses manual-coordinate-specific wording with no image references, and removing a manual coordinate also clears its stored `Size`.
- Coordinates now includes a `Reuse from` action that can copy the already loaded LIF and CSV sources from another cryosection in the session instead of importing the same files again.
- The Coordinates `Reuse from` controls now sit on their own row below the import buttons and use the same custom dark cryosection dropdown styling as the rest of the app.
- CSV routing for cryosections split across multiple plate segments is now explicit: repeated assignments consume source columns sequentially (`1–6`, then `7–12`) instead of ambiguously reusing the first half, and the app now warns if a cryosection is assigned beyond the available 12 CSV columns.

## [1.1.5] - 2026-03-19

- Saved `.lmd` files now record the app version dynamically from the build metadata instead of relying on a hardcoded renderer version string.
- Collection `Y` values now use the corrected mapping (`X` → `y0`, `1 tick` → `y1`, `2 ticks` → `y2`, `3 ticks` → `y3`) for projects from `1.0.4` onward, and older `.lmd` files now prompt whether to correct the legacy offset or keep it as-is when loaded.
- Collection CSV import now also accepts `LMBatch`, `PlatePosition`, `Size`, and `Notes Collection` as header synonyms for `Plate`, `Well`, `Area`, and `Collection`.
- Project setup is now a flexible form-driven workflow that supports 1–4 cryosections, 1–2 plates, whole-plate or split-half assignment, per-segment positive/negative numbering, and cryosection stage positions without relying on the old fixed project-type presets.
- Plate previews in Project now start neutral until assigned, the same cryosection can be mapped to multiple plate segments when needed, and downstream Design / Collection / Metadata / Coordinates views now follow the new plate-segment mapping model.
- When a whole plate or half-plate is selected in Project, its cryosection and numbering controls now appear directly over the plate preview instead of below it.
- The Project plate-assignment overlay now stacks `Cryosection`, `Positive`, and `Negative` on three separate rows for clearer editing.
- The Project plate-assignment overlay is now sized and centered to the selected segment: centered over the full plate for whole-plate mode and centered within each half when the plate is split.
- The main Project setup card now grows with its content instead of clipping or keeping a fixed stretched height.
- Project cryosections now have editable colors, plate previews use those colors, and each selected plate segment now shows a centered summary badge with the cryosection name plus `Positive` / `Negative` start values that expands into the editor when clicked.
- The blue active highlight on Project plate segments now follows the rounded outer plate corners correctly.
- Positive numbering now defaults to session-wide sequential numbering per cryosection across assigned plate segments, while still remaining editable per segment when the user wants to override it.
- Negative numbering now follows the same auto-sequential default per cryosection across assigned plate segments, while still allowing per-segment manual overrides.
- Coordinates now uses a cryosection dropdown selector instead of relying on the old tab strip, so any configured cryosection can be selected directly.
- The Coordinates cryosection selector now uses the app’s dark control styling instead of the browser default select appearance.
- Overview now uses the same styled cryosection dropdown selector as Coordinates, so cryosections can be switched consistently in both views.
- The cryosection dropdown popup in Coordinates and Overview now uses a black menu with the current selection highlighted in blue.
- In Overview, the image-alignment values between the `-` and `+` buttons are now directly editable numeric fields instead of read-only text.
- The Overview alignment number fields now hide the native up/down spinner arrows because the `-` and `+` controls already provide stepping.

## [1.0.4] - 2026-03-13

- Add change notes for this release as they are implemented.
- Keep entries concise and user-facing.
- Added a fallback CSV→LIF coordinate inference path for rows with missing `Image Name(s)`, using LIF collector-holder positions plus image sequence order to recover `pre_wil` / `cut_wol` links when possible.
- Inferred coordinate links now show as warnings in Metadata until confirmed, remain internally tagged as inferred, and can be filtered in Coordinates with an `Inferred only` view filter.
- Refined CSV gap inference so missing image rows are filled only inside the bounded LMDPic-number range between the previous and next known CSV image anchors, with monotonic increasing assignment through each gap.
- Overview can now display unassigned `pre_wil` / `cut_wol` images as `Orphan images` and filter them independently for troubleshooting.
- `Orphan images` is now an unchecked-by-default filter in Coordinates and an unchecked-by-default visibility toggle in Overview.
- Hovering an orphan image in Coordinates now shows its LIF image name for troubleshooting.
- Hovering an orphan image in Coordinates now also shows its collector-holder position from the LIF metadata.
- Hovering an orphan image in Coordinates now outlines that image in orange and shows cursor-local image pixel coordinates in the tooltip.
- Secondary CSV↔LIF inference and coordinate resolution now work when only one of the paired images (`pre_wil` or `cut_wol`) is available.
- Repeated same-area CSV rows now merge instead of letting later blank rows erase earlier image links and coordinates for the same plate position.
- Coordinates right sidebar now uses collapsible `FILTERS`, `SELECTION`, and `ORPHAN IMAGES` boxes, and orphan images can be toggled individually or in bulk from their own list.
- In Coordinates, orphan images now remain visible from their own filter even if `Pre-cut` and `Post-cut` are both turned off.
- Clicking an orphan image in Coordinates can now open a manual assignment popup that lists plate positions still missing sampling points and writes a new cut point directly into Metadata when selected.
- Manual orphan-image assignment choices are now filtered by the orphan image collector row, so a collector `F` image only offers wells on row `F`.
- Clicking the Metadata status icon can now open a popup to remove the current sample↔image link, clearing pixel coordinates so the detached images become orphan images again and can be reassigned.
- Metadata now includes hidden `Pixel X` and `Pixel Y` columns that can be enabled from the column picker.
- Microsamples created manually from orphan-image assignment now remain in warning status until confirmed, instead of switching directly to `OK`.
- Manual orphan-image assignment now prefers the original CSV `X/Y Coordinates` stored for that plate/well and only falls back to the click location if the CSV well has no pixel coordinates.
- `Cmd+Z` / `Ctrl+Z` in Coordinates now undoes the last manual orphan-point creation without affecting the existing Overview undo shortcut.
- In Coordinates, the `Pre-cut` and `Post-cut` filters now also limit which orphan images appear in the map and in the orphan-image list.
- The `ORPHAN IMAGES` box in Coordinates now supports filtering orphan images by collector row `A`–`H`.
- The `Assign orphan image` popup now shows the microsample list above the previews, reveals pre-cut and post-cut preview cards only after a target is selected, uses click-to-select blue cards, scales the cut marker from original pixel coordinates onto the resized preview, and shows image stage coordinates below each preview.
- Selected cut points in Coordinates now draw with a pink outline ring to make selection easier to see.
- In Coordinates, overlapping images now draw in LMDPic order so the highest-numbered image is shown on top by default.
- Coordinates now has dedicated `Orphan (pre-cut)` and `Orphan (post-cut)` filters, so orphan image visibility is controlled independently from the regular `Pre-cut` / `Post-cut` image filters.
- Coordinates no longer shows the `Inferred only` or master `Orphan images` filters, and coordinate calculation no longer runs the automatic secondary CSV↔LIF fallback inference; missing links are now left for manual orphan assignment.
- In Metadata, wells with error status are now clickable and jump into Coordinates focused on orphan images for that collector row, with the selection panel collapsed, the orphan panel expanded, and the orphan list centered near the closest relevant image sequence.
- In manual orphan assignment, the predicted cut marker now renders immediately on the preview images, and when pre-cut and post-cut stage coordinates differ the popup enforces choosing only one of them.
- Clicking an incorrect well in Metadata now opens the `Assign orphan image` modal directly with that plate/well preselected and all matching orphan images for the collector shown in a sorted preview grid of up to four images per row.
- The manual orphan-assignment preview grid now scrolls within the modal when many images are available, and the predicted cut circle scales down with the smaller preview tiles.
- Reduced the orphan-assignment preview marker size so the predicted cut circle now scales visibly with smaller preview tiles.
- Coordinates auto-fit now uses full image extents and caps the automatic fit scale at native image size, preventing a single visible image from exploding in zoom and trapping the view.
- Metadata now includes a hidden `Number` column with the numeric microsample suffix used to build each microsample code.
- The hidden metadata `Number` column now uses the last three characters of the microsample code, avoiding accidental capture of digits from the cryosection/specimen ID.
- The Coordinates selection table now includes `Pre image` and `Post image` columns, and cut-point filtering also matches those image names.
- Collection now supports importing a CSV with `Plate`, `Well`, `Area`, and `Collection` columns directly from the sidebar to populate collection counts and column areas.
- Metadata `Columns` now supports drag-and-drop reordering for the visible table layout, and `Export CSV` now opens a popup where export columns can be selected and reordered before saving.

## [1.0.3] - 2026-03-11

- Replaced the top-level `Batch ID` field with `Session ID`.
- Added project-level `Plate / Batch ID` fields that adapt to the number of plates required by the selected project type.
- Design and Collection now show plate headers in the format `PLATE n - {Plate / Batch ID}`.
- Control microsample codes now replace the final cryosection/specimen suffix with `M`, `Z`, or `R` instead of reusing the positive-sample suffix.
- The Metadata `Cryosection` column now also rewrites the final cryosection/specimen suffix for `M`, `Z`, and `R` controls, while `P` samples keep the original name.
- Added a `Collection method` selector in the Collection sidebar and exposed it as a metadata column that can be shown or hidden from the column picker.
- The Metadata `Collection Method` value now defaults to `Lid8_Covaris_500639` immediately and updates from the Collection sidebar selection.
- Project cryosection setup now has separate `Start positive` and `Start negative` fields, and control codes use the negative start while positive samples keep the positive start.
- The second cryosection `Positive` and `Negative` starts now default to `AUTO`, derive from the first cryosection counts, and only become manually editable after a confirmation popup.
- The Cryosection 2 `AUTO` override confirmation now uses an in-app LMDmapper modal instead of the system confirm dialog.
- Restored the native Windows `File` / `Edit` / `View` / `Window` menus while keeping the Windows chrome in dark mode.
- Corrected the Collection reminder message text to say `collected shapes`.
- Switched editable fields and user-facing tables to `IBM Plex Sans` for clearer `l` / `I` differentiation while keeping the rest of the UI styling unchanged.

## [1.0.2] - 2026-02-27

- Updated Windows desktop chrome to dark styling (top native bar/menu area no longer uses default light theme).
- In Collection, valid 4-digit Area entry now shows a high-visibility reminder overlay for 4 seconds.
- Updated Project labels to `Cryosection / Specimen ID` (including numbered variants for multi-cryosection projects).

## [1.0.1] - 2026-02-26

- In `One plate one cryosection` mode, Design and Collection now show a single plate header across all 12 columns and remove the 6/7 half-plate divider.
- Added drag-area selection for wells in Design (with additive selection using `Shift`).
- Added `Not used (N)` sample type and excluded those wells from downstream coordinate/cut-point calculations.
- In Collection, Area inputs are disabled when an entire column is `Not used`.
- Added/standardized disabled-column warning messaging in Collection:
  clicking a locked column with missing area shows a warning below the plate table (same area as the duplicate-area warning), including clicks in the center of cells.
- Added new project type `One plate two cryosections`:
  uses a single plate split into left/right halves, with one cryosection assigned to each half.
- macOS `About LMDmapper` now shows app version and build date (instead of Electron info).
- Standardized release artifact names to `lmdmapper_<version>_<arch>_<os>.<ext>`.

## [1.0.0] - 2026-02-25

- Initial stable 1.0.0 release for LMDmapper.
- Added full multi-tab workflow (Project, Design, Metadata, Collection, Coordinates, Overview).
- Added macOS arm64 and Windows x64 installer packaging with app icons.
