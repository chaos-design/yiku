# Agent Studio

`@yiku/agent-studio` 是协议无关的本地 Agent Studio SDK。它提供：

- Run/Event 通用模型与确定性插件排序。
- JSONL Store、Run Registry、HTTP/SSE Server。
- React Provider、页面、导航、Slot、事件渲染、图谱和主题贡献点。
- 编译期 TypeScript 插件的依赖、冲突和版本校验。

该包不依赖 Atomic Flow、Memory、Eval、Trajectory 或具体 Agent。

## 服务端宿主

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

事件入口为 `POST /api/studio/ingest/example`，Run、Manifest 和 SSE 使用
`/api/studio/*`。

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
  navigation: [
    {
      id: "example",
      label: "Example",
      pageId: "example",
    },
  ],
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

前端和服务端插件使用相同 Manifest ID 与版本，但分别从浏览器和 Node 入口加载，避免浏览器
Bundle 引入 Node 模块。

页面可以在自己的 Header 中渲染 `StudioNavigationDrawer`。只要注册表中存在一个有效导航
条目，Menu 就保持可见；后续插件贡献的 Memories、配置或评测页面会按 `order` 自动进入同一
抽屉。

## 插件路由

服务端插件 Route 自动挂载到 `/api/plugins/<plugin-id>/*`。React 插件使用
`pluginRequest(pluginId, path)` 请求，错误统一转换为 `StudioClientError`。

## 约束

- 插件 ID 使用小写点号或 kebab-case。
- 插件依赖通过 `manifest.requires` 显式声明。
- 重复 Page、Route、Adapter、Projector、Status、Action 或 Renderer 会在启动时失败。
- JSONL 是事实源；Run Metadata 是可重建投影。
- Server 默认只绑定回环地址。
