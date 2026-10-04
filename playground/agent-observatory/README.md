# Yiku Agent Observatory Playground

这个 playground 是 `@yiku/agent-studio` 插件能力的薄宿主示例。正式 Studio 实现在：

- `packages/agent-studio`：协议无关的全栈 Studio SDK。
- `packages/agent-observatory`：Atomic Flow 默认插件和 `yiku web` 预设。

启动：

```bash
corepack pnpm --filter @yiku/agent-observatory-playground dev
```

示例组合两个编译期插件：

- Atomic Flow 插件提供 Run 历史、流程图、事件检查和 Replay。
- Workspace 插件提供导航、页面、Header Slot、主题 Token，以及 Settings、Memories、
  Prompts 只读 API。

Playground 不拥有 Run Registry、HTTP/SSE 内核或 Atomic Flow UI 实现。
