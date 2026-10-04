import {
  ArrowUp,
  ChevronDown,
  Gauge,
  Layers3,
  LoaderCircle,
  Radar,
  Settings2,
  Sparkles,
  Square,
  WandSparkles,
} from "lucide-react";
import { type KeyboardEvent, useLayoutEffect, useRef, useState } from "react";
import type { ResearchSendMode, ResearchSkillPreset } from "../research-settings.js";
import { Badge } from "./ui/badge.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.js";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "./ui/input-group.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.js";

interface ChatComposerProps {
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onChange: (value: string) => void;
  readonly onOpenSettings: () => void;
  readonly onSkillChange: (skillId: string) => void;
  readonly onSubmit: () => void;
  readonly selectedSkillId: string;
  readonly sendMode: ResearchSendMode;
  readonly skillOptions: readonly ResearchSkillPreset[];
  readonly value: string;
}

export function ChatComposer({
  busy,
  onCancel,
  onChange,
  onOpenSettings,
  onSkillChange,
  onSubmit,
  selectedSkillId,
  sendMode,
  skillOptions,
  value,
}: ChatComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [skillMenuOpen, setSkillMenuOpen] = useState(false);
  const selectedSkill =
    skillOptions.find((option) => option.id === selectedSkillId) ?? skillOptions[0];

  useLayoutEffect(() => {
    resizeTextarea(textareaRef.current, value);
  }, [value]);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === "Enter" &&
      !busy &&
      ((sendMode === "enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey) ||
        ((event.metaKey || event.ctrlKey) && !event.shiftKey))
    ) {
      event.preventDefault();
      onSubmit();
    } else if (event.key === "Escape" && skillMenuOpen) {
      event.preventDefault();
      setSkillMenuOpen(false);
    }
  };

  return (
    <div className="composer-shell">
      <InputGroup aria-busy={busy}>
        <InputGroupTextarea
          aria-label="Research prompt"
          maxLength={8_000}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            busy
              ? "研究正在执行，你可以继续起草下一轮问题..."
              : "提出一个需要检索、取证和交叉验证的问题..."
          }
          ref={textareaRef}
          rows={2}
          value={value}
        />
        <InputGroupAddon align="block-end">
          <div className="composer-context">
            <DropdownMenu onOpenChange={setSkillMenuOpen} open={skillMenuOpen}>
              <DropdownMenuTrigger asChild>
                <InputGroupButton
                  className="composer-skill-trigger"
                  onClick={() => setSkillMenuOpen((open) => !open)}
                  onPointerDown={(event) => event.preventDefault()}
                  size="sm"
                  variant="ghost"
                >
                  <WandSparkles data-icon="inline-start" />
                  <span>{selectedSkill?.label ?? "Research"}</span>
                  <ChevronDown data-icon="inline-end" />
                </InputGroupButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="skill-menu">
                <DropdownMenuLabel>
                  <span>RESEARCH SKILL</span>
                  <small>为下一轮选择执行策略</small>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuRadioGroup
                    onValueChange={(value) => {
                      if (skillOptions.some((option) => option.id === value)) {
                        onSkillChange(value);
                      }
                    }}
                    value={selectedSkill?.id ?? "research"}
                  >
                    {skillOptions.map(({ baseSkill, description, id, label, source }) => {
                      const Icon = source === "custom" ? Sparkles : skillIcon(baseSkill);
                      return (
                        <DropdownMenuRadioItem className="skill-menu-item" key={id} value={id}>
                          <span className="skill-menu-icon">
                            <Icon />
                          </span>
                          <span className="skill-menu-copy">
                            <strong>{label}</strong>
                            <small>{description}</small>
                          </span>
                        </DropdownMenuRadioItem>
                      );
                    })}
                  </DropdownMenuRadioGroup>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuItem onSelect={onOpenSettings}>
                    <Settings2 />
                    管理 Skills 与 Agent 设置
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            {busy ? (
              <Badge variant="outline">
                <LoaderCircle data-icon="inline-start" />
                研究进行中
              </Badge>
            ) : null}
          </div>
          <div className="composer-actions">
            {busy ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <InputGroupButton
                    aria-label="停止研究"
                    onClick={onCancel}
                    size="icon-sm"
                    variant="destructive"
                  >
                    <Square data-icon="inline-start" fill="currentColor" />
                  </InputGroupButton>
                </TooltipTrigger>
                <TooltipContent>停止研究</TooltipContent>
              </Tooltip>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <InputGroupButton
                    aria-label="提交研究问题"
                    className="composer-submit-button"
                    disabled={!value.trim()}
                    onClick={onSubmit}
                    size="icon-sm"
                    variant="default"
                  >
                    <ArrowUp data-icon="inline-start" />
                  </InputGroupButton>
                </TooltipTrigger>
                <TooltipContent>提交研究问题</TooltipContent>
              </Tooltip>
            )}
          </div>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}

function skillIcon(skill: ResearchSkillPreset["baseSkill"]): typeof Layers3 {
  switch (skill) {
    case "quick-research":
      return Gauge;
    case "deep-research":
      return Radar;
    case "research":
      return Layers3;
  }
}

function resizeTextarea(element: HTMLTextAreaElement | null, value: string): void {
  if (element === null) {
    return;
  }
  element.style.height = "0px";
  element.style.height = value ? `${Math.min(element.scrollHeight, 192)}px` : "";
}
