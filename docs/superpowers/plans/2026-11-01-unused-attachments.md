# Unused Attachment Review Implementation Plan

**Goal:** Stop deleting files when Markdown links disappear during editing. On the next editor entry, offer to keep or explicitly delete previously unreferenced attachments.

**Architecture:** Persist a `Retained` flag on each attachment. The authorized attachment list includes the saved source; a per-attachment review endpoint records retention or explicitly deletes an unretained completed object against that exact saved-source snapshot. A native editor-only dialog reviews an entry-time candidate snapshot, with no destructive input listener.

**Tech Stack:** Go/GORM automatic migration, plain JavaScript, native HTML dialog, existing styles, Node and Go tests.

## Accepted Behavior

- Cutting, pasting, deleting links and undoing never delete completed attachments.
- On editor initialization, prompt for completed, unretained attachments absent from the entry source, the current editor source, and the server's saved source.
- Keep persists for the selected attachments across sessions and devices. New unused attachments still prompt on a later editor entry. Dismissal without a choice does not retain them.
- Delete explicitly removes only the listed, still-unreferenced attachments. A changed saved source or retention decision in another tab rejects stale deletion. Upload cancellation retains its existing cleanup behavior.
- Keep/delete failures remain visible and retryable. Busy dialogs cannot be dismissed while decisions are in flight. Successful per-file actions are not retried after a partial failure.
- Preserve image-viewer work already in the worktree. Do not commit unless requested.

## Steps

1. Add failing Node regression tests for cut/paste preservation, entry-only prompts, persistent retention, safe deletion, dismissal, reload, late list responses, and partial failures. Add Go tests for retention persistence, authorization/ownership/lock, invalid actions, incomplete attachments, and stale-delete rejection.
2. Add the attachment field, response/source data and per-attachment review route. Replace input-triggered deletion with an entry-review dialog. Reuse existing upload failure cleanup; do not introduce background deletion.
3. Update README and stale media design documentation to supersede immediate deletion. Run all Node tests, Go tests, vet and diff checks. Verify the dialog in the local fake-storage browser fixture, then review the diff.

## Verification

- All 84 Node tests pass, including cut/paste preservation, per-file persistence, entry-only review, busy state, partial retries, restored references and matching button styles.
- Go tests and vet pass. A disk-backed SQLite close/reopen test confirms the retention flag is not dependent on process memory.
- Review found URL alias and Markdown-escape edge cases; added failing regressions and conservative unique-filename guards on both sides before re-running tests.
- Browser checks confirm Keep then reload suppresses the prompt, actual image-line cut/paste triggers zero fake-storage removals, and the two dialog buttons share outline styling on normal and 390px viewports.
- Browser fixtures use only in-memory test databases and fake storage, never real MinIO data.
