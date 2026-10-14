# Site Deployment

`site/` (`@yiku/site`) renders `docs/` and `artifacts/` into a single online, accessible visual page: the left navigation drives the right content area, documents render live as Markdown, and artifacts appear as embedded visual pages. The site bundles `docs/` and `artifacts/` together at **build time**; the output is completely static and can be deployed directly via either the GitHub Pages or the Vercel path.

## Site Capabilities

- **Documentation center**: all Markdown files under `docs/` (architecture layer / feature layer / atom layer) render inside the page, supporting GFM tables, code highlighting, and Mermaid diagrams, with the left sidebar linked to the in-document table of contents.
- **Artifact visualization**: interactive artifacts under `artifacts/` (the architecture share page, interview question bank, and interview console) are embedded via same-origin `iframe`, loading `assets/` and `screenshots/` via relative paths.
- **Navigation linkage**: hash routing (`#/doc/...`, `#/artifact/...`), so the site works both under a GitHub Pages subpath (`/yiku/`) and under the Vercel root path, without server-side rewrites; relative links between documents are rewritten into in-site hash routes.

## Local Development

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

The root `package.json` provides three convenience scripts — `site`, `site:build`, and `site:preview` — equivalent to `corepack pnpm --filter @yiku/site <dev|build|preview>`. The site package itself also exposes the same `dev` / `build` / `preview` / `typecheck` / `lint` scripts.

- During development, `docs/` is read via Vite virtual modules on each build, `artifacts/` is served directly by the dev server, and changes to `docs/` or `artifacts/` trigger immediate hot updates without a restart.
- Type checking: `corepack pnpm --filter @yiku/site typecheck` (`tsc -b`).
- Code linting: `corepack pnpm --filter @yiku/site lint` (Biome, following the root `biome.json`).

The site is intentionally placed at the top-level `site/` rather than `packages/`, so it does not enter the root `tsc -b` Project References and is not counted toward the root Vitest 90% coverage gate.

## Build and Output

The build command is `tsc -b && vite build`: first the TypeScript project check runs, then Vite produces `site/dist/`. The output structure:

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

The output is self-contained static files that any static hosting (local `vite preview`, GitHub Pages, Vercel, object storage) can serve directly.

## Deployment Method 1: GitHub Pages

The repository ships with the workflow `.github/workflows/site.yml`:

- Pushes to `main` and every PR targeting `main` install dependencies and build the site; publishing to GitHub Pages happens only on `main`, while PRs only build and validate the artifacts without publishing.

Enablement steps (one-time):

1. Open the repository **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions** (otherwise `deploy-pages` cannot publish).
2. After merging this branch into `main`, the workflow deploys automatically.
3. The site address is `<org-or-user>.github.io/yiku/`; if the default branch name changes, update the workflow's `push.branches` and the two `refs/heads/main` guards accordingly.

Required permissions: Actions already declares `contents: read`, `pages: write`, and `id-token: write`.

## Deployment Method 2: Vercel

The repository root already provides `vercel.json`; after importing into Vercel, deployment works with zero configuration:

- **Build Command**: `pnpm install --frozen-lockfile && pnpm --filter @yiku/site build`
- **Output Directory**: `site/dist`
- **Framework**: null (purely static, without Vercel's Next.js/framework detection)
- **Rewrites**: fall back paths without file extensions to `index.html` (SPA fallback); real files with extensions (`assets/*`, `artifacts/*.html|svg|png`) remain statically served.
- **Headers**: long caching for `/assets/*` (content-hash fingerprints), short caching for `/artifacts/*` with `X-Frame-Options: SAMEORIGIN` to secure the embedded iframes.

Import: select this repository in Vercel → confirm that Build/Output are provided by `vercel.json` (if Vercel prompts to override, keep the `vercel.json` values) → Deploy.

### Trade-offs Between the Two Paths

| Dimension | GitHub Pages | Vercel |
| --- | --- | --- |
| Deployment source | Auto-publish on merge to `main` | Auto-preview on push to any branch/PR |
| Address | `<user>.github.io/yiku/` (subpath) | Custom domain or `<vercel>` root path |
| Configuration | `.github/workflows/site.yml` | `vercel.json` |
| Environment variables | None | None (purely static) |

Neither method requires additional environment variables or secrets; the site is a completely static, self-contained artifact. Because Vercel serves under the **root path** and supports custom domains by default, it is usually the primary production environment; GitHub Pages is suitable as a free mirror alongside the repository.

## Maintenance Notes

- After adding or modifying `docs/` documents, the sidebar and homepage cards update automatically on the next build (collected by the `vite.config.ts` virtual module from `docs/**/*.md`).
- When adding a new artifact page under `artifacts/`, register an entry in `artifactPages` in `site/src/artifacts.ts` (`slug`, `title`, `description`, `file`, `tags`); only then does it appear in the sidebar, homepage, and artifact gallery. The copying itself is done by the `vite.config.ts` glob.
- The visuals follow the repository's industrial dark design system (`--bg`/`--surface` and other variables in `site/src/styles.css`), consistent with the `artifacts/` share page.
