## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for xchrisbailey/normie, through the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Uses the default label names: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### ui-sdk

Before using ui-sdk, follow the ui-sdk skill if it's installed, and read `node_modules/@ui-sdk/react/docs/llms.txt`. To build a new component, also search `node_modules/@ui-sdk/react/docs/core.md` by heading, and read `rendering.md` next to it.

### Checks

`npm run verify` runs on every push (pre-push hook) and in CI on pull requests and `main` (`.github/workflows/verify.yml`, macOS); `npm run format` fixes what its format check finds. New UI gets a step in `src/main/smoke.ts` that reaches it the way a person does, through `src/main/drive.ts`; a bug fix's step fails on the old code first. `npm run bench` checks the budgets when a change touches the key path, memory or startup. `npm run dev:fake` is for looking at UI by hand; checks run against the build.
