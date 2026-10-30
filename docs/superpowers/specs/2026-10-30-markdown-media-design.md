# Markdown Editing and Media

## Approved Scope

Keep Markdown markers visible and render heading sizes/syntax styles inside the editor. Add heading levels, inline formatting, lists/tasks, links, images/videos, tables, quotes, code, separators, undo/redo and responsive overflow. Preserve the existing save, access, preview, outline, text and code behavior.

Upload images up to 20 MiB and videos up to 5 GiB to configured MinIO bucket/prefix using `prefix/YYYY-MM/random.ext` (Asia/Shanghai). Attachments have public permanent URLs, including on private notes. Do not change bucket policies automatically.

Removing an uploaded attachment reference during editing immediately deletes its MinIO object. Do not wait for a note save, add a retention window, recycle bin, or cross-note reference counting. External links are never deleted. Deletion requires edit access to the owning note. Undo does not restore deleted objects.

## Implementation Boundaries

Use a locally vendored Markdown source editor, with the existing textarea kept synchronized for autosave and existing integrations. Use a narrow editor adapter for selection, insertion, read-only state and scrolling.

Browser slices files into 8 MiB chunks. Go streams one part at a time to a MinIO multipart upload. Parts may be retried; cancellation aborts the multipart upload. Neither browser nor Go reads the entire file into memory. Keep ordinary request limits intact. Store only note ownership and multipart/attachment metadata; no delayed deletion subsystem.

Insert images as Markdown images and videos as links titled `video`; render videos through the existing HTML allowlist, never by enabling arbitrary HTML.

## Verification

Add tests for editor rules, media rendering and URL safety, multipart ordering/retry/cancel, immediate reference removal, upload size validation, object paths, authorization, bounded streams and deletion. Run existing Go and Node suites, Go vet/build, and desktop/mobile browser smoke tests. Real MinIO writes/deletes are not needed for tests.
