## What changed

<!-- Describe the behavior change, not the files. -->

## Why

<!-- The failure mode, bug, or use case this addresses. Link the issue if one exists. -->

## Evidence

<!-- For rule or verdict changes, include bench output, a fixture, or before/after receipts. -->

## Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] `npm run bench` passes (if verdicts, rules, or orchestration changed)
- [ ] `npm run smoke:pack` passes (if packaging changed)
- [ ] New or changed behavior is covered by a test or fixture
- [ ] Docs updated (README, DESIGN, RECEIPTS) if user-visible behavior changed
- [ ] No secrets, private repository data, or unredacted logs are included
- [ ] The verdict remains deterministic and independent of LLM output
- [ ] The verified repository remains read-only (no index or working-tree mutation)
