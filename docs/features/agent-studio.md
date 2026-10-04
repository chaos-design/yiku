# Agent Studio

`@yiku/agent-studio` 是协议无关的本地 Agent Studio SDK；`@yiku/agent-observatory` 是 Yiku
提供的 Atomic Flow 插件和默认 Web 预设。

## 两个包的边界

| 包 | 职责 |
| --- | --- |
| `@yiku/agent-studio` | Run/Event、Store、Registry、HTTP/SSE、React Shell、插件系统 |
| `@yiku/agent-observatory` | Atomic Flow Adapter、Topology、Trajectory、Replay、默认 UI |

Studio 不依赖 Atomic Flow、具体 Agent、Memory、Eval 或 CLI。Observatory 通过 Studio 的公开
插件契约接入这些 Yiku 语义。

## Studio Server

```ts
import {
  StudioServer,
  studioManifest,
  type StudioServerPlugin,
} from "@yiku/agent-studio/server";

const plugin: StudioServerPlugin = {
  manifest: studioManifest("example.runtime", "Example Runtime", ["events.example"]),
  adapters: [
    {
      id: "example",
      parse(input) {
        const event = input as {
          eventId: string;
          occurredAt: string;
          runId: string;
          sequence: number;
        };
        return {
          event,
          seed: {
            createdAt: event.occurredAt,
            runId: event.runId,
            status: "running",
            title: "Example Run",
          },
        };
      },
    },
  ],
};

const server = new StudioServer({
  plugins: [plugin],
  port: 4318,
  workspaceDir: process.cwd(),
});

await server.start();
```

默认只绑定 `127.0.0.1`。自定义 Host 只允许 `127.0.0.1` 或 `localhost`。

## 服务端 API

| 路径 | 用途 |
| --- | --- |
| `GET /api/studio/health` | 健康检查 |
| `GET /api/studio/manifest` | 插件 Manifest |
| `POST /api/studio/ingest/<adapter-id>` | 接收外部事件 |
| `GET /api/studio/runs` | Run 列表 |
| `GET /api/studio/runs/<run-id>` | Run 详情 |
| `GET /api/studio/runs/<run-id>/events` | Event 列表 |
| `GET .../events` + `Accept: text/event-stream` | SSE |
| `/api/plugins/<plugin-id>/*` | 插件 Route |

Ingest 返回 `202`；重复 Event 幂等返回 `200`。错误包含稳定 Code、Message 和 Request ID。

## Store 与 Registry

`FileStudioStore` 以 JSONL 保存 Event。`StudioRunRegistry`：

- 按 `runId + sequence` 排序；
- 去重 Event；
- 通过 Projector 更新 Run Metadata；
- 支持历史列表和实时订阅；
- 从 JSONL 重建投影。

宿主可以注入自定义 `StudioStore`。Host Store 与插件 Store 不能同时存在，多个插件也不能各自
提供 Store。

## 服务端插件

`StudioServerPlugin` 可以贡献：

- Event Adapter；
- Run Projector；
- Status Definition；
- HTTP Route；
- Store；
- Initialize/Dispose 生命周期。

插件 Manifest 声明 ID、名称、版本、Studio 版本、Capability 和依赖。启动时拒绝：

- 缺失或循环依赖；
- Studio 版本不兼容；
- 重复 Adapter、Projector、Status 或 Route；
- 多个 Store。

## React 宿主

```tsx
import {
  StudioShell,
  type StudioClientPlugin,
} from "@yiku/agent-studio/react";

const plugin: StudioClientPlugin = {
  manifest: {
    capabilities: ["pages.example"],
    id: "example.runtime",
    name: "Example Runtime",
    studioVersion: "0.1",
    version: "0.1.0",
  },
  navigation: [{ id: "example", label: "Example", pageId: "example" }],
  pages: [
    {
      component: () => <main>Example capability</main>,
      id: "example",
      path: "/",
      title: "Example",
    },
  ],
};

export function App() {
  return <StudioShell plugins={[plugin]} />;
}
```

客户端贡献点：

- Page；
- Navigation；
- Slot；
- Event Renderer；
- Graph Provider；
- Run Action；
- Theme Token。

支持的 Slot 包括 Header Action、Navigation Footer、Run Sidebar/Toolbar、Event Inspector 和 Page
Footer。前后端插件使用相同 Manifest ID，但从独立入口加载，避免浏览器 Bundle 引入 Node 模块。

## Agent Observatory

启动：

```bash
yiku web --port 3333
```

Observatory 提供：

- Runtime、Agent、Skill、Subagent、Memory、Telemetry 和 Quality 分区；
- 固定 Atom 和动态领域 Atom；
- 正交连线与路由诊断；
- Run History 和自动跟随；
- 自动跟随当前事件并支持运行节点定位的 Event Log，以及区分事件数据和 Run Scorecard 的
  Event Inspector；
- 页面内复用布局缓存的 Topology，以及按 Turn 分组并支持返回最新状态的 Trajectory；
- Live、单步和倍速 Replay；
- `?runId=<id>&view=trajectory` 深链。

页面只观测，不从浏览器发送 Prompt、取消 Agent 或修改 Runtime。输入仍在启动 `yiku web` 的终端
完成。

## Observatory 插件

客户端：

```ts
import { agentObservatoryClientPlugin } from "@yiku/agent-observatory/plugin/react";

const plugin = agentObservatoryClientPlugin({ path: "/flow" });
```

服务端：

```ts
import { agentObservatoryServerPlugin } from "@yiku/agent-observatory/plugin/server";
```

兼容宿主可从 `@yiku/agent-observatory/server` 使用 `ApiServer`。Atomic Flow Event 仍可投递到
`POST /api/ingest/events`，兼容 Run API 与 SSE 由 Observatory Server 提供。

## 自定义扩展

`playground/agent-observatory` 展示：

- 自定义页面和导航；
- 插件 API Route；
- Slot；
- Theme；
- 与默认 Observatory 的组合。

```bash
corepack pnpm --filter @yiku/agent-observatory-playground dev
```

## 安全与故障

- Server 只绑定回环地址；
- Static 文件解析拒绝目录逃逸；
- Request Body 有上限；
- 插件 Route 和 Ingest 统一错误协议；
- SSE 连接关闭时清理订阅与 Heartbeat；
- 插件按逆序 Dispose；
- 观测投递失败只将来源 Flow 标记为 Degraded；
- Studio 不持有 Agent Runtime 权限。

## 主要导出

### Agent Studio

- `StudioServer`
- `StudioRunRegistry`
- `FileStudioStore`
- `StudioShell`
- `StudioProvider`
- 插件排序、校验、Client/Server 类型

### Agent Observatory

- `App`
- `agentObservatoryClientPlugin`
- `agentObservatoryServerPlugin`
- `AGENT_OBSERVATORY_MANIFEST`
- `ApiServer` 兼容入口

## 验证

```bash
corepack pnpm --filter @yiku/agent-studio test
corepack pnpm --filter @yiku/agent-observatory test
corepack pnpm --filter @yiku/agent-observatory build
```

事件事实源见 [可观测性](../architecture/observability.md)。
