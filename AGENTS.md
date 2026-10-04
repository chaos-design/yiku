# Yiku AI 协作指令

本文只面向参与本仓库开发的 AI。公开功能与架构说明以 `README.md` 和 `docs/` 为准。

## 项目概览

Yiku 是一个基于 TypeScript、ESM 和 pnpm Workspace 的 Agent 运行时 Monorepo。正式包位于
`packages/`，示例与实验应用位于 `playground/`。

- `@yiku/cli`：终端宿主，负责 Ink UI、Prompt、补全、Slash Command、权限交互和时间线展示。
- `@yiku/agent-orchestrator`：唯一负责构建和运行完整 Agent Session 的包。
- `@yiku/agent-code`、`@yiku/agent-research`：定义 Agent 能力、工具、Prompt 和领域逻辑。
- `@yiku/config`、`@yiku/hooks`、`@yiku/memories`、`@yiku/evals`：配置与策略服务。
- `@yiku/sandbox`：无 Agent 依赖的 Shell 进程隔离与平台启动描述。
- `@yiku/atomic-flow`、`@yiku/trajectory`、`@yiku/flow-graph`：运行事件、轨迹投影和图布局。
- `@yiku/agent-studio`：协议无关的 Studio Shell 与插件契约。
- `@yiku/agent-observatory`：默认 Studio 插件和本地 Web 观测预设。

详细依赖方向见 `docs/architecture/package-boundaries.md`。不得让基础包反向依赖 CLI、具体 Agent
或展示层。

## 环境与命令

- Node.js 版本为 `>=22.13.0`。
- 必须通过 Corepack 使用根 `package.json` 声明的 pnpm 版本。
- 构建使用 TypeScript Project References，即 `tsc -b`。
- 代码检查使用 Biome；不要引入 ESLint 或 Prettier。

常用命令：

```bash
corepack pnpm install
corepack pnpm build
corepack pnpm watch
corepack pnpm lint
corepack pnpm test
corepack pnpm check
```

优先运行受影响 Package 的聚焦测试，再运行根级门禁。正式 Package 必须保留
`"watch": "tsc -b --watch --preserveWatchOutput"`。

## 工作方式

- 修改前先阅读对应实现、测试、Package README 和 `docs/` 中的权威主题。
- 保持改动局部，不顺带重构无关模块，不覆盖用户已有改动。
- 未经用户明确要求，不创建 Git Commit。
- 未经用户明确要求，不打开浏览器、不生成浏览器 Mockup、不要求用户进行视觉选型。
- 视觉和布局调整应沿用已有设计系统，选择最保守且一致的实现。
- 源码与文档冲突时，以公开入口和测试所表达的现有行为为准，并同步修正文档。

## 代码约定

- 只使用相对导入，不引入路径别名。
- `index.ts` 和 `index.tsx` 只负责导出。
- 优先使用职责单一的小模块和模块内局部 `types.ts`。
- 新增依赖前确认标准库或仓库现有依赖不能合理解决问题。
- 不生成 `.js.map` 或 `.d.ts.map`。
- `packages/cli/bin/yiku.js` 必须始终启动 `dist/index.js`。
- Prompt 模板、渲染器和专属 UI 归使用它的 Package 所有，不建立跨包 Prompt 共享层。
- CLI 不直接构建 Agent Graph；Agent 包不执行 Session；Studio 不绑定具体业务协议。

## 文档语言约定

- 文档散文默认中文，包括章节标题、说明文字和表格描述。
- 标识符保持英文原文：包名、配置键、命令、文件路径、类型名、函数名、诊断码和 UI 分案名。
  这些名字在代码、配置和界面上就是英文，翻译会让文档与实际实现脱节。
- 文档链接的标签与目标文档标题保持一致。
- 新增或改写文档时，其中的默认值、阈值和失败语义必须回查源码后再写，不能只依据其他文档的
转述。跨文档转述会产生错误传播。

## 前端约定

- 前端文件名统一使用全小写 kebab-case。
- 函数名统一使用 camelCase。
- 保持 Agent Flow Studio 现有的工业深色视觉语言。
- 不为了满足命名规则重命名无关历史文件。

## 测试约定

- 正式 Package 的测试应覆盖正常路径、边界输入、故障、中止、权限和协议兼容行为。
- 正式 Package 的测试统一位于包级 `tests/` 并镜像 `src/`；禁止在 `src/` 或其他生产源码目录
  共置测试文件。
- 根 Vitest 使用 V8 Coverage，语句、分支、函数和行覆盖率门槛均为 90%。
- 纯类型文件和只导出的入口不计覆盖率。
- `playground/` 只用于示例和实验，禁止新增或保留测试文件、测试脚本、测试依赖及测试专属
  配置；该规则适用于其中的前端、服务端、状态和工具代码。
- `playground/` 的修改只通过 TypeScript 类型检查、Biome、构建和必要的人工运行验证，不纳入
  Vitest 收集与覆盖率统计。
- 测试不得默认依赖公网、用户 Home 数据或真实密钥，应使用临时目录、Fixture 或 Fake。

## CLI 交互不变量

- Context Token 的紧凑单位统一使用大写 `K`、`M`。
- 底部状态栏的 Context 进度必须随 `usage_updated` 事件实时刷新；未知上限显示
  `unavailable`。
- `@` 文件筛选必须应用工作区根目录 `.gitignore` 中的规则；被忽略目录不得继续递归。
- CLI 收到 `session_failed` 后，时间线必须保留可读的失败原因；存在源码位置时一并展示，
  不得只显示 `failed` 状态。
- Tool、Assistant、Subagent 和错误使用现有 Append-only 时间线展示，不绕过 Orchestrator
  自建并行状态源。

## 验证要求

正式前端 Package 或 CLI 改动至少执行：

```bash
corepack pnpm --filter @yiku/cli test
corepack pnpm lint
corepack pnpm build
```

跨包协议、Runtime、Hook、Memory 或 Eval 改动还必须运行受影响包测试；提交前优先执行
`corepack pnpm check`。

`playground/` 改动不运行测试，应执行目标 Playground 的 `typecheck` 和 `build`，并在提供
`lint` 脚本时执行该脚本。
