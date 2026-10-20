# Skeptic

**为 AI 写的代码提供独立验证。要证据，不要自述。**

[![CI](https://github.com/Algorithm-zh/skeptic-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/Algorithm-zh/skeptic-agent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

> Agent 说它做完了。Skeptic 来检查。

<img src="https://raw.githubusercontent.com/Algorithm-zh/skeptic-agent/main/assets/demo.gif" alt="Skeptic 演示：四个 agent 都声称测试通过。一个获得 VERIFIED，另外三个因为跳过测试、修改断言或缺少修复证据而被判为 UNVERIFIED。" width="960">

coding agent 可以真的修好 bug。它也可以删掉失败的测试、跳过整个套件、改掉断言，或者把 `npm test` 换成 `true`。CI 运行的是剩下的东西。Skeptic 检查的是**改动了什么**。

Skeptic 不是另一个写代码的 agent。它接收一次改动和 agent 的完成声明，在隔离快照中重新执行，对比 base 与 head，审计测试完整性，最后给出确定性的 verdict 和机器可读的 evidence receipt。

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

## 30 秒体验

不需要 API key，不需要外部服务。demo 会创建四个临时 git 仓库，四个 agent 都声称 **“All tests pass.”**。

```bash
git clone https://github.com/Algorithm-zh/skeptic-agent.git
cd skeptic-agent
npm ci
npm run build
node dist/cli.js demo
```

预期输出：

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

npm 发布后，也可以直接运行 `npx skeptic-agent demo`。

## 在真实仓库中使用

```bash
# 在当前源码目录中（或 npm 全局安装之后）
node dist/cli.js init
git add skeptic.yml .gitignore
git commit -m "add skeptic verification contract"

node dist/cli.js verify --claims "All tests pass. Fixes #42."
```

`init` 会检测 `npm test` 并生成验证契约。Skeptic **只从 base revision 读取契约**，不会相信 agent 改动后的 `skeptic.yml`。如果还没提交契约就要验证，必须显式传入 `--trust-config`。

### 命令

| 命令 | 作用 |
| --- | --- |
| `skeptic init` | 生成 `skeptic.yml`，并把 `.skeptic/` 加入忽略列表 |
| `skeptic verify` | 验证脏工作区，或指定的 base/head 提交范围 |
| `skeptic demo` | 运行四个自包含场景，无需 API key |
| `skeptic report` | 把最近或指定的 receipt 渲染为 Markdown |
| `skeptic doctor` | 检查 Node、git、配置信任与测试脚本 |

`verify` 常用选项：

```bash
--base <ref> --head <ref>   # 验证提交范围，而不是工作区
--claims "<text>"           # agent 的完成声明
--claims-file <path>        # 从文件读取声明
--trust-config              # 显式信任未提交的 skeptic.yml
--config <path>             # 使用显式配置作为受信覆盖
--fail-on <mode>            # warnings | unverified | never
--json / --markdown         # 机器可读输出或报告输出
--keep-worktrees            # 保留隔离的 base/head 快照用于排查
```

## 工作原理

```text
agent 改动 + 完成声明
          |
          v
  base 快照  +  head 快照          （独立 git worktree，不碰你的 index）
          |              |
          |              +-- 脏工作区按文件复制覆盖，而不是打 patch
          v
  受信的 skeptic.yml（只从 base revision 读取）
          |
          +--> 在 head 上执行 checks
          |       |
          |       +--> 必需 check 失败？再到 base 上执行，做归因
          |
          +--> 配置的 reproductions：base vs head
          |
          +--> forensics：测试清单、断言、skip、CI、lockfile、安装脚本
          |
          v
  确定性 verdict  ->  receipt.json + report.md + logs
```

1. **快照。** 为 base 和 head 创建 detached worktree。你的工作区和 index 不会被修改。未提交文件通过复制覆盖到 head 快照，保留 CRLF、二进制内容和中文路径。
2. **信任 base 契约。** checks 和 reproductions 来自 base ref 的 `skeptic.yml`。head 上的配置改动会被报告，但不会被采用。
3. **执行与归因。** 必需 check 在 head 上执行；失败时再在 base 上执行同一命令，区分回归和原有失败。
4. **证明修复。** “fixes #N” 必须有配置好的复现：base 失败、head 通过。如果它依赖的测试被修改，证明会被标记为 tainted。
5. **收集完整性证据。** 统计 base/head 的测试声明与断言数量，扫描被禁用的测试、被删除的 check、CI 绕过、被弱化的 runner 配置、lockfile 漂移和新增安装脚本。
6. **确定性结论。** verdict 由规则计算。可选 LLM 只能帮忙提取声明，不能改变判定。

## Verdict 模型

| Verdict | 含义 | 默认退出码 |
| --- | --- | --- |
| `verified` | 必需 check 通过，关键声明有证据，无完整性告警 | 0 |
| `verified_with_warnings` | check 通过，但存在软信号，如测试文件被修改或 CI 绕过 | 0 |
| `unverified` | 证据缺失或被破坏：删测试、跳过测试、零测试、配置篡改、原有失败 | 1 |
| `failed` | 可归因的回归：base 通过、head 失败；或声称修复的复现仍然失败 | 1 |

几个关键区分：

- **原有失败**不算在 agent 头上，但会封顶为 `unverified`。
- **可疑改动**不直接断定恶意，硬信号只封顶为 `unverified`。
- 只有**可归因回归**或**被证据反驳的声明**才会得到 `failed`。

CI 阈值可通过 `--fail-on warnings` 或 `--fail-on never` 调整。

## 能抓什么

### 硬信号（封顶 `unverified`）

| 信号 | 例子 |
| --- | --- |
| 测试文件被删除 | 不修失败套件，直接删掉 |
| 测试文件被清空 | 文件还在，测试声明没了 |
| 测试期望被弱化 | 失败基线变绿，同时断言被改 |
| 测试脚本被禁用 | `"test": "node --test"` 变成 `"test": "true"` |
| 零测试执行 | 命令是绿的，因为什么都没跑 |
| 所有测试被跳过 | 套件退出 0，但没执行代码 |
| 验证 check 被删除、禁用、降级或修改 | head 上的 `skeptic.yml` 不再匹配受信契约 |
| 复现仍然失败 | 声称修复了，但配置的复现还是失败 |

### 软信号（封顶 `verified_with_warnings`）

| 信号 | 例子 |
| --- | --- |
| 新增 skip / focus 标记 | `.skip`、`.todo`、`xit`、`.only` |
| 断言减少且没有新增测试 | 覆盖率缩水，但套件仍是绿的 |
| CI 测试绕过 | `continue-on-error: true`、`|| true` |
| 测试/覆盖率配置被弱化 | `passWithNoTests`、下调阈值、排除路径 |
| Lockfile 漂移 | 依赖解析变了，但 manifest 没变 |
| 新增安装生命周期脚本 | setup 期间执行 `postinstall` |
| 受保护文件被修改 | `skeptic.yml` 中列出的路径发生变化 |

每条 finding 都包含规则 ID、severity、解释，以及可用时的 `file:line` 证据。

## Evidence receipt

每次运行都会写出可复核的记录：

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

Skeptic 把 `receipt.json`、`report.md` 和原始日志写到 `.skeptic/runs/<run-id>/`。receipt 只存哈希和摘要，不存完整日志。哈希提供**完整性，不是真实性**——它不是密码学签名。详见 [docs/RECEIPTS.md](docs/RECEIPTS.md)。

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

Action 会把报告写入 job summary，把 receipt、报告和日志作为 artifact 上传，并输出 `verdict`、`receipt`、`report`、`run-dir`。它专为 `pull_request` 设计，绝不使用 `pull_request_target`。

## 配置

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

- **命令来自受信配置。** LLM 不能生成或修改命令。
- **setup 默认使用 `--ignore-scripts`。** 只有在你信任仓库时才设置 `allowScripts: true`。
- **LLM 只做辅助。** 它只能按严格的 JSON 结构提取声明。`--no-llm` 与 LLM 模式产生相同 verdict，并有测试保证。

## 为什么不直接用 CI？

| | Agent 自述 | 普通 CI | Diff review bot | Skeptic |
| --- | --- | --- | --- | --- |
| 实际执行改动后的代码 | 有时 | 是 | 否 | 是 |
| 与 base revision 对比 | 否 | 很少 | 否 | 是 |
| 审计测试与断言完整性 | 否 | 否 | 部分 | 是 |
| 要求 “fixes #N” 提供证明 | 否 | 否 | 否 | 是 |
| 机器可读证据 | 否 | 构建日志 | 评论 | receipt + report + logs |
| 独立于 coding agent | 否 | 是 | 是 | 是 |

Skeptic 不替代 CI 或 code review。它只回答一个更窄的问题：**这个改动有没有在削弱测试的前提下，做到它声称的事？**

## 限制

Skeptic 刻意保守，但不是全知。

- **它会执行不可信代码。** 隔离依赖 git worktree，不是安全沙箱。请放在临时 CI runner 中运行。v0.1 不阻断网络。
- **findings 是启发式规则。** Skeptic 无法证明语义等价；动态生成、参数化或快照测试可能被误判。
- **复现需要配置。** 只有配置了复现，“Fixes #N” 才可证明。
- **被 gitignore 的文件不会复制。** 依赖环境需要通过 setup 重建。
- **receipt 哈希不是签名。** 它能发现内容变化，但不能证明是谁生成的。
- **日志可能包含敏感输出。** 分享前请检查。

完整威胁模型见 [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md)。

## 设计文档

- [设计说明](docs/DESIGN.md) — 架构、判定规则、隔离与取舍
- [威胁模型](docs/THREAT_MODEL.md) — 防什么、不防什么
- [Receipts](docs/RECEIPTS.md) — schema、哈希、产物布局与复核方式
- [贡献指南](CONTRIBUTING.md) — 开发环境、测试矩阵与 fixture 规范
- [安全策略](SECURITY.md) — 漏洞报告方式

## Roadmap

- Docker/容器沙箱与可选网络隔离
- Receipt 签名（sigstore）与 “Verified with Skeptic” badge
- PR 评论与 GitHub code scanning 输出
- 可配置的受信 allowlist，降低误报
- Python 与多包管理器自动检测
- Agent Skills 与 MCP 工具清单验证

## 贡献

欢迎 issue 和 PR。最有价值的贡献是一个**小而明确的 fixture**，能够暴露误报或漏报。详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## License

MIT，见 [LICENSE](LICENSE)。

---

**Skeptic** 是一个独立项目，不隶属于任何 coding-agent 厂商。目标是中立验证：任何 agent、任何模型，使用同一套证据标准。
