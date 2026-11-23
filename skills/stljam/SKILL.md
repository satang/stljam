---
name: stljam
description: Publish CAD previews, review geometry with the user, and iterate through StlJam.
---

# StlJam

Keep the project's own editable source. Publish a preview as one named file per part or instance. Preserve the assembly origin, units, component identifiers and placements between exports.

Match the work to the feedback. Check the current review and reuse suitable exports and placements. A change to the view or preview may be enough. Edit the source when the user requests a design change.

## Run a design review

1. Use `open_review` to open an existing review or publish an initial manifest. Open its URL in the available browser and share it with the user.
2. In the same turn, call `wait_for_feedback` with the last feedback cursor when available. If it returns `waiting`, call it again immediately with the returned cursor. Give each newly published version up to about 10 minutes of waiting. Stop sooner if the user ends the review. At the time limit, tell the user to submit and use **Copy** to resume. When they return, use `get_feedback` with the batch ID or last cursor. A batch with `replaces` supersedes the previous submission. An empty replacement withdraws it.
3. Use the comment's source, piece, version, coordinates and captured view to locate the requested change. Before applying historical feedback, inspect the latest source and confirm that the referenced feature still corresponds. Record any ambiguous item as `needs-clarification`.
4. Verify the result at the level the request needs. For design changes, check the relevant dimensions, placement, clearance, or fit in CAD. A measurement against tessellated geometry is approximate.
5. When the preview's geometry or manifest changes, call `add_version` with the latest base version, a stable request ID for safe retries, a change note, and an outcome for each submitted comment addressed in this version.
6. After publishing a revised version in an ongoing review, share the same URL and a short change summary as a progress update. Go back to step 2 before ending the turn. For questions or approval, reply to the user.

Use `stljam feedback <project> --batch <id>` if MCP is unavailable.
