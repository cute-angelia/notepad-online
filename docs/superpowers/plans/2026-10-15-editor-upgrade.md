# Editor Upgrade Implementation Plan

> Execute inline in this session; user authorized implementation.

**Goal:** Markdown-first editing with protected public sharing and a Telegraph-inspired interface.
**Architecture:** Keep Go/Gin/GORM and the existing vanilla frontend. Separate browser grants, lock policy and HTTP handlers. Use database transactions and row locks for authorization/lock/write consistency.
**Tech Stack:** Go, Gin, GORM/MySQL, bcrypt, local marked renderer; SQLite only for integration tests.

- [x] Add integration tests for migration, read-only sharing, browser authorization, secret rotation, ten-attempt global lock, calendar expiry and SQL unlock. Run tests first to demonstrate missing behavior.
- [x] Extend model, migrate legacy notes safely, detect duplicate tags before unique indexing. Check startup migration errors.
- [x] Add cryptographic browser tokens, hashed grants, bcrypt secrets, Shanghai-day lock policy, same-origin write protection and transactional handlers. Preserve existing raw/Markdown URLs.
- [x] Replace editor/viewer templates and styles. Add serialized autosave, error feedback, title/type/secret editing, copy-after-save, live safe Markdown preview and toolbar selection actions.
- [x] Run Go tests with race detector, go vet and production build. Run browser checks using an isolated SQLite test server; verify mobile widths, sharing, authorization, lock and hostile Markdown. Document schema and operations in README.

## Verification notes

- Authorization, migration, browser cookie renewal, expiry, secret rotation and global daily lock are covered by isolated SQLite integration tests.
- Independent code review found legacy URL escaping and cookie renewal issues; both have regression tests and fixes.
- Browser checks: desktop split preview; plain text round trip; selected-text formatting; persisted browser authorization; public reading; copy feedback; hostile Markdown sanitization; global lock notice; 390px mobile controls and long title wrapping.
- Production MySQL was not contacted or modified. Production startup performs the schema migration with errors checked.
