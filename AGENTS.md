## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for xchrisbailey/normie, through the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Uses the default label names: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Checks

`npm run verify` runs on every push (pre-push hook). New UI gets a step in `src/main/smoke.ts` that reaches it the way a person does, through `src/main/drive.ts`; a bug fix's step fails on the old code first. `npm run bench` checks the budgets when a change touches the key path, memory or startup.
