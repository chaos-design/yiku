# 站点部署

`site/`（`@yiku/site`）把 `docs/` 与 `artifacts/` 渲染成一个可在线访问的可视化页面：
左侧导航联动右侧内容区，文档以 Markdown 实时渲染，产物以内嵌可视化页面呈现。
站点在**构建时**把 `docs/` 与 `artifacts/` 一起打包，产物是完全静态的，
GitHub Pages 与 Vercel 两条路径均可直接部署。

## 站点能力

- **文档中心**：`docs/` 下全部 Markdown（架构层 / 功能层 / 原子层）在页面内渲染，
  支持 GFM 表格、代码高亮、Mermaid 流程图，左侧侧边栏与文档内目录联动。
- **产物可视化**：`artifacts/` 下的交互式产物（架构分享页、面试题库、面试控制台）
  以同来源 `iframe` 内嵌，相对路径加载 `assets/` 与 `screenshots/`。
- **导航联动**：hash 路由（`#/doc/...`、`#/artifact/...`），因此既能在
  GitHub Pages 的子路径（`/yiku/`）下运行，也能在 Vercel 的根路径下运行，
  无需服务端重写即可工作；文档之间的相对链接会被改写为站点内 hash 路由。

## 本地开发

```bash
# 安装（仓库根目录）
corepack pnpm install

# 本地运行站点（Vite dev server，端口 5174）
corepack pnpm site

# 生产构建（产物输出到 site/dist/）
corepack pnpm site:build

# 在本地预览构建产物
corepack pnpm site:preview
```

根 `package.json` 提供 `site`、`site:build`、`site:preview` 三个便捷脚本，
等价于 `corepack pnpm --filter @yiku/site <dev|build|preview>`。
站点包自身也暴露相同的 `dev` / `build` / `preview` / `typecheck` / `lint` 脚本。

- 开发时 `docs/` 通过 Vite 虚拟模块按构建读取，`artifacts/` 由 dev server 直接服务，
  改 `docs/` 或 `artifacts/` 立即热更新，无需重启。
- 类型检查：`corepack pnpm --filter @yiku/site typecheck`（`tsc -b`）。
- 代码检查：`corepack pnpm --filter @yiku/site lint`（Biome，遵循根 `biome.json`）。

站点被有意放在顶层 `site/` 而非 `packages/`，因此不进入根 `tsc -b` 的
Project References，也不计入根 Vitest 的 90% 覆盖率门禁。

## 构建与产物

构建命令为 `tsc -b && vite build`：先做 TypeScript 项目检查，再由 Vite 产出
`site/dist/`。产物结构：

```text
site/dist/
  index.html              # 站点入口（base 为 "./"，相对资源）
  assets/                # 打包后的 JS/CSS（含 Mermaid、代码高亮）
  artifacts/             # 从 ../artifacts 拷贝：3 个 HTML + assets/ + screenshots/
    yiku-architecture-share.html
    yiku-interview-bank.html
    yiku-interview.html
    assets/  screenshots/
```

产物是自包含静态文件，任何静态托管（本地 `vite preview`、GitHub Pages、
Vercel、对象存储）都能直接服务。

## 部署方式一：GitHub Pages

仓库已内置工作流 `.github/workflows/site.yml`：

- 推送到 `main` 及每个针对 `main` 的 PR 都会安装依赖并构建站点；
  仅在 `main` 上发布到 GitHub Pages，PR 上只构建并校验产物、不发布。

启用步骤（一次性）：

1. 打开仓库 **Settings → Pages → Build and deployment → Source**，选择
   **GitHub Actions**（否则 `deploy-pages` 无法发布）。
2. 将本分支合并到 `main` 后，工作流自动部署。
3. 访问地址为 `<org-or-user>.github.io/yiku/`；若改了默认分支名，同步更新
   工作流里 `push.branches` 与两处 `refs/heads/main` 守卫。

所需权限：Actions 已声明 `contents: read`、`pages: write`、`id-token: write`。

## 部署方式二：Vercel

仓库根已提供 `vercel.json`，导入到 Vercel 后零配置即可部署：

- **Build Command**：`pnpm install --frozen-lockfile && pnpm --filter @yiku/site build`
- **Output Directory**：`site/dist`
- **Framework**：null（纯静态，不用 Vercel 的 Next.js/框架探测）
- **Rewrites**：把不带文件扩展名的路径回退到 `index.html`（SPA 兜底）；
  带扩展名的真实文件（`assets/*`、`artifacts/*.html|svg|png`）保持静态直出。
- **Headers**：`/assets/*` 长缓存（内容哈希指纹），`/artifacts/*` 短缓存并设
  `X-Frame-Options: SAMEORIGIN` 保障内嵌 iframe。

导入：在 Vercel 选择本仓库 → 确认 Build/Output 已由 `vercel.json` 提供
（若 Vercel 提示覆盖，保留 `vercel.json` 的值即可）→ Deploy。

### 两条路径的取舍

| 维度 | GitHub Pages | Vercel |
| --- | --- | --- |
| 部署源 | 合并到 `main` 自动发布 | 推送任意分支/PR 自动预览 |
| 地址 | `<user>.github.io/yiku/`（子路径） | 自定义域名或 `<vercel>` 根路径 |
| 配置 | `.github/workflows/site.yml` | `vercel.json` |
| 环境变量 | 无 | 无（纯静态） |

两种方式都不需要额外环境变量或密钥；站点是完全静态的自包含产物。
Vercel 因在**根路径**下服务、且默认支持自定义域名，通常作为主线上环境；
GitHub Pages 适合作为随仓库的免费镜像。

## 维护说明

- 新增/修改 `docs/` 文档后，侧边栏与首页卡片会在下次构建时自动更新
  （由 `vite.config.ts` 的虚拟模块按 `docs/**/*.md` 收集）。
- 新增 `artifacts/` 下的产物页时，需在 `site/src/artifacts.ts` 的
  `artifactPages` 登记一条（`slug`、`title`、`description`、`file`、`tags`），
  它才会出现在侧边栏、首页与产物画廊；拷贝本身由 `vite.config.ts` 通配完成。
- 视觉沿用仓库工业深色设计系统（`site/src/styles.css` 的 `--bg`/`--surface` 等变量），
  与 `artifacts/` 分享页保持一致。
