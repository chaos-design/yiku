# Atomic Flow

`@yiku/atomic-flow` 是 Yiku 的 Run 级事件协议。它统一 Atom 定义、Instance 生命周期、Sequence、
Edge、Sink、JSONL 和确定性 Fold，但不执行 Agent 或解释领域结果。

## 模型

### Atom

```ts
interface AtomicDefinition {
  key: string;
  kind: AtomicKind;
  label: string;
  level: "deep" | "runtime";
}
```

- `key`：稳定流程节点标识；
- `kind`：展示和语义分类；
- `label`：人类可读名称；
- `level`：常规 Runtime 或 Deep View。

同一 Atom 可以在一个 Run 中执行多次。

### Instance

```ts
interface AtomicInstance {
  id: string;
  iteration?: number;
  parentId?: string;
}
```

Instance ID 标识一次具体执行。重复循环通过 `iteration` 表达，层级通过 `parentId` 表达。

### Event

```ts
interface AtomicFlowEvent {
  atom: AtomicDefinition;
  edge?: AtomicEdge;
  eventId: string;
  instance: AtomicInstance;
  internal?: boolean;
  occurredAt: string;
  payload?: AtomicPayloadSummary;
  phase: AtomicPhase;
  runId: string;
  sequence: number;
}
```

Phase：

```text
scheduled -> start -> delta* -> end
                           \-> error
scheduled -----------------> skipped
```

不是所有生产者都必须先发 `scheduled`。Span 通常从 `start` 开始，并以 `end` 或 `error` 结束。

### Edge

Edge 类型：

- `execution`
- `data`
- `feedback`
- `persistence`

Edge 至少引用 Source/Target Atom Key，可选 `fromInstanceId` 精确关联来源执行。Parent 表达层级，
Edge 表达流程关系，两者不能互相替代。

### Payload

Payload 是有界摘要：

```ts
interface AtomicPayloadSummary {
  code?: string;
  counts?: Record<string, number>;
  durationMs?: number;
  summary?: string;
  title?: string;
  values?: Record<string, AtomicValue>;
}
```

不要写入 API Key、完整 Prompt、无限 Tool 输出或任意 Provider Payload。

## 创建 Run

```ts
import {
  AtomicFlowRun,
  AtomicJsonlSink,
} from "@yiku/atomic-flow";

const flow = new AtomicFlowRun({
  runId: "run-1",
  sinks: [
    new AtomicJsonlSink({
      filePath: "/absolute/path/to/flow.jsonl",
    }),
  ],
});

const turn = flow.start({
  atom: {
    key: "loop.turn",
    kind: "loop",
    label: "Loop Turn",
    level: "runtime",
  },
  iteration: 1,
});

turn.delta({ summary: "Calling model" });
turn.end({ summary: "Completed" });
await flow.close();
```

`AtomicSpan` 保留 Instance ID。生产者应在同一实例上发出终态，不为 End 重新生成 ID。

## Sequence 与分发

- Sequence 在单个 Run 内严格递增；
- Event 先进入内存 Buffer 和 Subscriber，再按每个 Sink 的队列顺序写入；
- 不同 Sink 可以并行推进，但单个 Sink 不乱序；
- Subscriber 异常不能改变来源 Flow；
- `flush()` 等待当前 Sink 队列；
- `close()` Flush 后关闭全部 Sink；
- 关闭后的 Run 拒绝新事件。

Buffer 受 `maxBufferedEvents` 限制。Snapshot 只包含当前可见 Buffer；持久 JSONL 可以保存完整
历史。

## Sink 与降级

```ts
interface AtomicFlowSink {
  id: string;
  durable?: boolean;
  write(event): AtomicSinkReceiptDraft | void | Promise<...>;
  close?(): void | Promise<void>;
}
```

Sink 失败不会停止来源 Run。Flow：

1. 记录降级 Code；
2. `snapshot().degraded` 变为 `true`；
3. 其他 Sink 继续接收；
4. 开启 `trace` 时生成内部 `flow.sink-error` 或 Receipt。

内部 Receipt 不再递归产生 Receipt。

## JSONL

`AtomicJsonlSink` 逐行追加事件。路径必须是绝对有效文件路径，写入失败作为 Sink 降级处理。

```ts
import { readAtomicFlowEvents } from "@yiku/atomic-flow";

const events = await readAtomicFlowEvents("/absolute/path/to/flow.jsonl", {
  afterSequence: 100,
});
```

Reader 校验每行 JSON 和基本事件结构。损坏行返回 `ATOMIC_FLOW_JSONL_INVALID`，不静默跳过。

## Fold

```ts
import { foldAtomicEvents } from "@yiku/atomic-flow";

const state = foldAtomicEvents(events);
```

Fold 按 Sequence 构建：

- `instances`：每个 Instance 的 Atom、状态、时间、Iteration 和 Parent；
- `edges`：已观察到的流程关系；
- `latestSequence`；
- `runId`。

状态映射：

| Phase | 状态 |
| --- | --- |
| `scheduled` | `scheduled` |
| `start` / `delta` | `running` |
| `end` | `completed` |
| `error` | `failed` |
| `skipped` | `skipped` |

Fold 拒绝 Sequence 倒退、混合 Run 和不一致 Instance 定义。相同规范事件前缀产生相同 Fold
State。

## Studio 投递

```ts
import { AtomicFlowRun, AtomicStudioSink } from "@yiku/atomic-flow";

const flow = new AtomicFlowRun({
  runId: crypto.randomUUID(),
  sinks: [
    new AtomicStudioSink({
      endpoint: "http://127.0.0.1:3333",
      project: { id: "checkout", name: "Checkout" },
      run: {
        kind: "agent",
        prompt: "Review checkout",
        sessionId: "session-1",
      },
    }),
  ],
});
```

Studio Sink 只接受回环地址。Project 和 Run Metadata 在首次成功投递时建立。

## 公共入口

- `AtomicFlowRun`
- `AtomicSpan`
- `AtomicJsonlSink`
- `AtomicStudioSink`
- `readAtomicFlowEvents`
- `foldAtomicEvents`
- `isTraceObservationEvent`
- Atom、Event、Edge、Sink、Snapshot 和 Fold 类型

## 错误

| Code | 含义 |
| --- | --- |
| `ATOMIC_FLOW_CLOSED` | Run 已关闭 |
| `ATOMIC_FLOW_INVALID_ATOM` | Atom 定义无效 |
| `ATOMIC_FLOW_INVALID_EVENT` | Event 或 Sequence 无效 |
| `ATOMIC_FLOW_INVALID_INSTANCE` | Instance 生命周期无效 |
| `ATOMIC_FLOW_INVALID_RUN` | Run ID 或 Metadata 无效 |
| `ATOMIC_FLOW_JSONL_INVALID` | JSONL 路径或内容无效 |
| `ATOMIC_FLOW_SINK_FAILED` | Sink 写入或投递失败 |

## 验证

```bash
corepack pnpm --filter @yiku/atomic-flow build
corepack pnpm --filter @yiku/atomic-flow test
```

所有内置 Key 见 [Atom 目录](atom-catalog.md)，轨迹投影见 [Trajectory](trajectory.md)。
