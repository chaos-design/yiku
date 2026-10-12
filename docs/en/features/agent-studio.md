# Agent Studio

`@yiku/agent-studio` is a protocol-agnostic local Agent Studio SDK; `@yiku/agent-observatory` is the Atomic Flow plugin and default Web preset provided by Yiku.

## Boundaries Between the Two Packages

| Package | Responsibility |
| --- | --- |
| `@yiku/agent-studio` | Run/Event, Store, Registry, HTTP/SSE, React Shell, plugin system |
| `@yiku/agent-observatory` | Atomic Flow Adapter, Topology, Trajectory, Replay, default UI |

Studio does not depend on Atomic Flow, specific Agents, Memory, Eval, or the CLI. Observatory connects to these Yiku semantics through Studio's public plugin contract.

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

Binds only to `127.0.0.1` by default. A custom Host is only allowed to be `127.0.0.1` or `localhost`.

## Server API

| Path | Purpose |
| --- | --- |
| `GET /api/studio/health` | Health check |
| `GET /api/studio/manifest` | Plugin Manifest |
| `POST /api/studio/ingest/<adapter-id>` | Receives external events |
| `GET /api/studio/runs` | Run list |
| `GET /api/studio/runs/<run-id>` | Run details |
| `GET /api/studio/runs/<run-id>/events` | Event list |
| `GET .../events` + `Accept: text/event-stream` | SSE |
| `/api/plugins/<plugin-id>/*` | Plugin Route |

Ingest returns `202`; duplicate Events return `200` idempotently. Errors include a stable Code, Message, and Request ID.

## Store and Registry

`FileStudioStore` saves Events as JSONL. `StudioRunRegistry`:

- Sorts by `runId + sequence`;
- Deduplicates Events;
- Updates Run Metadata via the Projector;
- Supports historical lists and live subscriptions;
- Rebuilds projections from JSONL.

The host can inject a custom `StudioStore`. A host Store and a plugin Store cannot coexist, and multiple plugins cannot each provide a Store.

## Server Plugins

A `StudioServerPlugin` can contribute:

- Event Adapter;
- Run Projector;
- Status Definition;
- HTTP Route;
- Store;
- Initialize/Dispose lifecycle.

The plugin Manifest declares the ID, name, version, Studio version, Capability, and dependencies. At startup, the following are rejected:

- Missing or circular dependencies;
- Incompatible Studio versions;
- Duplicate Adapters, Projectors, Statuses, or Routes;
- Multiple Stores.

## React Host

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

Client contribution points:

- Page;
- Navigation;
- Slot;
- Event Renderer;
- Graph Provider;
- Run Action;
- Theme Token.

Supported Slots include Header Action, Navigation Footer, Run Sidebar/Toolbar, Event Inspector, and Page Footer. Client and server plugins use the same Manifest ID, but are loaded from separate entries to prevent the browser Bundle from pulling in Node modules.

## Agent Observatory

Startup:

```bash
yiku web --port 3333
```

Observatory provides:

- Runtime, Agent, Skill, Subagent, Memory, Telemetry, and Quality sections;
- Fixed Atoms and dynamic domain Atoms;
- Orthogonal connections and routing diagnostics;
- Run History and auto-follow;
- An Event Log that automatically follows the current event and supports locating running nodes, and an Event Inspector that distinguishes event data from Run Scorecards;
- A Topology that reuses the layout cache within the page, and a Trajectory grouped by Turn that supports returning to the latest state;
- Live, single-step, and multi-speed Replay;
- `?runId=<id>&view=trajectory` deep links.

The page only observes; it does not send Prompts from the browser, cancel Agents, or modify the Runtime. Input still takes place in the terminal that launched `yiku web`.

## Observatory Plugins

Client:

```ts
import { agentObservatoryClientPlugin } from "@yiku/agent-observatory/plugin/react";

const plugin = agentObservatoryClientPlugin({ path: "/flow" });
```

Server:

```ts
import { agentObservatoryServerPlugin } from "@yiku/agent-observatory/plugin/server";
```

Compatible hosts can use `ApiServer` from `@yiku/agent-observatory/server`. Atomic Flow Events can still be delivered to `POST /api/ingest/events`, with the compatible Run API and SSE provided by the Observatory Server.

## Custom Extensions

`playground/agent-observatory` demonstrates:

- Custom pages and navigation;
- Plugin API Routes;
- Slot;
- Theme;
- Composition with the default Observatory.

```bash
corepack pnpm --filter @yiku/agent-observatory-playground dev
```

## Security and Failures

- The Server binds only to the loopback address;
- Static file resolution rejects directory escapes;
- Request Bodies have a size limit;
- Plugin Routes and Ingest use a unified error protocol;
- Subscriptions and Heartbeats are cleaned up when an SSE connection closes;
- Plugins are disposed in reverse order;
- Observation delivery failures only mark the source Flow as Degraded;
- Studio does not hold Agent Runtime permissions.

## Main Exports

### Agent Studio

- `StudioServer`
- `StudioRunRegistry`
- `FileStudioStore`
- `StudioShell`
- `StudioProvider`
- Plugin ordering, validation, Client/Server types

### Agent Observatory

- `App`
- `agentObservatoryClientPlugin`
- `agentObservatoryServerPlugin`
- `AGENT_OBSERVATORY_MANIFEST`
- `ApiServer` compatibility entry

## Validation

```bash
corepack pnpm --filter @yiku/agent-studio test
corepack pnpm --filter @yiku/agent-observatory test
corepack pnpm --filter @yiku/agent-observatory build
```

The event source of truth is described in [Observability](../architecture/observability.md).
