# Development Rules

## Conversational Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- Technical prose only, be direct
- When the user asks a question, answer it first before making edits or running implementation commands
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit
- No `any` unless absolutely necessary
- No runtime checks of values whose types TypeScript already guarantees; validate only at decided trust boundaries (wire input, schema-checked arguments)
- Inline single-line helpers that have only one call site
- Check node_modules for external API types; don't guess
- **No inline imports** (`await import()`, `import("pkg").Type`). Top-level imports only
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead
- Use only erasable TypeScript syntax (Node strip-only mode): no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`
- Always ask before removing functionality that appears intentional
- Do not preserve backward compatibility unless the user asks for it
- Never modify `packages/ai/src/models.generated.ts` directly; update `packages/ai/catalog/` and regenerate

## Commands

- After code changes (not docs): `npm run check` (biome + iris type check). Fix every error before committing
- Tests: `npm test` at the root runs `packages/iris-core` (`node --test`). Run a single file with `cd packages/iris-core && node --test test/<name>.test.ts`
- Live turn against the local Magpie gateway: `npm run live`
- `npm run build` builds `telemetry`, `schema`, `ai`, `agent` into `dist/`. `packages/ai` needs network for `generate-models`; use `npm run build:offline` to skip the catalog refresh
- For ad-hoc scripts, write them to a temp file, run, edit if needed, remove when done. Don't embed multi-line scripts in shell commands
- Never commit unless the user asks

## Dependency and Install Security

- Direct registry deps, including internal workspace deps, stay pinned to exact versions
- Hydrate/update locally with `npm install --ignore-scripts`
- If dep metadata changes, refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts`

## Git

- Stage explicit paths (`git add <path1> <path2>`); never `git add -A` / `git add .`
- Before committing, run `git status` and verify you are only staging your files
- Message format: `{feat,fix,docs,chore}[(iris,ai,agent)]: <commit message>`
- Never run `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git commit --no-verify`

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.
