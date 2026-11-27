# Rules for agents in Kinloom

This repository is a **public MIT open-source project**.

- NEVER commit private family names, living-relative records, private email addresses, GEDCOM exports, or scanned personal family documents here.
- Keep all domain logic, tests, and fixtures strictly synthetic or verified public-domain historical examples.
- Keep `@kinloom/cli` pure TypeScript under `packages/cli/src/` (all research commands and embedded guides live there; do not add `.py` files, `uv` scripts, or a `skills/` directory).
- Avoid git worktrees. Commit directly to `main` unless instructed otherwise.
- Run `npm run check:leaks` and `npm run check:contrast` (plus lint and tests as packages land) before committing.
