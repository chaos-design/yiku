# @yiku/flow-graph

`@yiku/flow-graph` 是无 UI 依赖的通用正交布线包。调用方提供矩形节点、语义边、端口约束和
额外障碍物，路由器返回稳定折点、圆角 SVG Path、质量指标和降级诊断。

## 使用

```ts
import { OrthogonalRouter } from "@yiku/flow-graph";

const router = new OrthogonalRouter();
const result = router.route({
  nodes: [
    { bounds: { x: 0, y: 20, width: 100, height: 44 }, id: "input" },
    { bounds: { x: 240, y: 20, width: 100, height: 44 }, id: "tool" },
  ],
  edges: [
    {
      id: "input-to-tool",
      source: { nodeId: "input" },
      target: { nodeId: "tool" },
    },
  ],
  obstacles: [
    {
      bounds: { x: 130, y: 0, width: 70, height: 50 },
      id: "reserved-panel",
    },
  ],
});

const route = result.routes[0];
console.log(route?.points, route?.path, route?.metrics);
```

## 端口

端口支持两种模式：

- `fixed`：Side 是硬约束，路由器不会改变。
- `preferred`：优先使用指定 Side/Slot，避障需要时可以调整。

未配置端口时，路由器根据节点相对位置自动选择 Side，并为同一节点的多条入边和出边稳定分配
不同 Slot。

```ts
{
  source: {
    nodeId: "input",
    port: { mode: "fixed", side: "right", slot: 0.5 },
  },
  target: {
    nodeId: "tool",
    port: { mode: "preferred", side: "left" },
  },
}
```

## 线段偏移

`offsetOrthogonalRoute` 可以在路由完成后按基础路径段号平移指定线段。段号从起点到终点按
`1..N` 编号，未配置段保持原位置：

```ts
import { offsetOrthogonalRoute } from "@yiku/flow-graph";

const points = offsetOrthogonalRoute(route.points, {
  2: 12,
  4: -8,
});
```

水平段正数向下、负数向上；垂直段正数向右、负数向左。函数保持原起点和终点不变，必要时
增加短正交连接段。偏移属于显式展示后处理，不重新执行避障或修改 Router Metrics。

## 行为

- 相同规范化输入产生相同结果，节点和边数组顺序不影响路径。
- 节点和额外障碍物按 Clearance 外扩。
- 非固定端口会评估全部 Source/Target Side 组合，不因初始偏好遗漏最近端口。
- 可见图先禁止共享线段和过近平行，确实无解时再使用带诊断的宽松路径。
- 全局优化依次减少碰撞、共享线段、Fallback、过近平行和交叉，再通过长度、折点与端口偏离
  组成的软成本选择更直接的路径。
- 交叉使用有限成本；避免交叉需要显著绕行时，仍可保留方向清晰的少量交叉。
- `portStubLength` 可以独立于 Clearance 加长端口直线段；相邻面对面端口仍可直接连接。
- 结构非法输入抛出 `FlowGraphError`。
- 合法但无零冲突路径时返回 `fallback: true` 和 Diagnostics。
- 核心包不依赖 Atomic Flow、React、DOM、SVG Runtime 或 Canvas。

## 验证

```bash
corepack pnpm --filter @yiku/flow-graph build
corepack pnpm --filter @yiku/flow-graph test
```

## 文档

- [Flow Graph](../../docs/atoms/flow-graph.md)
