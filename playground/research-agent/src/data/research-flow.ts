import type { FlowNodeId, FlowNodeStatus } from "../types.js";

export interface ResearchFlowStage {
  readonly description: string;
  readonly id: FlowNodeId;
  readonly index: string;
  readonly label: string;
}

export interface ResearchFlowGroup {
  readonly description: string;
  readonly id: "deliver" | "evidence" | "prepare";
  readonly label: string;
  readonly nodeIds: readonly FlowNodeId[];
}

export const RESEARCH_FLOW_STAGES: readonly ResearchFlowStage[] = [
  {
    description: "定义边界与停止条件",
    id: "plan",
    index: "01",
    label: "研究计划",
  },
  {
    description: "拆分可验证查询",
    id: "query",
    index: "02",
    label: "查询拆解",
  },
  {
    description: "检索实时网页",
    id: "search",
    index: "03",
    label: "搜索",
  },
  {
    description: "写入主张与来源",
    id: "evidence-record",
    index: "04",
    label: "记录证据",
  },
  {
    description: "寻找独立来源与反证",
    id: "corroborate",
    index: "05",
    label: "交叉核验",
  },
  {
    description: "综合事实与不确定性",
    id: "synthesize",
    index: "06",
    label: "综合",
  },
  {
    description: "验证引用和证据账本",
    id: "citation-validate",
    index: "07",
    label: "引用校验",
  },
  {
    description: "输出可追踪报告",
    id: "report",
    index: "08",
    label: "报告",
  },
] as const;

export const RESEARCH_FLOW_GROUPS: readonly ResearchFlowGroup[] = [
  {
    description: "定义任务并拆出可验证问题",
    id: "prepare",
    label: "准备轨道",
    nodeIds: ["plan", "query"],
  },
  {
    description: "检索、取证、核验，直到证据足够",
    id: "evidence",
    label: "证据回路",
    nodeIds: ["search", "evidence-record", "corroborate"],
  },
  {
    description: "综合事实，校验引用并交付",
    id: "deliver",
    label: "交付轨道",
    nodeIds: ["synthesize", "citation-validate", "report"],
  },
] as const;

const STAGE_BY_ID = new Map(RESEARCH_FLOW_STAGES.map((stage) => [stage.id, stage]));

export function getResearchFlowStage(id: FlowNodeId): ResearchFlowStage {
  const stage = STAGE_BY_ID.get(id);
  if (stage === undefined) {
    throw new Error(`Unknown research flow stage: ${id}`);
  }
  return stage;
}

export function researchFlowStatusLabel(status: FlowNodeStatus): string {
  switch (status) {
    case "active":
      return "运行中";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    case "idle":
      return "等待";
  }
}
