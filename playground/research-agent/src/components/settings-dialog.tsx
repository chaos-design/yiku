import {
  Bot,
  Command,
  Compass,
  Plus,
  Settings2,
  Sparkles,
  Trash2,
  WandSparkles,
} from "lucide-react";
import { type FormEvent, useState } from "react";
import {
  availableSkillPresets,
  BUILTIN_RESEARCH_SKILLS,
  createCustomSkill,
  type ResearchSettings,
  selectedSkillPreset,
} from "../research-settings.js";
import type { ResearchSkillId } from "../types.js";
import { Button } from "./ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.js";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
  FieldTitle,
} from "./ui/field.js";
import { Input } from "./ui/input.js";
import { Kbd, KbdGroup } from "./ui/kbd.js";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select.js";
import { Switch } from "./ui/switch.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs.js";
import { Textarea } from "./ui/textarea.js";

interface SettingsDialogProps {
  readonly onOpenChange: (open: boolean) => void;
  readonly onSettingsChange: (settings: ResearchSettings) => void;
  readonly open: boolean;
  readonly settings: ResearchSettings;
}

interface SkillDraft {
  readonly baseSkill: ResearchSkillId;
  readonly description: string;
  readonly instructions: string;
  readonly name: string;
}

const EMPTY_SKILL_DRAFT: SkillDraft = {
  baseSkill: "research",
  description: "",
  instructions: "",
  name: "",
};

export function SettingsDialog({
  onOpenChange,
  onSettingsChange,
  open,
  settings,
}: SettingsDialogProps) {
  const [creatingSkill, setCreatingSkill] = useState(false);
  const [draft, setDraft] = useState<SkillDraft>(EMPTY_SKILL_DRAFT);
  const [draftError, setDraftError] = useState<string>();
  const modifier = isMacPlatform() ? "⌘" : "Ctrl";

  const update = (patch: Partial<ResearchSettings>) => {
    onSettingsChange({ ...settings, ...patch });
  };

  const toggleBuiltinSkill = (skillId: ResearchSkillId, enabled: boolean) => {
    const next = {
      ...settings,
      builtinSkills: {
        ...settings.builtinSkills,
        [skillId]: enabled,
      },
    };
    onSettingsChange(ensureSelectedSkill(next));
  };

  const toggleCustomSkill = (skillId: string, enabled: boolean) => {
    const next = {
      ...settings,
      customSkills: settings.customSkills.map((skill) =>
        skill.id === skillId ? { ...skill, enabled } : skill,
      ),
    };
    onSettingsChange(ensureSelectedSkill(next));
  };

  const deleteCustomSkill = (skillId: string) => {
    const next = {
      ...settings,
      customSkills: settings.customSkills.filter((skill) => skill.id !== skillId),
    };
    onSettingsChange(ensureSelectedSkill(next));
  };

  const handleCreateSkill = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft.name.trim()) {
      setDraftError("请输入 Skill 名称。");
      return;
    }
    if (!draft.instructions.trim()) {
      setDraftError("请输入这个 Skill 的执行指令。");
      return;
    }
    const created = createCustomSkill(draft);
    onSettingsChange({
      ...settings,
      customSkills: [...settings.customSkills, created],
      defaultSkillId: created.id,
    });
    setDraft(EMPTY_SKILL_DRAFT);
    setDraftError(undefined);
    setCreatingSkill(false);
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="research-settings-dialog">
        <DialogHeader className="research-settings-header">
          <span>
            <Settings2 />
          </span>
          <div>
            <DialogTitle>Research 设置</DialogTitle>
            <DialogDescription>偏好会自动保存在当前浏览器。</DialogDescription>
          </div>
        </DialogHeader>

        <Tabs className="research-settings-tabs" defaultValue="agent" orientation="vertical">
          <TabsList aria-label="设置分类" className="research-settings-nav" variant="line">
            <TabsTrigger value="agent">
              <Bot data-icon="inline-start" />
              Agent
            </TabsTrigger>
            <TabsTrigger value="skills">
              <WandSparkles data-icon="inline-start" />
              Skills
            </TabsTrigger>
            <TabsTrigger value="sources">
              <Compass data-icon="inline-start" />
              来源
            </TabsTrigger>
            <TabsTrigger value="shortcuts">
              <Command data-icon="inline-start" />
              快捷键
            </TabsTrigger>
          </TabsList>

          <div className="research-settings-content">
            <TabsContent value="agent">
              <SettingsSection description="控制下一轮研究的表达方式和长期指令。" title="Agent">
                <FieldGroup>
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldTitle>回答风格</FieldTitle>
                      <FieldDescription>决定最终报告的篇幅与信息密度。</FieldDescription>
                    </FieldContent>
                    <Select
                      onValueChange={(value) =>
                        update({
                          responseStyle: value as ResearchSettings["responseStyle"],
                        })
                      }
                      value={settings.responseStyle}
                    >
                      <SelectTrigger aria-label="回答风格">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent align="end" position="popper">
                        <SelectGroup>
                          <SelectItem value="concise">精简</SelectItem>
                          <SelectItem value="balanced">平衡</SelectItem>
                          <SelectItem value="detailed">详细</SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                  <FieldSeparator />
                  <Field>
                    <FieldLabel htmlFor="agent-custom-instructions">自定义指令</FieldLabel>
                    <Textarea
                      id="agent-custom-instructions"
                      maxLength={2_000}
                      onChange={(event) => update({ customInstructions: event.target.value })}
                      placeholder="例如：优先分析官方技术文档，并在结论中列出仍待验证的问题。"
                      rows={6}
                      value={settings.customInstructions}
                    />
                    <FieldDescription>这段指令会附加到所有后续 Research Turn。</FieldDescription>
                  </Field>
                </FieldGroup>
              </SettingsSection>
            </TabsContent>

            <TabsContent value="skills">
              <SettingsSection
                action={
                  <Button
                    disabled={settings.customSkills.length >= 12}
                    onClick={() => {
                      setDraftError(undefined);
                      setCreatingSkill((value) => !value);
                    }}
                    size="sm"
                    variant="outline"
                  >
                    <Plus data-icon="inline-start" />
                    新建
                  </Button>
                }
                description="启用内置策略，或创建带自定义指令的研究 Skill。"
                title="Skills"
              >
                {creatingSkill ? (
                  <form className="skill-creation-form" onSubmit={handleCreateSkill}>
                    <FieldGroup>
                      <div className="skill-creation-grid">
                        <Field data-invalid={draftError?.includes("名称") || undefined}>
                          <FieldLabel htmlFor="skill-name">名称</FieldLabel>
                          <Input
                            aria-invalid={draftError?.includes("名称") || undefined}
                            id="skill-name"
                            maxLength={40}
                            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                            placeholder="Competitive scan"
                            value={draft.name}
                          />
                        </Field>
                        <Field>
                          <FieldLabel htmlFor="skill-base">基础模式</FieldLabel>
                          <Select
                            onValueChange={(value) =>
                              setDraft({ ...draft, baseSkill: value as ResearchSkillId })
                            }
                            value={draft.baseSkill}
                          >
                            <SelectTrigger id="skill-base">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent position="popper">
                              <SelectGroup>
                                {BUILTIN_RESEARCH_SKILLS.map((skill) => (
                                  <SelectItem key={skill.id} value={skill.baseSkill}>
                                    {skill.label}
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                        </Field>
                      </div>
                      <Field>
                        <FieldLabel htmlFor="skill-description">说明</FieldLabel>
                        <Input
                          id="skill-description"
                          maxLength={120}
                          onChange={(event) =>
                            setDraft({ ...draft, description: event.target.value })
                          }
                          placeholder="一句话说明适用场景"
                          value={draft.description}
                        />
                      </Field>
                      <Field data-invalid={draftError?.includes("执行指令") || undefined}>
                        <FieldLabel htmlFor="skill-instructions">执行指令</FieldLabel>
                        <Textarea
                          aria-invalid={draftError?.includes("执行指令") || undefined}
                          id="skill-instructions"
                          maxLength={2_000}
                          onChange={(event) =>
                            setDraft({ ...draft, instructions: event.target.value })
                          }
                          placeholder="描述检索范围、来源优先级、比较维度和停止条件。"
                          rows={4}
                          value={draft.instructions}
                        />
                        {draftError ? <FieldError>{draftError}</FieldError> : null}
                      </Field>
                      <div className="skill-creation-actions">
                        <Button
                          onClick={() => {
                            setCreatingSkill(false);
                            setDraftError(undefined);
                          }}
                          size="sm"
                          type="button"
                          variant="ghost"
                        >
                          取消
                        </Button>
                        <Button size="sm" type="submit">
                          创建 Skill
                        </Button>
                      </div>
                    </FieldGroup>
                  </form>
                ) : null}

                <div className="settings-skill-list">
                  {BUILTIN_RESEARCH_SKILLS.map((skill) => (
                    <SkillRow
                      checked={settings.builtinSkills[skill.baseSkill]}
                      description={skill.description}
                      key={skill.id}
                      label={skill.label}
                      onCheckedChange={(checked) => toggleBuiltinSkill(skill.baseSkill, checked)}
                    />
                  ))}
                  {settings.customSkills.map((skill) => (
                    <SkillRow
                      action={
                        <Button
                          aria-label={`删除 ${skill.name}`}
                          onClick={() => deleteCustomSkill(skill.id)}
                          size="icon-sm"
                          variant="ghost"
                        >
                          <Trash2 data-icon="inline-start" />
                        </Button>
                      }
                      checked={skill.enabled}
                      description={skill.description || "自定义研究策略"}
                      key={skill.id}
                      label={skill.name}
                      onCheckedChange={(checked) => toggleCustomSkill(skill.id, checked)}
                    />
                  ))}
                </div>
              </SettingsSection>
            </TabsContent>

            <TabsContent value="sources">
              <SettingsSection description="控制 Web Search 的检索预算与来源选择。" title="来源">
                <FieldGroup>
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldTitle>搜索上下文</FieldTitle>
                      <FieldDescription>覆盖服务端的 Web Search 上下文大小。</FieldDescription>
                    </FieldContent>
                    <Select
                      onValueChange={(value) =>
                        update({
                          searchContext: value as ResearchSettings["searchContext"],
                        })
                      }
                      value={settings.searchContext}
                    >
                      <SelectTrigger aria-label="搜索上下文">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent align="end" position="popper">
                        <SelectGroup>
                          <SelectItem value="server-default">服务端默认</SelectItem>
                          <SelectItem value="low">Low</SelectItem>
                          <SelectItem value="medium">Medium</SelectItem>
                          <SelectItem value="high">High</SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                  <FieldSeparator />
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldTitle>优先主要来源</FieldTitle>
                      <FieldDescription>优先官方文档、原始数据与第一方声明。</FieldDescription>
                    </FieldContent>
                    <Switch
                      aria-label="优先主要来源"
                      checked={settings.requirePrimarySources}
                      onCheckedChange={(checked) => update({ requirePrimarySources: checked })}
                    />
                  </Field>
                </FieldGroup>
              </SettingsSection>
            </TabsContent>

            <TabsContent value="shortcuts">
              <SettingsSection
                description="配置输入框发送方式，并查看当前可用快捷键。"
                title="快捷键"
              >
                <FieldGroup>
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldTitle>发送消息</FieldTitle>
                      <FieldDescription>Shift + Enter 始终插入换行。</FieldDescription>
                    </FieldContent>
                    <Select
                      onValueChange={(value) =>
                        update({
                          sendMode: value as ResearchSettings["sendMode"],
                        })
                      }
                      value={settings.sendMode}
                    >
                      <SelectTrigger aria-label="发送消息快捷键">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent align="end" position="popper">
                        <SelectGroup>
                          <SelectItem value="enter">Enter</SelectItem>
                          <SelectItem value="mod-enter">{modifier} + Enter</SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                  <FieldSeparator />
                  <ul className="shortcut-list">
                    <ShortcutRow keys={[modifier, "K"]} label="打开设置" />
                    <ShortcutRow
                      keys={settings.sendMode === "enter" ? ["Enter"] : [modifier, "Enter"]}
                      label="提交研究问题"
                    />
                    <ShortcutRow keys={["Shift", "Enter"]} label="输入换行" />
                  </ul>
                </FieldGroup>
              </SettingsSection>
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function SettingsSection({
  action,
  children,
  description,
  title,
}: {
  readonly action?: React.ReactNode;
  readonly children: React.ReactNode;
  readonly description: string;
  readonly title: string;
}) {
  return (
    <section className="settings-section">
      <header className="settings-section-heading">
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        {action}
      </header>
      <div className="settings-section-body">{children}</div>
    </section>
  );
}

function SkillRow({
  action,
  checked,
  description,
  label,
  onCheckedChange,
}: {
  readonly action?: React.ReactNode;
  readonly checked: boolean;
  readonly description: string;
  readonly label: string;
  readonly onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="settings-skill-row">
      <span>
        <Sparkles />
      </span>
      <div>
        <strong>{label}</strong>
        <small>{description}</small>
      </div>
      {action}
      <Switch
        aria-label={`${checked ? "停用" : "启用"} ${label}`}
        checked={checked}
        onCheckedChange={onCheckedChange}
      />
    </div>
  );
}

function ShortcutRow({
  keys,
  label,
}: {
  readonly keys: readonly string[];
  readonly label: string;
}) {
  return (
    <li className="shortcut-row">
      <span>{label}</span>
      <KbdGroup>
        {keys.map((key) => (
          <Kbd key={key}>{key}</Kbd>
        ))}
      </KbdGroup>
    </li>
  );
}

function ensureSelectedSkill(settings: ResearchSettings): ResearchSettings {
  const available = availableSkillPresets(settings);
  if (available.some((skill) => skill.id === settings.defaultSkillId)) {
    return settings;
  }
  return {
    ...settings,
    defaultSkillId: selectedSkillPreset(settings).id,
  };
}

function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}
