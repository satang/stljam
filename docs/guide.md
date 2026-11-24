# StlJam user guide

StlJam helps you review a mechanical part or assembly with an AI coding agent. You can show the agent exactly where a cavity needs clearance, which wall you want to change, or what you see in a section cut. StlJam saves that context with your feedback so you can return to it when the next version is ready.

## Try a first review

Start StlJam and load the example gearbox using the [quick start](../README.md#quick-start). The demo includes both versions, so you can try a complete review before connecting an agent.

1. Open the demo link and select **Housing** in the parts list. Choose **Isolate selection** below the list to show only the housing. With no part selected, the same button reads **Hide all**. Choose **Show all** whenever you want to restore the full assembly.
2. Turn on **Section** and move the plane to expose a wall. Choose **Measure** and click the two surfaces you want to measure between. The viewer shows the endpoints and the straight-line distance on the mesh.
3. Choose **Region** and drag over the wall you want to discuss. The outline keeps its orientation in the model as you orbit. A region can include multiple visible parts. Isolate a part first to focus your feedback on it. For a single location, use **Point**.
4. Write a comment in the lower-right composer. For example, “Thicken this wall outward and keep the inside face in place.” Choose **Add comment** or press Enter to add it to the list. You can add more comments and edit or remove them before sending.
5. When the list is ready, choose **Submit review** at the top of the comments panel. That sends all the comments together and closes the version for feedback.
6. Run the quick start's `demo --next` command. Open **Compare** to see v1 and v2 with synchronized cameras, section plane, and part visibility. Open the original comment on v1 to restore its view and mark. The saved screenshot shows what you saw when you wrote the comment.

StlJam sends the original view and, for marked or measured geometry, a close-up with feature edges and separate part colors. With an active section, the close-up looks straight at the saved plane. A close-up can help locate mating surfaces. Use the editable CAD model to verify clearances.

Each new measurement gives the agent the part, local point, and local surface normal for A and B, along with the distance in assembly coordinates. An endpoint on **Section** fill is labeled as a virtual surface. Pick actual model surfaces when you want the agent to identify the corresponding CAD faces.

Use **Paint** to drag with the left mouse button or a finger across the visible surfaces you want to mark, including across parts. Right-click or right-drag to erase paint, or select **Erase** and use the same gesture as painting. **Undo last** reverses the latest stroke or erase. Press Esc to orbit again. For feedback about several locations, add more marks before writing your comment. StlJam numbers the marks in the order you add them and keeps them together. Use **Clear** to start again.

Reloading the review in the same browser restores your last view, including hidden parts, the camera, the section plane, and any comment you were composing.

StlJam assigns contrasting colors to nearby parts using their positions in the assembly. The Parts icons and section hatching use those colors. Textured surfaces keep their embedded appearance.

## Review your own design

Follow [Connect an agent](../README.md#connect-an-agent) to use StlJam from Codex or Claude Code. Ask the agent to open a review from the editable CAD source, share the link, and wait for your feedback. For assemblies, exporting each part separately lets you hide or isolate it during review. See [Publish an assembly](../README.md#publish-an-assembly) for export formats and the manifest.

If the review shows **Agent listening**, the submitted batch goes straight to the waiting agent. If the agent has stopped waiting, the batch stays saved. Use **Copy** on the submitted review and paste it into your agent chat to continue. The agent can then apply the requested edits in the original CAD workspace and publish a revision to the same review link.

You can also review exported STL, 3MF, or self-contained GLB files using **Load models** in the browser. The editable source stays in your CAD workspace. Measurements in StlJam are based on the exported mesh. Check precise dimensions in CAD.

## Correct a submitted review

Use **Reopen review** to make an editable copy of the latest submission. Edit the list and choose **Submit review** to replace the prior batch, or choose **Return to previous submission** to discard your edits. If you remove every comment, **Withdraw previous submission** closes the reopened round and records that the previous feedback was withdrawn. Earlier batches remain in the review history.

## Inspiration

StlJam grew out of [FrameJam](https://github.com/moritzkremb/framejam), a project by [Moritz Kremb](https://github.com/moritzkremb) for reviewing video with an AI agent. StlJam brings that same cycle of preview, feedback, and revision to 3D design.
