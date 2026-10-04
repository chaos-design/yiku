# @yiku/agent-research

`@yiku/agent-research` 定义证据型 `ResearchAgent`、Research Skill、Evidence Ledger、
Evidence Tool、Report Validator 和 Research Flow Tracker。它不运行 Session，也不提供 Code
Tools；执行、取消、Subagent 和通用 Runtime Flow 由 `@yiku/agent-orchestrator` 负责。

## 主要导出

- `ResearchAgent`
- `createResearchSkill`
- `EvidenceLedger`
- `recordEvidenceTool`
- `ResearchClaimLedger`
- `recordClaimTool`
- `createResearchEvalProfile` / `createResearchEvaluators`
- `canonicalResearchUrl`
- `validateResearchReport`
- `ResearchFlowTracker`
- `RESEARCH_ATOMS`
- `DEFAULT_RESEARCH_PROMPT`

## 最小使用

```ts
import {
  createRegisteredAgent,
  ResearchAgentFactory,
  run,
} from "@yiku/agent-orchestrator";

const model = "gpt-5-mini";
const created = createRegisteredAgent(
  new ResearchAgentFactory({ searchContextSize: "medium" }),
  {
  agentName: "Research Agent",
    handoffs: [],
  model,
    tools: [],
    workspaceDir: process.cwd(),
  },
  {
    agentId: "research",
    agentKey: "research",
    agentType: "research",
  },
);

const result = await run(created.agent, "研究 Agent 可观测性的最新趋势", {
  apiKey: process.env.OPENAI_API_KEY ?? "",
  model,
});
```

目标模型与 Provider 必须支持 Responses API Web Search。

## Evidence 与验证

`createResearchSkill()` 为每次构造创建独立 Evidence Ledger 和 Claim Ledger，并组合 Web
Search、`recordEvidenceTool` 与 `recordResearchClaimTool`。Evidence Ledger 默认最多保存
50 个规范 URL，Claim Ledger 默认最多保存 200 个结构化 Claim。

增强 Validator 使用 Claim Manifest 确定性计算 Citation Precision/Recall、Unsupported Claim、
来源权威性、时效性、多样性和冲突覆盖。无法确定的语义蕴含只交给 Optional Judge，不替代
结构化证据。通过 `ResearchAgentFactory` 运行时，验证失败会保留原报告用于诊断。

`ResearchAgentFactory` 自动绑定 `ResearchFlowTracker`，标准 Run 会发射
`research.plan/query/search/evidence-record/corroborate/synthesize/citation-validate/report`。
调用方不需要手工监听 Progress Event。

通用 `SKILL.md` 的 Discovery、Catalog、Snapshot 和 Worker 属于 Orchestrator。标准 Session 会把
`skillListTool`、`skillInspectTool` 和 `skillRunTool` 注入 Research Factory；Research Package
自身不扫描 Home 或 Workspace。

## 验证

```bash
corepack pnpm --filter @yiku/agent-research build
corepack pnpm --filter @yiku/agent-research test
```

## 权威文档

- [Research Agent](../../../docs/features/research-agent.md)
- [Evals](../../../docs/features/evaluations.md)
- [Runtime 与编排](../../../docs/architecture/runtime-and-orchestration.md)
- [Atomic Flow](../../../docs/atoms/atomic-flow.md)
- [Research Playground](../../../playground/research-agent/README.md)
