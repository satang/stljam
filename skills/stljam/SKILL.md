---
name: stljam
description: Publish CAD previews, review geometry with the user, and iterate through StlJam.
---

# StlJam

Keep the project's own editable source. Publish a preview as one named file per part or instance. Preserve the assembly origin, units, component identifiers and placements between exports.

1. Use `open_review` to open an existing review or publish an initial manifest. Open its URL in the available browser and share it with the user.
2. Call `wait_for_feedback` before ending your turn. Repeat with its cursor while the review is open, for up to about 10 minutes in total. The page shows **Agent listening** during this wait. If the user finishes later, use `get_feedback` with the project and batch ID or the last cursor. A batch with `replaces` supersedes the previous submission; an empty replacement withdraws it.
3. Use the comment's source, piece, version, coordinates and captured view to locate the requested change. Before applying historical feedback, inspect the latest source and confirm that the referenced feature still corresponds. Record any ambiguous item as `needs-clarification`.
4. Edit the source. Verify the relevant dimensions, placement, clearance and fit using the CAD tool. A measurement against tessellated geometry is approximate.
5. Export and call `add_version` with the latest base version, a stable request ID for safe retries, a change note and an outcome for each submitted comment addressed in this version.
6. Share the new version at the same URL and wait again using the last cursor. For questions or approval, reply to the user; publish another version only when you make a geometry change.

Use `stljam feedback <project> --batch <id>` if MCP is unavailable.
