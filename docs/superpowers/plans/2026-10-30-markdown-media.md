# Markdown Editor and Media Implementation Plan

> **For agentic workers:** Use subagent-driven development with independent backend/editor ownership and root integration.

**Goal:** Deliver the approved Markdown editing, toolbar and direct-delete MinIO media workflow.

**Architecture:** Keep the existing Go/vanilla web app. Vendor the source editor locally, stream bounded multipart media through authenticated Go endpoints, and delete owned attachments immediately on editor reference removal.

**Tech Stack:** Go, Gin, GORM, MinIO Go SDK, vanilla JavaScript, CodeMirror, Node test runner.

### Backend
- [x] Add failing handler/storage tests for auth, limits, month paths, streamed parts, complete and immediate delete.
- [x] Implement attachment model and storage adapter, multipart routes and configurable startup integration.
- [x] Run `go test ./...` and `go vet ./...`.

### Editor
- [x] Add failing rules/adapter tests, then vendor and integrate Markdown source styling, list handling and toolbar.
- [x] Preserve mode switching, outline, read-only state and scroll sync.
- [x] Run `node --test tests/*.test.cjs`.

### Media Client and Rendering
- [x] Test URL extraction, immediate removal, limits, bounded chunk requests, retry and abort.
- [x] Implement picker/paste/drop, sequential multipart transfers and explicit error/retry/cancel feedback.
- [x] Render video-title links using sanitized video nodes; keep arbitrary HTML disabled.
- [x] Document configuration, public URL policy, immediate deletion and reverse proxy upload requirements.

### Integration
- [x] Review agent changes and run full suites, vet and build.
- [ ] Smoke test Markdown lists/styles/toolbar, preview/media and desktop/mobile layout in a local browser.
