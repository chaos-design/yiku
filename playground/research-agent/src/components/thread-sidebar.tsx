import { Ellipsis, MessageSquareText, Plus, Radio, Trash2 } from "lucide-react";
import { useState } from "react";
import type { ResearchThreadSummary } from "../types.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.js";

interface ThreadSidebarProps {
  readonly deletingThreadId?: string | undefined;
  readonly onDelete: (threadId: string) => void;
  readonly onNewThread: () => void;
  readonly onSelect: (threadId: string) => void;
  readonly selectedThreadId?: string | undefined;
  readonly threads: readonly ResearchThreadSummary[];
}

export function ThreadSidebar({
  deletingThreadId,
  onDelete,
  onNewThread,
  onSelect,
  selectedThreadId,
  threads,
}: ThreadSidebarProps) {
  const [openMenuThreadId, setOpenMenuThreadId] = useState<string>();

  return (
    <aside className="thread-sidebar">
      <header className="sidebar-brand">
        <span className="sidebar-brand-mark">Y</span>
        <div>
          <strong>YIKU RESEARCH</strong>
          <small>EVIDENCE WORKSPACE</small>
        </div>
      </header>

      <button className="new-thread-button" onClick={onNewThread} type="button">
        <Plus size={16} />
        新建研究
      </button>

      <div className="thread-section-heading">
        <span>CONVERSATIONS</span>
        <em>{String(threads.length).padStart(2, "0")}</em>
      </div>

      <nav aria-label="研究会话" className="thread-list">
        {threads.length === 0 ? (
          <div className="thread-list-empty">
            <MessageSquareText size={18} />
            <p>还没有研究会话。</p>
          </div>
        ) : (
          threads.map((thread) => {
            const deleting = deletingThreadId === thread.threadId;
            return (
              <div
                className={`thread-item${
                  thread.threadId === selectedThreadId ? " is-selected" : ""
                }${deleting ? " is-deleting" : ""}`}
                key={thread.threadId}
              >
                <button
                  aria-label={`打开研究会话：${thread.title}`}
                  className="thread-select-button"
                  disabled={deleting}
                  onClick={() => onSelect(thread.threadId)}
                  type="button"
                >
                  <span className={`thread-status is-${thread.status}`}>
                    <Radio size={9} />
                  </span>
                  <span className="thread-copy">
                    <strong>{thread.title}</strong>
                    <small>{thread.lastMessage ?? "等待第一个问题"}</small>
                  </span>
                  <time dateTime={thread.updatedAt}>{formatRelative(thread.updatedAt)}</time>
                </button>
                <div className="thread-actions">
                  <DropdownMenu
                    modal={false}
                    onOpenChange={(open) => setOpenMenuThreadId(open ? thread.threadId : undefined)}
                    open={openMenuThreadId === thread.threadId}
                  >
                    <DropdownMenuTrigger asChild>
                      <button
                        aria-label={`打开会话操作：${thread.title}`}
                        className="thread-actions-trigger"
                        disabled={deleting}
                        onClick={() =>
                          setOpenMenuThreadId((current) =>
                            current === thread.threadId ? undefined : thread.threadId,
                          )
                        }
                        onPointerDown={(event) => event.preventDefault()}
                        type="button"
                      >
                        <Ellipsis />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="thread-action-menu">
                      <DropdownMenuGroup>
                        <DropdownMenuItem
                          disabled={deleting}
                          onSelect={() => {
                            setOpenMenuThreadId(undefined);
                            onDelete(thread.threadId);
                          }}
                          variant="destructive"
                        >
                          <Trash2 />
                          删除会话
                        </DropdownMenuItem>
                      </DropdownMenuGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            );
          })
        )}
      </nav>

      <footer className="sidebar-footer">
        <span>LOCAL RUNTIME</span>
        <strong>Research Agent</strong>
      </footer>
    </aside>
  );
}

function formatRelative(value: string): string {
  const timestamp = Date.parse(value);
  const elapsed = Date.now() - timestamp;
  if (!Number.isFinite(timestamp) || elapsed < 60_000) {
    return "NOW";
  }
  if (elapsed < 3_600_000) {
    return `${Math.max(1, Math.floor(elapsed / 60_000))}M`;
  }
  if (elapsed < 86_400_000) {
    return `${Math.floor(elapsed / 3_600_000)}H`;
  }
  return `${Math.floor(elapsed / 86_400_000)}D`;
}
