# 组件实验室

This is a template for a new Vite project with React, TypeScript, and shadcn/ui.

## Testing the Yiku CLI

Build the monorepo packages first so the CLI binary exists:

```bash
corepack pnpm --dir ../.. build
```

Then run the CLI with this playground project as the current workspace:

```bash
corepack pnpm agent "Inspect this frontend project and run pnpm lint and pnpm build"
```

From the monorepo root, use the workspace filter:

```bash
corepack pnpm --filter react-vite-shadcn agent "Inspect this frontend project and run pnpm lint and pnpm build"
```

## Adding components

To add components to your app, run the following command:

```bash
npx shadcn@latest add button
```

This will place the ui components in the `src/components` directory.

## Using components

To use the components in your app, import them as follows:

```tsx
import { Button } from "@/components/ui/button"
```
