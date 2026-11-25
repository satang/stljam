# Changelog

## 0.1.5

- Pin parts and groups, reorder shortcuts, resize the Parts panel, and undo or redo visibility and pin changes.
- Isolate and frame changed parts, jump to individual parts, and restore the previous camera, section, and visibility.
- Separate corrections from additional feedback. Show when an agent receives a batch or starts the next revision, and offer a message to copy when feedback is waiting.
- Show measurement distance and endpoint labels in comments. Track the actual camera direction and display **Custom** when it leaves a preset.
- Open **Help** for a quick guide, version information, and links that prepare bug reports and suggestions in GitHub Issues.

## 0.1.4

- Use **Hide all** when no part is selected, or **Isolate selection** to show only the selected part. **Show all** brings every part back.
- Keep the full-width visibility controls below the scrollable Parts list. A green accent and a dedicated eye icon highlight **Isolate selection**.

## 0.1.3

- Paint directly on visible model surfaces with mouse or touch. Erase paint and undo strokes or erases before adding the comment.
- Restore the previous view, hidden parts, comparison, measurement, and in-progress comment after a reload in the same browser.
- Give nearby parts contrasting colors and carry those colors into section hatching, the Parts list, and detail captures.
- Record the part, local point, and normal for each measurement endpoint. Label section-fill picks as virtual and include the CAD reference when available.

## 0.1.2

- Organize larger assemblies with nested part groups defined in the manifest. Expand a group to inspect its parts, or show and hide the whole group at once.
- Clicking a part in the 3D viewer expands its parent groups and scrolls the Parts panel to its highlighted row.
- Section starts on the X axis. The axis picker lists X, Y, and Z, and saved comment views restore their original section.

## 0.1.1

- Add multiple numbered points and regions to a single comment, including marks on different parts.
- Keep region outlines anchored as the model rotates and label the reverse side of each region.
- Deliver original captures and automatic close-ups as MCP images. Close-ups use feature edges and distinct part colors, and preserve the section plane.
- Give agents the current part list and clearer guidance on reusing previews and waiting for the next round.

## 0.1.0

- Local browser review for STL, 3MF and self-contained GLB assemblies.
- Point and region annotations, filled sections, mesh measurements, and captured views.
- Draft comments, submitted rounds, explicit reopening, and immutable review history.
- Versioned asset snapshots and linked side-by-side comparison.
- CLI and MCP workflow to publish, wait for feedback, recover batches, and publish revised geometry.
- Agent listening indicator, a synthetic gearbox demo, and FreeCAD and Blender export helpers.
