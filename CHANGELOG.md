# Changelog

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
