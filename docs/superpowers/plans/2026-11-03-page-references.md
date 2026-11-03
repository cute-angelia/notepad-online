# Stable Page References Implementation Plan

**Goal:** Add stable-ID page links, live embeds, and permission-filtered backlinks without a separate page table.

**Architecture:** Reuse `notepad.id`. Store `[[page:123]]` and `![[page:123]]` in Markdown. A derived `note_links` table records unique source/target/kind edges transactionally on create/save. Read APIs return explicit safe DTOs only after checking the target's existing viewer grants. No global page directory is exposed.

**Tech Stack:** Go/Gin/GORM, Goldmark for server-side Markdown parsing, existing marked renderer and vanilla JavaScript/CSS.

## Task 1: Reference Index

- [x] Add parser tests for links, embeds, duplicates, code, escaping, and malformed IDs.
- [x] Add `model.NoteLink`, migration, and Markdown-aware extraction in a focused model file. Store existing target IDs only; source text is authoritative.
- [x] Add integration tests for transactional create/save, mode switching, link removal and failed saves.
- [x] Update create/save to synchronize edges in the same database transaction. Return created ID for draft UI.

Run: `go test ./model ./controller/notepad`.

## Task 2: Safe Page Reads

- [x] Test and implement ID resolution, metadata/body reads, stable `/api/pages/:pageID/view` views (avoiding collisions with existing slugs), and backlinks.
- [x] Reuse public/private viewer checks; unauthorized and missing API targets both return 404 without metadata. Filter each backlink source by visibility in SQL. Never serialize model secrets.
- [x] Resolve exact slug or numeric ID only; don't expose title search or a global directory. Set no-store on all reference responses.

Run: `go test ./controller/notepad -run 'Page|Reference|Backlink'`.

## Task 3: Rendering and UI

- [x] Add Node tests for marked extension behavior, escaping, stable URL parsing, limits and stale render handling.
- [x] Add `static/page-references.js` and CSS. Register a marked inline extension, sanitize generated placeholders, hydrate via same-origin page APIs, and limit embeds to depth 3 / count 20 / reads 32 per render.
- [x] Add an accessible insertion dialog accepting a same-origin URL, slug, ID or copied reference. Capture an insertion bookmark, clear it on dismissal, and don't modify content after cancelled requests.
- [x] Add copy-reference and backlink controls to editor/reader. Update draft ID after create. Use existing visual styles and make insertion accessible on mobile.
- [x] Keep source synchronous; asynchronous hydration must discard stale responses and never move editor focus. Render embedded text/code without treating it as Markdown.

Run: `node --test tests/*.test.cjs`.

## Task 4: Delivery Verification

- [x] Document syntax, permissions and limitations in README.
- [x] Run full Go and Node suites plus `git diff --check`.
- [x] Use the opt-in in-memory local fixture and WebKit browser checks for insertion, preview, embeds, backlinks, title changes, private access and mobile focus.
- [x] Keep work uncommitted and undeployed. Database integration tests use SQLite; no live MySQL test was run.

## Added Scope: Slash Commands

- [x] Add a keyboard/touch `/` menu using the existing formatting adapter. Include headings, lists, quote, code, table, divider, media uploads, page links and embeds.
- [x] Trigger only at line start outside code; filter Chinese/English keywords, support Escape/outside dismissal and IME composition, and preserve focus.
- [x] Test detection/filtering/insertion and verify desktop/mobile browser behavior.

## Review Hardening

Migration completion is recorded transactionally in `data_migrations` so failed historical backfills retry. Backlinks use SQL visibility filtering and a 100-row limit. Expected reference-resource misses remain 404 but do not count as unknown-path scans; malformed IDs retain normal scan protection. Hydration skips hidden preview and reuses at most 64 in-memory reads for 30 seconds to avoid exhausting the application's request limiter while typing.
