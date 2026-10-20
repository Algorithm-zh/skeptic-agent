# Skeptic

**Independent verification for AI-written code. Evidence, not claims.**

[![CI](https://github.com/Algorithm-zh/skeptic-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/Algorithm-zh/skeptic-agent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

> Your agent says done. Skeptic checks.

<img src="https://raw.githubusercontent.com/Algorithm-zh/skeptic-agent/main/assets/demo.gif" alt="Skeptic demo: four agents claim tests pass. One is VERIFIED; three are UNVERIFIED because tests were skipped, expectations were changed, or the fix claim lacks evidence." width="960">

Coding agents can fix the bug. They can also delete the failing test, skip the suite, edit the assertion, or replace `npm test` with `true`. CI runs whatever is left. Skeptic checks what changed.

Skeptic is not another coding agent. It takes a change and a completion claim, re-runs the work in isolated snapshots, compares the baseline with the proposed result, audits test integrity, and produces a deterministic verdict plus a machine-readable evidence receipt.

```text
$ skeptic verify --claims "All tests pass. Fixes #42."

  Snapshotting 4f2c1a9d7b3e and the working tree...
  Found 2 changed file(s).
  Running check "unit" on the proposed code...
  Running check "unit" on the baseline for attribution...
  Running reproduction "issue-42" on the baseline...
  Running reproduction "issue-42" on the proposed code...

  UNVERIFIED
  Reproduction "issue-42" was tainted: the test file it depends on was modified.

  Receipt  .skeptic/runs/2026-10-20T07-51-05-051Z-aydenm/receipt.json
  Report   .skeptic/runs/2026-10-20T07-51-05-051Z-aydenm/report.md
```

## Try it in 30 seconds

No API key. No external service. The demo creates four temporary git repositories, where four agents make the same claim: **"All tests pass."**

```bash
git clone https://github.com/Algorithm-zh/skeptic-agent.git
cd skeptic-agent
npm ci
npm run build
node dist/cli.js demo
```

Expected result:

```text
[1/4] The agent actually fixed the bug
      VERIFIED  as expected
[2/4] The agent skipped the failing test
      UNVERIFIED  as expected
[3/4] The agent changed the assertion to match the bug
      UNVERIFIED  as expected
[4/4] The agent hardcoded the tested value
      UNVERIFIED  as expected

4/4 verdicts matched expectations
```

After the npm release, the same demo is available as `npx skeptic-agent demo`.

## Use it on a real repository

```bash
# From this checkout (or after npm install -g skeptic-agent)
node dist/cli.js init
git add skeptic.yml .gitignore
git commit -m "add skeptic verification contract"

node dist/cli.js verify --claims "All tests pass. Fixes #42."
```

`init` detects `npm test` and writes a verification contract. Skeptic reads that contract from the **base git revision**, never from the agent's working tree. If you want to verify before committing the contract, pass `--trust-config` explicitly.

### Commands

| Command | Purpose |
| --- | --- |
| `skeptic init` | Create `skeptic.yml` and ignore `.skeptic/` |
| `skeptic verify` | Verify a dirty working tree or a committed base/head range |
| `skeptic demo` | Run four self-contained scenarios, no API key needed |
| `skeptic report` | Render the latest (or a specific) receipt as Markdown |
| `skeptic doctor` | Check Node, git, config trust, and test script setup |

Useful `verify` options:

```bash
--base <ref> --head <ref>   # verify a committed range instead of the working tree
--claims "<text>"           # claims made by the agent
--claims-file <path>        # read claims from a file
--trust-config              # explicitly trust an uncommitted skeptic.yml
--config <path>             # use an explicit config as a trusted override
--fail-on <mode>            # warnings | unverified | never
--json / --markdown         # machine-readable or report output
--keep-worktrees            # keep the isolated base/head snapshots for inspection
```

## How it works

```text
agent change + claims
          |
          v
  base snapshot  +  head snapshot       (git worktrees, isolated from your index)
          |              |
          |              +-- dirty working tree overlaid by copy, not patch
          v
  trusted skeptic.yml  (read from the base revision only)
          |
          +--> checks on head
          |       |
          |       +--> required check failed? run it on base for attribution
          |
          +--> configured reproductions: base vs head
          |
          +--> forensics: test inventory, assertions, skips, CI, lockfiles, install scripts
          |
          v
  deterministic verdict  ->  receipt.json + report.md + logs
```

1. **Snapshot.** Skeptic creates detached git worktrees for base and head. Your working tree and index are never modified. Uncommitted files are overlaid onto the head snapshot by copying files, which preserves CRLF, binary data, and non-ASCII paths.
2. **Trust the base contract.** Checks and reproductions come from `skeptic.yml` at the base ref. A modified config at head is reported, not adopted.
3. **Execute and attribute.** Required checks run against head. If one fails, Skeptic runs the same check on base to distinguish a regression from a pre-existing failure.
4. **Prove fixes.** A "fixes #N" claim needs a configured reproduction that fails at base and passes at head. If the tests it depends on were modified, the proof is tainted.
5. **Collect integrity evidence.** Test declarations and assertions are inventoried at base and head. The diff is scanned for disabled tests, removed checks, CI bypasses, weakened runner settings, lockfile drift, and new install scripts.
6. **Conclude deterministically.** Rules produce the verdict. An optional LLM can classify claims, but it cannot change the verdict.

## Verdicts

| Verdict | Meaning | Default exit |
| --- | --- | --- |
| `verified` | Required checks passed, material claims are backed by evidence, no integrity warnings | 0 |
| `verified_with_warnings` | Checks passed, but soft signals such as modified test files or a CI bypass were found | 0 |
| `unverified` | Evidence is missing or compromised: deleted/skipped tests, zero tests executed, config tampering, pre-existing failure | 1 |
| `failed` | An attributable regression: the check passed at base and fails at head, or a "fixed" reproduction still fails | 1 |

The distinction matters:

- A **pre-existing failure** is not blamed on the agent. It caps the result at `unverified`.
- A **suspicious change** is not automatically called malicious. Hard signals cap the result at `unverified`.
- Only an **attributable regression** or a **contradicted claim** produces `failed`.

Change the CI threshold with `--fail-on warnings` or `--fail-on never`.

## What it catches

### Hard signals (cap the verdict at `unverified`)

| Signal | Example |
| --- | --- |
| Test file deleted | A failing suite is removed instead of fixed |
| Test file emptied | Declarations disappear while the file stays |
| Test expectations weakened | Assertions change while a failing baseline turns green |
| Test script disabled | `"test": "node --test"` becomes `"test": "true"` |
| Zero tests executed | The command is green because nothing ran |
| Every test skipped | The suite exits 0 without exercising code |
| Verification check removed, disabled, downgraded, or changed | `skeptic.yml` at head no longer matches the trusted contract |
| Reproduction still fails | The claimed fix does not fix the reproduced issue |

### Soft signals (cap the verdict at `verified_with_warnings`)

| Signal | Example |
| --- | --- |
| Skip or focus marker added | `.skip`, `.todo`, `xit`, `.only` |
| Assertions removed without new tests | Coverage shrinks while the suite stays green |
| CI test bypass | `continue-on-error: true`, `|| true` |
| Test or coverage config weakened | `passWithNoTests`, lowered thresholds, excluded paths |
| Lockfile drift | Dependencies change without a manifest change |
| Install lifecycle script added | `postinstall` runs during setup |
| Protected file modified | A path listed in `skeptic.yml` changed |

Every finding includes a rule id, severity, explanation, and `file:line` evidence when available.

## Evidence receipts

Every run writes an immutable-by-content record:

```json
{
  "schemaVersion": 1,
  "tool": { "name": "skeptic", "version": "0.1.0" },
  "input": {
    "baseSha": "4f2c1a9d7b3e...",
    "headSha": null,
    "dirty": true,
    "diffSha256": "f163bedf...",
    "changedFiles": 2
  },
  "config": { "source": "base", "trusted": true, "sha256": "d826d10b..." },
  "checks": [
    {
      "id": "unit",
      "required": true,
      "head": { "status": "passed", "exitCode": 0, "logSha256": "26adb6bb..." }
    }
  ],
  "reproductions": [
    { "id": "issue-42", "status": "tainted", "base": { "status": "failed" }, "head": { "status": "passed" } }
  ],
  "forensics": { "hardCount": 1, "softCount": 0, "findings": [] },
  "claims": [
    { "text": "All tests pass.", "type": "tests_pass", "status": "unsupported" }
  ],
  "verdict": { "level": "unverified", "reasons": ["Reproduction \"issue-42\" was tainted"] },
  "limitations": ["Network access was not blocked during verification."],
  "receiptSha256": "..."
}
```

Skeptic writes `receipt.json`, `report.md`, and raw logs under `.skeptic/runs/<run-id>/`. The receipt stores hashes and excerpts, not full logs. The hash provides **integrity, not authenticity** — it is not a cryptographic signature. See [docs/RECEIPTS.md](docs/RECEIPTS.md).

## GitHub Action

```yaml
name: Skeptic
on: pull_request

permissions:
  contents: read

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: Algorithm-zh/skeptic-agent@v0.1.0
        with:
          base: ${{ github.event.pull_request.base.sha }}
          head: ${{ github.event.pull_request.head.sha }}
          claims: ${{ github.event.pull_request.body }}
```

The action writes the report to the job summary, uploads the receipt, report, and logs as an artifact, and exposes `verdict`, `receipt`, `report`, and `run-dir` outputs. It is designed for `pull_request`, never `pull_request_target`.

## Configuration

```yaml
version: 1

setup: npm ci --ignore-scripts

checks:
  - id: unit
    name: Unit tests
    run: npm test
    required: true
    timeoutSec: 300
  - id: typecheck
    name: Typecheck
    run: npm run typecheck
    required: false

reproductions:
  - id: issue-42
    name: "Issue #42 - discount bug"
    run: npm test -- tests/price.test.ts
    expect: fail-before-pass-after

protected:
  - "tests/**"
  - ".github/workflows/**"
  - "skeptic.yml"

env:
  pass: ["CI"]

allowScripts: false

llm:
  enabled: false
  baseUrl: "https://api.openai.com/v1"
  model: "gpt-4o-mini"
  apiKeyEnv: "SKEPTIC_API_KEY"
```

- **Commands come from the trusted config.** An LLM never generates or edits commands.
- **Setup uses `--ignore-scripts` by default.** Set `allowScripts: true` only when you trust the repository.
- **The LLM is advisory.** It can only extract claims into a strict JSON shape. `--no-llm` and LLM mode produce the same verdict, which is covered by tests.

## Why not just CI?

| | Agent self-report | Typical CI | Diff review bot | Skeptic |
| --- | --- | --- | --- | --- |
| Executes the proposed code | sometimes | yes | no | yes |
| Compares the result with the base revision | no | rarely | no | yes |
| Audits test and assertion integrity | no | no | partly | yes |
| Requires proof for "fixes #N" | no | no | no | yes |
| Machine-readable evidence | no | build logs | comments | receipt + report + logs |
| Independent of the coding agent | no | yes | yes | yes |

Skeptic does not replace CI or code review. It answers a narrower question: **did this change do what it says, without weakening the tests?**

## Limits

Skeptic is deliberately conservative, but it is not omniscient.

- **It executes untrusted code.** Verification is isolated by git worktrees, not a security sandbox. Run it in an ephemeral CI runner. Network access is not blocked in v0.1.
- **Findings are heuristics.** Skeptic cannot prove semantic equivalence. Dynamically generated, parameterized, or snapshot tests may be misread.
- **Reproductions are configuration, not magic.** "Fixes #N" is provable only when you configure a reproduction.
- **Ignored files are not copied.** Dependency setup must reconstruct the environment.
- **Receipt hashes are not signatures.** They detect content changes; they do not prove who created a receipt.
- **Logs may contain sensitive output.** Review them before sharing.

See [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) for the full threat model.

## Design

- [Design notes](docs/DESIGN.md) — architecture, verdict rules, isolation, and trade-offs
- [Threat model](docs/THREAT_MODEL.md) — what Skeptic defends against and what it does not
- [Receipts](docs/RECEIPTS.md) — schema, hashing, artifact layout, and verification
- [Contributing](CONTRIBUTING.md) — development setup, test matrix, and fixture guidelines
- [Security policy](SECURITY.md) — reporting vulnerabilities

## Roadmap

- Docker/container sandbox with optional network isolation
- Receipt signatures (sigstore) and a "Verified with Skeptic" badge
- Pull request comments and GitHub code scanning output
- Configurable trusted allowlists to reduce false positives
- Python and multi-package-manager auto-detection
- Verification support for Agent Skills and MCP tool manifests

## Contributing

Issues and pull requests are welcome. The most valuable contribution is a **small, labeled fixture** that exposes a false positive or false negative. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).

---

**Skeptic** is an independent project. It is not affiliated with any coding-agent vendor. The goal is neutral verification: any agent, any model, one evidence standard.
