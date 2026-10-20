# Contributing to Skeptic

Skeptic is a verification tool. Contributions are judged by the same standard it
applies to agents: evidence over claims. A rule, verdict change, or bug fix
should come with a fixture that demonstrates the behavior.

## Development setup

Requirements: Node.js 20 or newer, Git, and npm.

```bash
git clone https://github.com/Algorithm-zh/skeptic-agent.git
cd skeptic-agent
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
node dist/cli.js demo
```

Useful commands:

| Command | Purpose |
| --- | --- |
| `npm run dev -- verify` | Run the CLI from source with tsx |
| `npm test` | Unit, integration, and CLI tests |
| `npm run bench` | Run the 12-scenario fixture matrix via the real orchestrator |
| `npm run typecheck` | TypeScript, no emit |
| `npm run build` | Bundle to `dist/` |
| `npm run smoke:pack` | Pack, install in a temp dir, run `--version` and `demo` |

`npm ci --ignore-scripts` is deliberate: Skeptic itself disables install
lifecycle scripts by default, and development should not require them either.

## Project constraints

These are not style preferences; changing them changes the product's claims.

- **The verdict engine is deterministic.** No rule may depend on an LLM, network
  access, or wall-clock timing.
- **LLM output is advisory.** It may add or classify claims. It must never
  produce commands, findings, verdicts, or evidence statuses.
- **The verified repository is read-only.** Snapshot isolation must not stage,
  modify, or delete tracked files in the user's working tree, and must not
  mutate the index. Integration tests assert this.
- **Commands come from the trusted config.** Agents and claims cannot inject
  commands. Do not add a code path that executes text originating from a claim,
  a model response, or an untrusted config.
- **No new runtime dependency without justification.** Prefer the standard
  library. A dependency that parses YAML, runs processes, or diffs files is
  earning its place; a convenience wrapper probably is not.
- **Findings are evidence, not accusations.** Describe what changed and where.
  Do not infer intent.

## Adding a forensics rule

1. Add the rule to `src/forensics/rules.ts` with a stable snake_case `rule` id,
   a severity (`hard`, `soft`, or `info`), and a precise message.
2. Attach `file`, `line`, and `evidence` whenever the signal can be located.
3. Add a unit test in `tests/unit/forensics.test.ts` covering a positive case
   and at least one near-miss that must not fire.
4. If the rule affects verdicts or reproduction taint, add a scenario to
   `bench/scenarios.ts` with its expected verdict, expected rule, and exit code.
5. Update the rule tables in `README.md`, `README.zh-CN.md`, and
   `docs/DESIGN.md`.

Avoid rules that depend on exact test-framework formatting. Output parsers are
best-effort by design; a rule that misfires on a common formatter is worse than
no rule.

## Adding a scenario

`bench/scenarios.ts` is the regression matrix. Each scenario has a base commit,
head changes, an expected verdict, expected finding rules, and optional claim
and attribution expectations.

A good scenario is small, realistic, and has exactly one reason for its verdict.
If a scenario can pass for the wrong reason, split it. `bench/harness.ts` also
asserts read-only behavior, receipt integrity, path sanitization, and log
hashes; new scenarios inherit those checks automatically.

## Testing claims and LLM behavior

Any change touching claims or the LLM client must preserve this invariant:
`--no-llm` and LLM mode produce the same verdict for the same repository. The
integration test in `tests/integration/llm.test.ts` includes a malicious mock
response and must keep passing.

When testing prompt handling, treat model output as hostile input. Add the
attack string to the test corpus rather than special-casing it in the parser.

## Action changes

`action.yml` runs on pull requests from forks. Keep it that way.

- Trigger only on `pull_request`, never `pull_request_target`.
- `permissions: contents: read`; do not add write scopes.
- `persist-credentials: false` on checkout.
- Do not pass repository secrets into the verified code or the action step that
  runs it.
- Artifacts upload with `if: always()` so failed verifications leave evidence.

## Pull requests

Before opening a PR:

```bash
npm run typecheck
npm test
npm run bench
npm run build
npm run smoke:pack
```

In the description, state what changed, why, and what evidence supports it. For
verdict or rule changes, include before/after output from `bench` or a minimal
repository. Link the issue if one exists.

Keep changes focused. A new rule and an unrelated refactor belong in separate
PRs. If a change intentionally alters an existing verdict, call it out — that is
a behavior change, not a cleanup.

## Commit messages

Conventional prefixes are appreciated: `feat:`, `fix:`, `docs:`, `test:`,
`refactor:`, `chore:`. The subject should describe the behavior, not the files.

## Reporting bugs

Use the bug report template. Include the Skeptic version, OS, Node version, the
command you ran, the expected verdict, the actual verdict, and — if possible —
the relevant part of `receipt.json` with logs redacted.

Do not attach receipts or logs from private repositories without reviewing them
for sensitive output. For security vulnerabilities, follow `SECURITY.md` instead
of opening a public issue.

## License

By contributing, you agree that your contribution is licensed under the MIT
License.
