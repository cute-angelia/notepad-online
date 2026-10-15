# Markdown editor and protected sharing

Approved in chat: 2026-10-15, user said “开工”.

New notes default to Markdown; legacy notes migrate to plain text and secret `twins`. Store title, document_type, a bcrypt secret hash, locked (Unix seconds), failed_attempts and failure_day. A locked value of zero permits editing; a future timestamp blocks every write, including authorized browsers. Ten failed secret attempts across all visitors in one Shanghai calendar day lock until the next local midnight. Manual SQL unlocking with locked=0 also resets exhausted attempts on the next request.

Public /:id is always a viewer. /:id/edit requires a browser grant. A persistent HttpOnly, SameSite cookie identifies an anonymous browser, with per-document grants stored server-side for one year. New note creation and successful secret verification grant access. An authorized browser can replace the secret without entering the old secret; other grants expire after rotation. Secrets never appear in public output or server storage as plaintext. Share copies the public URL after saving.

Telegraph-inspired white page, centered 1120px article, borderless large title, compact secret row, generous whitespace. Desktop supports a minimal Markdown toolbar and optional live split preview. Mobile hides toolbar and preview; keeps type switch, sharing and secret controls. Editing source and switching type never alter the body. Save errors are visible and never mark unsaved data as saved. Legacy /raw remains text output; /md remains a safe Markdown viewer.

Out of scope: accounts, attachments, publish snapshots, collaboration. Sharing shows the latest saved content.


## Follow-up adjustments

The editor and viewer now use a 1120px maximum width by default. The secret field displays plain text and copies on click; display/update buttons and the generated-secret notice are removed. Changes and random replacement join autosave. The server compares the proposed secret with the existing hash before rotation, preserving browser grants for unchanged secrets. Successfully saved or verified plaintext secrets are cached per document in browser localStorage without expiry, read only by authorized editor pages; public viewers never read the cache. Server storage remains bcrypt-only.

Read-only views omit the site header and put a small accessible edit icon immediately after the title. Reader top spacing is 32px on desktop and 24px on mobile; editor spacing below its compact header is 16px.

The editor site header now places the editable title on the left instead of the notepad brand. Secret controls sit on the right with save status, new-document and sharing actions. The empty body heading is removed; mobile wraps the controls below the title without horizontal overflow.
