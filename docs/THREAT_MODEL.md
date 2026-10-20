# Skeptic threat model

Skeptic verifies code written by an agent that may be wrong, careless, or adversarial. This document states what Skeptic is designed to defend against, what it explicitly does not defend against, and how to deploy it safely.

## Assets

1. **The verdict** — whether a change is verified, unverified, or failed.
2. **The evidence** — check results, reproduction results, findings, logs, and hashes.
3. **The verification contract** — `skeptic.yml`, which defines what "verified" means.
4. **The user's repository** — working tree, index, branches, and configuration.
5. **The runner environment** — credentials, source code, network, and compute.
6. **The user's attention** — a false "verified" is worse than a noisy warning.

## Adversaries and untrusted inputs

Skeptic assumes the following may be hostile or simply wrong:

- The coding agent and its completion claims.
- The repository under verification, including its tests, source, CI workflows, lockfiles, and package manifests.
- Test output and logs produced by the repository.
- An optional LLM endpoint used for claim extraction.
- Prompt injection embedded in claims or repository content.

The user running Skeptic and the base-revision config are considered trusted. A base revision that is already malicious is outside the verification boundary.

## Security properties

### 1. The verification contract comes from base

Skeptic reads `skeptic.yml` from the base revision. A head-side modification cannot add, remove, weaken, or redirect checks. Detected modifications become findings, and hard ones cap the verdict at `unverified`.

This prevents an agent from turning `npm test` into `true` and then claiming success.

### 2. The user's repository is not modified

Skeptic creates detached git worktrees for base and head. Dirty files are overlaid by copying. It does not run `git add`, does not write to the index, and does not switch branches. Artifacts are written under `.skeptic/`, which is excluded locally and ignored by default.

This is an integrity property, not a confidentiality boundary. Tests can still read anything the runner user can read.

### 3. Execution is filtered, not sandboxed

Commands receive a scrubbed environment:

- an allowlist of OS and shell variables;
- no `GITHUB_TOKEN`, `*_API_KEY`, `*_SECRET*`, or similar values by default;
- no `NODE_OPTIONS`;
- no `GIT_DIR`/`GIT_WORK_TREE` overrides;
- `CI=1`, `TERM=dumb`, and deterministic color settings.

Install lifecycle scripts are disabled by default via `npm_config_ignore_scripts=true` and `npm ci --ignore-scripts`. `allowScripts: true` is an explicit operator decision and is recorded in the receipt limitations.

**This is not a sandbox.** Test commands are arbitrary code. A malicious repository can read files, spawn processes, and use the network with the runner's privileges.

### 4. Claims cannot control execution or verdicts

The LLM path is deliberately constrained:

- commands come only from the trusted config;
- the LLM response must match a strict JSON schema;
- commands, verdicts, and evidence fields in the response are discarded;
- unknown check ids are removed;
- claim text is labeled as untrusted data in the prompt;
- LLM errors degrade to heuristics;
- LLM claims are excluded from the verdict entirely.

Prompt injection can at most add an advisory claim to the receipt. It cannot flip a failing check or produce a supported claim without evidence.

### 5. Evidence is attributable and tamper-evident

Each run records:

- base/head SHAs or `dirty: true`;
- a diff fingerprint;
- the config source and hash;
- check commands, statuses, exit codes, and durations;
- reproduction statuses;
- findings with rule ids;
- claim statuses and evidence;
- the limitation list;
- a SHA-256 over canonical JSON.

Logs are stored separately with their own hashes. Absolute snapshot paths are replaced with placeholders in receipt excerpts.

The receipt hash provides **integrity**, not **authenticity**. Anyone can create a receipt. It does not prove who ran verification or that the binary was unmodified.

## Attack scenarios

| Attack | Expected response |
| --- | --- |
| Delete the failing test | `test_file_deleted` hard finding; deleted suite cannot support a claim |
| Change the assertion to match the bug | `tests_weakened_to_pass` hard finding; reproduction is tainted |
| Skip every test | `all_tests_skipped` hard finding; test-pass claim unsupported |
| Replace `npm test` with `true` | `test_script_disabled` hard finding; zero tests cannot support claims |
| Remove or weaken a configured check | Hard config finding; base config remains authoritative |
| Add `continue-on-error: true` to CI | Soft finding; verdict becomes `verified_with_warnings` |
| Delete a test file and add a trivial one | `test_files_reorganized` soft, or hard if net test count falls |
| Lower coverage thresholds or exclude paths | `test_config_weakened` soft finding |
| Change the lockfile without a manifest change | `lockfile_drift` soft finding |
| Add a `postinstall` script | `install_script_added` soft finding; scripts are not run by default |
| Claim "fixes #42" with no reproduction | Claim unsupported; verdict capped at `unverified` |
| Modify the reproduction test | Reproduction tainted; fix claim unsupported |
| Print fake test output | Partially detectable. Skeptic trusts the command's exit code and parses output heuristically; a malicious command can fabricate both. Use a trusted check command. |
| Inject instructions through claims | Strict JSON schema plus deterministic verdict; no execution path |
| Point `baseUrl` at a malicious LLM server | The server sees the claim text and the API key you configured for it; it cannot execute commands or change the verdict |
| Exfiltrate secrets from setup/tests | Scrubbed environment and no install scripts by default; network is not blocked, so run untrusted code in an ephemeral environment |

## Residual risks

1. **Arbitrary code execution.** Any test or setup command can run arbitrary code. Treat verification like running the repository's tests locally: do it in an isolated CI runner or container, not on a workstation with production credentials.
2. **Network access.** v0.1 does not block network access. A malicious test can call external services or exfiltrate files it can read. Do not pass secrets into the environment.
3. **Heuristic blind spots.** Skeptic cannot prove semantic equivalence. Dynamically generated tests, parameterized tests, snapshot updates, or unusual frameworks may be misclassified. Rules are conservative, and hard findings only cap the verdict; they do not assert intent.
4. **Dependency setup.** Ignored files are not copied into snapshots. If the project needs them to build, verification may fail or differ from the developer's machine.
5. **Git configuration.** Skeptic inherits repository-level git configuration. Exotic filters, hooks, or worktree settings can affect checkout behavior. Use a clean runner.
6. **Receipt forgery.** A SHA-256 hash detects accidental or naive tampering but is not a signature. A malicious actor can generate a different valid receipt. Signatures are on the roadmap.
7. **Log sensitivity.** Logs contain raw command output. They may include tokens, paths, or user data printed by tests. Review before sharing.
8. **Base trust.** If the base config is malicious (for example, it runs a hostile command), Skeptic will execute it. Only verify repositories whose base contract you are willing to run.

## Recommended deployment

- Use GitHub Actions `pull_request`, never `pull_request_target`.
- Set `permissions: contents: read` and `persist-credentials: false`.
- Fetch the exact base and head SHAs; avoid moving branch names for evidence-grade runs.
- Do not expose repository secrets to the verification job.
- Run in an ephemeral runner. Use a container once sandboxing is available.
- Review the generated report and receipt before merging.
- Treat `verified_with_warnings` as a prompt to inspect the diff, not as an automatic merge.

## Reporting security issues

Please do not open a public issue for a vulnerability. See [SECURITY.md](../SECURITY.md) for the private reporting process.

## Limitations of this document

This threat model covers the v0.1 implementation. It is not a formal proof. New rules, integrations, and execution backends can change the boundary; review this document with any change that adds a new way to execute code or trust input.
