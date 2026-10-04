import type { AtomicFlowEvent } from "@yiku/atomic-flow/browser";
import type { AtomLayout } from "../data/atom-layout.js";
import { atomResponsibility } from "../data/atom-metadata.js";
import type { AtomRuntimeView } from "../state/flow-selectors.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.js";

interface AtomNodeProps {
  readonly atom: AtomLayout;
  readonly executionActive: boolean;
  readonly observed: boolean;
  readonly onSelect: (sequence: number) => void;
  readonly selected: boolean;
  readonly view?: AtomRuntimeView | undefined;
}

export function AtomNode({
  atom,
  executionActive,
  observed,
  onSelect,
  selected,
  view,
}: AtomNodeProps) {
  const status = view?.latest?.status ?? "scheduled";
  const sequence = view?.latest?.lastSequence;
  const invocation = atomInvocation(atom, view?.latestEvent);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className={`atom-node atom-${atom.kind} status-${status}${
            selected ? " is-selected" : ""
          }${observed ? " is-observed" : ""}${
            executionActive ? " is-execution-active" : ""
          }${atom.level === "deep" ? " is-deep" : ""}`}
          data-atom-key={atom.key}
          data-focus={atom.focus}
          data-invocation={invocation?.type}
          onClick={() => {
            if (sequence !== undefined) {
              onSelect(sequence);
            }
          }}
          style={{
            left: atom.x,
            top: atom.y,
            width: atom.width,
          }}
          type="button"
        >
          <span className="atom-status" title={status} />
          <em className="atom-count">×{view?.count ?? 0}</em>
          <strong className="atom-label">{atom.label}</strong>
          <span className="atom-meta">
            {invocation === undefined ? (
              <small>{atom.key}</small>
            ) : (
              <span
                className={`atom-invocation atom-invocation-${invocation.type}`}
                title={`${invocation.type.toUpperCase()} · ${invocation.label}`}
              >
                <b>{invocation.type.toUpperCase()}</b>
                <span>{invocation.label}</span>
              </span>
            )}
            {view?.latest?.iteration !== undefined ? (
              <span className="atom-iteration">turn {view.latest.iteration}</span>
            ) : null}
          </span>
          <span className="atom-focus" title={`${atom.focus} concern`}>
            {atom.focus.toUpperCase()}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent align="start" sideOffset={8}>
        <div className="atom-node-tooltip">
          <strong>{atom.label}</strong>
          <p>{atomResponsibility(atom)}</p>
          <div className="atom-node-tooltip-meta">
            <code>{atom.key}</code>
            <span>{atom.kind}</span>
            <span>{atom.domain}</span>
            {invocation === undefined ? null : (
              <span className={`atom-tooltip-invocation-${invocation.type}`}>
                {invocation.type.toUpperCase()} · {invocation.label}
              </span>
            )}
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

interface AtomInvocation {
  readonly label: string;
  readonly type: "mcp" | "skill";
}

function atomInvocation(
  atom: Pick<AtomLayout, "key" | "kind">,
  event: AtomicFlowEvent | undefined,
): AtomInvocation | undefined {
  if (atom.kind === "skill") {
    const name = atomicString(event?.payload?.values?.name) ?? event?.payload?.summary?.trim();
    return name ? { label: name, type: "skill" } : undefined;
  }
  if (atom.key !== "tool.call") {
    return undefined;
  }
  const toolName = atomicString(event?.payload?.values?.toolName);
  if (toolName === undefined || !toolName.startsWith("mcp__")) {
    return undefined;
  }
  const [server, ...toolParts] = toolName.slice("mcp__".length).split("__");
  const tool = toolParts.join("__");
  return server && tool ? { label: `${server}/${tool}`, type: "mcp" } : undefined;
}

function atomicString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
