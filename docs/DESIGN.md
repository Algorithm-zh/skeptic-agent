# Skeptic design notes

## Problem

Coding agents are evaluated by their own completion reports. A typical report says "all tests pass" and leaves behind a diff. CI trusts whatever test command is left in the repository. A deletion, a skip marker, or an edited assertion can turn a failing suite green without changing the implementation.

Existing review tools mostly read diffs. Skeptic adds execution and comparison: it re-runs the proposed code, re-runs the baseline when attribution matters, audits test integrity, and emits a deterministic verdict backed by artifacts.

The design goal is **low false-positive, execution-level verification** that is neutral across agents and models.

## Goals and non-goals

### Goals

- Verify a dirty working tree or a committed base/head range without mutating the user's repository.
- Distinguish an attributable regression from a pre-existing failure.
- Require proof for "fixes #N" claims.
- Detect common forms of test and verification weakening.
- Work without an LLM or an API key.
- Produce a machine-readable receipt that another tool or human can re-check.
- Keep the verdict deterministic and reproducible.

### Non-goals for v0.1

- Generating code or fixing failures.
- Proving semantic equivalence of tests.
- A security sandbox or network isolation.
- Automatic detection of every language and package manager.
- Hosted verification, PR comments, HTML reports, badges, or receipt signatures.

These are deliberate omissions, not forgotten features.

## The audit loop

Skeptic behaves like a bounded agent, but its action space is intentionally narrow:

1. **Observe** — read the diff, base/head refs, trusted config, repository structure, and optional claims.
2. **Plan** — decide which checks need a base run, which reproductions are configured, and which claims need evidence.
3. **Act** — create isolated snapshots, execute trusted commands, run reproductions.
4. **Observe** — capture exit codes, durations, logs, logs hashes, and test summaries.
5. **Re-plan** — attribute failures, taint proofs that depend on modified tests.
6. **Conclude** — apply fixed verdict rules.

The "constitution":

- Do not trust the verified agent's self-report.
- Do not trust verification rules modified by the verified agent.
- Do not claim anything beyond the evidence.
- An LLM may help interpret claims; it cannot change the verdict.

## Components

```text
src/
├─ cli.ts                       command surface
├─ commands/
│  ├─ init.ts                   generate a verification contract
│  ├─ verify.ts                 orchestrate and render a run
│  ├─ demo.ts                   four self-contained scenarios
│  ├─ report.ts                 render/verify a saved receipt
│  └─ doctor.ts                 environment and trust diagnostics
├─ config/{schema,load}.ts      zod schema, trusted loading
├─ git/{git,changes}.ts         worktrees, manifests, diffs
├─ exec/{runner,env,test-summary,process-tree}.ts
├─ forensics/{inventory,rules,paths}.ts
├─ verify/{orchestrator,claims,reproduction,verdict}.ts
├─ receipt/{hash,markdown,console,schema,write}.ts
├─ llm/{client,claims}.ts       advisory claim extraction
└─ types.ts
```

The data flow is:

```text
Input resolver -> snapshot manager -> verification orchestrator -> receipt writer
```

`verifyRepo()` in `src/verify/orchestrator.ts` is the integration point used by the CLI, the GitHub Action, the demo, and the tests.

## Snapshots and repository isolation

Skeptic never edits the user's working tree or index.

- **Base** is a detached `git worktree` at the base SHA.
- **Head** is a detached worktree at the head SHA. For a dirty working tree, the head worktree is created from `HEAD` and overlaid with the working state.
- The overlay manifest comes from `git diff --name-status -M` plus `git ls-files --others --exclude-standard`.
- Files are copied or deleted directly. Skeptic does **not** apply patches. This avoids failures with `core.autocrlf`, binary files, and non-ASCII paths.
- Ignored files are not copied. The receipt records this as a limitation.
- Worktrees are removed in a `finally` block, followed by `git worktree prune`. `--keep-worktrees` preserves them for debugging.
- `.skeptic/` is added to `.git/info/exclude` so artifacts never appear in `git status`.

All git invocations use `-c core.longpaths=true`. Temporary directories live in the system temp directory, not inside the repository.

Integration tests assert that `git status`, the staged tree (`git write-tree`), the index bytes, and the worktree list are unchanged after verification. The fixture matrix additionally covers deleted, renamed, untracked, binary, and Chinese-path files.

## Trusted configuration

The verification contract is `skeptic.yml`. It is read from the **base revision** with `git show <base>:skeptic.yml`.

- A head-side config change is parsed only for diagnostics.
- Removed checks, changed or disabled commands, downgraded checks, and modified reproductions are hard findings.
- A comment-only or timeout-only change is a soft finding.
- The head config is never adopted.
- If no base config exists, an uncommitted config requires `--trust-config`; the receipt records `config.source = trusted-worktree`.
- `--config <path>` is an explicit trusted override and records `config.source = override`.
- CRLF is normalized before hashing and comparison, so Windows checkout settings do not create false drift.

Commands always come from the trusted config. The LLM has no path to command generation.

## Execution

`runCommand()` wraps `execa` with:

- a shell command executed in the snapshot directory;
- a per-check timeout, plus a process-tree kill (`taskkill /T /F` on Windows, process-group kill on POSIX);
- a 10 MB log cap with head/tail preservation;
- a log file plus SHA-256;
- ANSI-stripped output excerpts for the receipt;
- deterministic environment defaults.

The environment is built from an allowlist of OS and shell variables. Secret-looking values are not passed. `NODE_OPTIONS` and git repository overrides are removed. The config can explicitly pass or set variables (`env.pass`, `env.set`).

`npm_config_ignore_scripts=true` is set unless `allowScripts` is explicitly enabled. Setup defaults to `npm ci --ignore-scripts`.

Base checks are run only when a required head check failed or when a reproduction is configured. This keeps the common passing case fast.

## Reproductions

A reproduction is a command plus an expectation:

```yaml
reproductions:
  - id: issue-42
    name: "Issue #42"
    run: npm test -- tests/price.test.ts
    expect: fail-before-pass-after
```

The command runs on base and head:

| Base | Head | Status |
| --- | --- | --- |
| failed | passed | `proven` |
| failed | failed | `not_proven` |
| passed | passed | `not_proven` |
| anything else | anything else | `inconclusive` |

A `proven` result can support a matching "fixes #N" claim. But the proof is tainted if:

- the reproduction command directly references a test file that changed;
- it runs a generic suite whose test files changed without adding tests;
- the total test declaration count fell;
- a hard integrity finding exists.

Taint turns the status into `tainted`, which caps the verdict at `unverified` and makes the fix claim unsupported. This is the core defense against "make the test pass by changing the test".

## Forensics

The forensics engine receives the diff, base/head test inventories, config diff, check results, reproductions, and package manifests. Test declarations and assertions are counted heuristically from common patterns (Node test, Jest/Vitest, pytest, Go, Rust, Java, C#, Ruby).

### Config rules

| Rule | Severity |
| --- | --- |
| `config_removed`, `config_unparseable` | hard |
| `check_removed`, `check_command_disabled`, `check_command_modified`, `check_downgraded` | hard |
| `reproduction_modified` | hard |
| `protection_modified`, `config_modified` | soft |

### Test integrity rules

| Rule | Severity |
| --- | --- |
| `test_file_deleted`, `test_file_emptied` | hard |
| `tests_weakened_to_pass` | hard |
| `test_skip_added`, `test_focus_added` | soft |
| `test_count_decreased`, `assertions_reduced` | soft |
| `test_files_reorganized` | soft |

### Execution evidence rules

| Rule | Severity |
| --- | --- |
| `test_script_disabled` | hard |
| `zero_tests_executed`, `all_tests_skipped` | hard |
| `executed_test_count_dropped` | hard |
| `test_script_modified` | soft |

### CI, configuration, and dependency rules

| Rule | Severity |
| --- | --- |
| `ci_test_bypass`, `ci_test_step_removed`, `ci_workflow_deleted` | soft |
| `test_config_weakened` | soft |
| `lockfile_drift`, `install_script_added` | soft |
| `protected_file_modified` | soft |

Every finding includes a rule id, severity, title, message, and optional `file`, `line`, and evidence. The rule engine is data-driven and can be extended without touching verdict logic.

## Verdict precedence

The verdict is computed in this order. The first matching rule wins.

1. Required check errored or timed out -> `unverified`.
2. Required check failed and passed at base -> `failed` (regression).
3. Required check failed and also failed at base -> `unverified` (pre-existing).
4. Required check failed, baseline unavailable -> `unverified`.
5. Reproduction tainted -> `unverified`.
6. Reproduction `not_proven` with both sides failing -> `failed`.
7. Any other `not_proven` or `inconclusive` reproduction -> `unverified`.
8. Any hard finding -> `unverified`.
9. A material deterministic claim is contradicted -> `failed`.
10. A material deterministic claim is unsupported -> `unverified`.
11. Any soft finding -> `verified_with_warnings`.
12. Otherwise -> `verified`.

`exitCodeForVerdict()` maps `verified` and `verified_with_warnings` to 0, and `unverified`/`failed` to 1. `--fail-on warnings` raises the bar; `--fail-on never` always exits 0.

The ordering is intentional:

- Hard findings cap but do not escalate. A suspicious change is not called malicious.
- Pre-existing failures do not blame the agent.
- Claims can only produce `failed` after execution evidence has been considered.

## Claims and LLM isolation

Claims are extracted in two ways:

- **Heuristics** recognize test-pass phrasing and `fixes/closes/resolves #N` references. These claims are material and participate in the verdict.
- **Optional LLM** returns a strict JSON object `{claims:[{text,type,checkId?,rationale?}]}`. The user's claim text is fenced as untrusted data. The response schema is validated; commands, verdicts, and evidence fields are stripped. Unknown check ids are discarded. LLM failure degrades to heuristics.

A claim is evaluated deterministically:

- `tests_pass` requires every required check to pass, actual executed test results in the output, and no hard integrity finding.
- `bug_fixed` requires a matching reproduction that is `proven`; tainted, failing, or missing reproductions make it unsupported or contradicted.

LLM-sourced claims are included in the receipt but excluded from the verdict. This guarantees that `--no-llm` and LLM mode produce the same verdict, which is enforced by tests.

## Receipts

The receipt is canonical JSON plus a SHA-256 over the canonical form. The canonicalizer sorts object keys recursively and removes `undefined` values, so two equivalent receipts hash identically across platforms.

Receipt snapshots replace absolute temporary paths with `<base-snapshot>`, `<head-snapshot>`, or `<snapshot-root>` to avoid leaking local paths. Logs live beside the receipt and store raw command output; the receipt stores only hashes and short excerpts.

See [RECEIPTS.md](RECEIPTS.md) for the schema and verification procedure.

## Error handling

- Configuration errors are `SkepticError`s with actionable hints.
- A failed setup marks checks as not executed and the verdict as `unverified`.
- A missing baseline is recorded as `baseline_unavailable`, not as a regression.
- LLM errors are reported through progress output and never fail verification.
- Worktree cleanup errors are reported but do not hide the receipt.
- The CLI sets `process.exitCode` from the verdict; unexpected errors print a message and exit 1.

## Testing strategy

- **Unit tests** cover hashing, config validation, the test-output parser, environment scrubbing, path safety, forensics rules, claim evaluation, and verdict precedence.
- **Fixture matrix** (`bench/`) runs 12 labeled scenarios through the real orchestrator: legitimate fixes, CI bypass, lockfile drift, reduced assertions, skipped suites, weakened assertions, deleted tests, disabled test scripts, config tampering, a regression, and a pre-existing failure.
- **Integration tests** cover dirty overlays (deletion, rename, binary, Chinese path, ignored file), repository read-only guarantees, config trust, base/head preference, LLM prompt injection, CLI help, and packaged-install smoke tests.
- **CI** runs typecheck, tests, build, CLI demo, and package smoke tests on Ubuntu and Windows with Node 22 and 24.

The fixture matrix is a regression suite, not a general benchmark. It is designed to keep verdicts honest as rules evolve.

## Future work

- Container sandbox and network isolation.
- Receipt signatures and a public verification badge.
- Allowlists for legitimate test changes to reduce soft warnings.
- Pull request annotations and SARIF output.
- More language and package-manager support.
- Verification of Agent Skills and MCP manifests.
