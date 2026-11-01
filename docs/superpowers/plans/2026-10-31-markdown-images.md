# Markdown Image Reading Implementation Plan

**Goal:** Keep Markdown images compact without modifying source Markdown or uploaded files, and let readers inspect full-resolution images.

**Architecture:** Apply shared image constraints in `static/style.css`. Enhance sanitized images after the common renderer runs, using a standalone `static/image-viewer.js` and a native dialog shared by read-only and live-preview pages. Preserve linked-image navigation.

**Tech Stack:** Plain JavaScript, CSS, native HTML dialog, Node test runner, Go tests.

## Approved Behavior

- Inline images retain aspect ratio, never upscale, and fit within the content width, 640px width, and the smaller of 420px or 60vh height.
- Plain images open with click, Enter, or Space. Linked images retain normal navigation.
- The viewer starts fitted to the viewport, supports zoom buttons and image-click original-size toggling, and permits scrolling enlarged images.
- Escape, the close button, or clicking empty viewer space closes the dialog and restores focus without scrolling the document.
- Loading and failure states are visible; closing clears the image source. Re-rendering preview does not duplicate listeners.
- Preserve the existing sanitizer, lazy loading, referrer policy, source Markdown, and attachment APIs.

## Execution

1. Add `tests/image-viewer.test.cjs` covering enhancement, keyboard activation, zoom, modal cleanup, load errors, repeat enhancement, and shared template/style integration. Run it and verify missing-feature failures.
2. Add the shared dialog and versioned viewer assets to `templates/index.html`. Implement `static/image-viewer.js`, viewer styling, and renderer enhancement. Re-run the focused tests.
3. Document image reading in `README.md`. Run all Node tests, `go test ./...`, and `go vet ./...`. Check desktop/mobile rendering and interactions in a browser using an isolated local fixture.

## Verification

- All 68 Node tests pass, including 9 image-viewer tests verified failing before implementation.
- `go test ./...`, `go vet ./...`, and `git diff --check` pass.
- Browser checks at 1280x720 and 390x844 confirm proportional limits, original-size small images, full-screen mobile controls, original-size long-image scrolling, failure feedback, keyboard activation, Escape dismissal, and focus restoration.
- Read-only and live-preview images both use the shared viewer. The opt-in `NOTEPAD_IMAGE_BROWSER=1` Go fixture runs only against an in-memory database.
