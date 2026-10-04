import type { NormalizedUserQuestion } from "@yiku/agent-orchestrator";
import { Box, Text, useInput } from "ink";
import type { ReactNode } from "react";
import { LAYOUT_SPACING } from "./constants.js";
import type {
  UserInteractionController,
  UserInteractionState,
  UserQuestionInteractionState,
} from "./user-interaction.js";
import { isQuestionTextInput, WORKSPACE_ACCESS_OPTIONS } from "./user-interaction.js";

export interface UserInteractionViewProps {
  readonly controller: UserInteractionController;
  readonly state: UserInteractionState;
}

export type CustomAnswerDisplay =
  | {
      readonly cursor: "none";
      readonly text: string;
      readonly tone: "answer" | "placeholder";
    }
  | {
      readonly cursor: "first-character";
      readonly remainder: string;
    }
  | {
      readonly cursor: "after-value";
      readonly text: string;
    };

export function UserInteractionView({ controller, state }: UserInteractionViewProps) {
  useInput((typedInput, key) => {
    if (key.escape) {
      if (controller.exitQuestionCustomInput()) {
        return;
      }
      controller.cancelCurrent();
      return;
    }
    if (key.return) {
      controller.confirm();
      return;
    }
    if (key.tab && state.kind === "question") {
      controller.moveQuestion(key.shift ? -1 : 1);
      return;
    }
    if (key.leftArrow || key.upArrow || key.rightArrow || key.downArrow) {
      if (
        state.kind === "question" &&
        (key.leftArrow || key.rightArrow) &&
        state.form.source === "structured"
      ) {
        controller.moveQuestion(key.rightArrow ? 1 : -1);
        return;
      }
      const selectedIndex =
        state.kind === "question" && state.reviewActive
          ? state.reviewSelectedIndex
          : state.selectedIndex;
      controller.select(selectedIndex + (key.rightArrow || key.downArrow ? 1 : -1));
      return;
    }
    if (state.kind === "question" && !isTextInput(state) && typedInput === " ") {
      controller.toggleQuestionSelection();
      return;
    }
    if (!isTextInput(state)) {
      return;
    }
    if (key.ctrl && typedInput === "u") {
      controller.updateDraft("");
      return;
    }
    if (key.backspace || key.delete) {
      controller.updateDraft(state.draft.slice(0, -1));
      return;
    }
    if (!key.ctrl && !key.meta && typedInput) {
      controller.updateDraft(`${state.draft}${normalizeLineBreaks(typedInput)}`);
    }
  });

  switch (state.kind) {
    case "workspace-access":
      return (
        <InteractionFrame
          color="cyan"
          hint="↑↓/←→ 选择 · Enter 确认 · Esc 退出"
          options={WORKSPACE_ACCESS_OPTIONS.map((option) => option.label)}
          selectedIndex={state.selectedIndex}
          title="授权当前工作区"
        >
          <Text color="white">{state.workspaceDir}</Text>
          <Text color="gray">长期授权期限由 ~/.yiku/permission/global.json 配置。</Text>
        </InteractionFrame>
      );
    case "workspace-write-access":
      return (
        <InteractionFrame
          color="yellow"
          hint="↑↓/←→ 选择 · Enter 确认 · Esc 拒绝"
          options={["升级本次会话为读写", "长期授予读写", "拒绝"]}
          selectedIndex={state.selectedIndex}
          title="编辑需要工作区写权限"
        >
          <Text color="white">{state.request.subject}</Text>
          <Text color="gray">
            动作：{state.request.action} · 工作区：{state.request.workspaceId}
          </Text>
        </InteractionFrame>
      );
    case "permission": {
      const isMcp = state.request.policyId === "mcp-external-side-effect";
      return (
        <InteractionFrame
          color="yellow"
          hint="↑↓/←→ 选择 · Enter 确认 · Esc 拒绝"
          options={["本次会话允许此权限", "长期允许此策略", "拒绝执行"]}
          selectedIndex={state.selectedIndex}
          title={isMcp ? "MCP 工具需要授权" : "Shell 命令需要授权"}
        >
          <Text color="white">
            本次需求：
            {truncateInline(state.request.metadata?.requirement ?? "未提供", 500)}
          </Text>
          <Text color="gray">操作目的：{state.request.normalizedAction}</Text>
          <Box>
            <Text color="gray">{isMcp ? "目标：" : "命令："}</Text>
            <Text bold color={isMcp ? "white" : "yellow"}>
              {state.request.subject}
              {state.request.metadata?.commandTruncated === "true" ? " [已截断]" : ""}
            </Text>
          </Box>
          <Text color="gray">
            风险等级：{state.request.risk} · 策略：{state.request.policyId}
          </Text>
          <Text color="gray">风险原因：{state.request.reason}</Text>
          <Text color="gray">能力：{state.request.capabilities.join(", ")}</Text>
          <Text color="gray">工作区：{state.request.workspaceId}</Text>
        </InteractionFrame>
      );
    }
    case "hook-trust":
      return (
        <InteractionFrame
          color="magenta"
          hint="↑↓/←→ 选择 · Enter 确认 · Esc 拒绝"
          options={["持久信任并执行", "仅本次信任并执行", "拒绝信任"]}
          selectedIndex={state.selectedIndex}
          title="Yiku Hook 需要信任"
        >
          <Text color="white">Hook：{state.request.hookId}</Text>
          <Text color="gray">触发：{state.request.eventName ?? "外部连接初始化"}</Text>
          <Text color="gray">能力：{state.request.capability}</Text>
          <Text color="gray">
            来源：{state.request.source.type}
            {state.request.source.path ? ` (${state.request.source.path})` : ""}
          </Text>
          <Text color="gray">
            执行器：{state.request.executorType} · opaque shell：
            {state.request.opaque ? "是" : "否"}
          </Text>
          <Text color="gray">
            Hash：{state.request.handlerHash.slice(0, 12)} · Trust：
            {state.request.trustKey.slice(0, 18)}
          </Text>
          <Text color="yellow">这是配置自动触发的 Hook，不代表当前 Agent 正在执行上述命令。</Text>
        </InteractionFrame>
      );
    case "mcp-elicitation":
      return (
        <InteractionFrame
          color="cyan"
          error={state.error}
          hint="↑↓/←→ 选择 · 输入 JSON · Enter 确认 · Esc 拒绝"
          options={["提交", "拒绝"]}
          selectedIndex={state.selectedIndex}
          title="MCP 请求用户输入"
        >
          <Text color="white">{state.request.server}</Text>
          <Text color="gray">{state.request.message}</Text>
          {state.request.url ? <Text color="cyan">{state.request.url}</Text> : null}
          {state.request.requestedSchema ? (
            <Text color="gray">
              Schema：{truncateInline(JSON.stringify(state.request.requestedSchema), 1_000)}
            </Text>
          ) : null}
          {state.request.mode === "url" ? null : (
            <Text color="white">响应：{truncateInline(state.draft, 2_000)}</Text>
          )}
        </InteractionFrame>
      );
    case "resume-review": {
      const operation = state.request.operation;
      return (
        <InteractionFrame
          color="yellow"
          hint="↑↓/←→ 选择 · Enter 确认 · Esc 放弃"
          options={["确认已完成", "确认未执行并重试", "放弃该操作"]}
          selectedIndex={state.selectedIndex}
          title="检测到结果未知的副作用"
        >
          <Text color="white">{operation.toolName}</Text>
          <Text color="gray">
            调用：{operation.callId} · 阶段：{operation.stageId} · 类型：{operation.effect}
          </Text>
          <Text color="gray">{operation.inputSummary}</Text>
        </InteractionFrame>
      );
    }
    case "question":
      return <UserQuestionView state={state} />;
  }
}

function UserQuestionView({ state }: { readonly state: UserQuestionInteractionState }) {
  if (state.reviewActive) {
    return <UserQuestionReview state={state} />;
  }

  const question = state.form.questions[state.activeQuestionIndex] as NormalizedUserQuestion;
  const selectedIndexes = state.selectedIndexesByQuestion[
    state.activeQuestionIndex
  ] as readonly number[];
  const customAnswer = state.customAnswersByQuestion[state.activeQuestionIndex];
  const customDraft = state.customDraftsByQuestion[state.activeQuestionIndex];
  const customIndex = question.options.length;

  return (
    <Box flexDirection="column" marginBottom={LAYOUT_SPACING.prompt} width="100%">
      {state.form.description !== undefined || state.form.title !== undefined ? (
        <Box flexDirection="column" marginBottom={1}>
          {state.form.description !== undefined ? (
            <Text bold color="white">
              ● {state.form.description}
            </Text>
          ) : null}
          {state.form.title !== undefined ? (
            <Box marginTop={1}>
              <Text bold color="white">
                ● {state.form.title}
              </Text>
            </Box>
          ) : null}
        </Box>
      ) : null}
      <QuestionNavigation state={state} />
      <Text bold color="white">
        {question.question}
      </Text>
      {question.freeText ? (
        <Box marginTop={1}>
          <Text color="cyan">回答：</Text>
          <Text color="white">{truncateInline(state.draft, 2_000)}</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {question.options.map((option, index) => (
            <QuestionOption
              chosen={selectedIndexes.includes(index)}
              current={state.selectedIndex === index && !state.customInputActive}
              description={option.description}
              index={index}
              key={option.label}
              label={option.label}
              multiSelect={question.multiSelect}
            />
          ))}
          {question.allowCustom ? (
            <CustomAnswerInput
              chosen={Boolean(customAnswer)}
              focused={state.customInputActive}
              index={customIndex}
              value={state.customInputActive ? state.draft : (customDraft ?? customAnswer ?? "")}
            />
          ) : null}
        </Box>
      )}
      {state.error ? <Text color="red">{state.error}</Text> : null}
      <Box marginTop={1}>
        <Text color="gray">{questionHint(state)}</Text>
      </Box>
    </Box>
  );
}

function QuestionNavigation({ state }: { readonly state: UserQuestionInteractionState }) {
  if (state.form.source === "legacy") {
    const question = state.form.questions[0] as NormalizedUserQuestion;
    return (
      <Box marginBottom={1}>
        <Text>
          <Text color="gray">← </Text>
          <Text backgroundColor="cyan" color="black">
            {" "}
            {question.header}{" "}
          </Text>
          <Text color="gray"> →</Text>
        </Text>
      </Box>
    );
  }

  if (state.form.questions.length === 1) {
    const question = state.form.questions[0] as NormalizedUserQuestion;
    return (
      <Box marginBottom={1}>
        <Text backgroundColor="cyan" color="black">
          {" "}
          {question.header}{" "}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexWrap="wrap" marginBottom={1}>
      <Text color="gray">← </Text>
      {state.form.questions.map((question, questionIndex) => {
        const active = !state.reviewActive && state.activeQuestionIndex === questionIndex;
        const answered = hasVisibleAnswer(state, questionIndex);
        return (
          <Box key={`${question.header}:${question.question}`} marginRight={1}>
            <Text
              color={active ? "black" : answered ? "green" : "white"}
              {...(active ? { backgroundColor: "cyan" as const } : {})}
            >
              {" "}
              {answered ? "✓" : "□"} {question.header}{" "}
            </Text>
          </Box>
        );
      })}
      <Box marginRight={1}>
        <Text
          color={state.reviewActive ? "black" : "white"}
          {...(state.reviewActive ? { backgroundColor: "cyan" as const } : {})}
        >
          {" "}
          ✓ Submit{" "}
        </Text>
      </Box>
      <Text color="gray">→</Text>
    </Box>
  );
}

function UserQuestionReview({ state }: { readonly state: UserQuestionInteractionState }) {
  const unanswered = state.form.questions.some(
    (_, questionIndex) => !hasVisibleAnswer(state, questionIndex),
  );

  return (
    <Box flexDirection="column" marginBottom={LAYOUT_SPACING.prompt} width="100%">
      <QuestionNavigation state={state} />
      <Text bold color="white">
        Review your answers
      </Text>
      {unanswered ? (
        <Box marginTop={1}>
          <Text bold color="yellow">
            ⚠ You have not answered all questions
          </Text>
        </Box>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        {state.form.questions.map((question, questionIndex) => (
          <Text key={`${question.header}:${question.question}`} color="gray">
            {question.header}:{" "}
            <Text color={hasVisibleAnswer(state, questionIndex) ? "white" : "yellow"}>
              {visibleAnswers(state, questionIndex).join(", ") || "Not answered"}
            </Text>
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color="white">Ready to submit your answers?</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {["Submit answers", "Cancel"].map((option, optionIndex) => (
          <Text color={state.reviewSelectedIndex === optionIndex ? "cyan" : "white"} key={option}>
            {state.reviewSelectedIndex === optionIndex ? "›" : " "} {optionIndex + 1}. {option}
          </Text>
        ))}
      </Box>
      {state.error ? <Text color="red">{state.error}</Text> : null}
      <Box marginTop={1}>
        <Text color="gray">Enter to select · Tab/Arrow keys to navigate · Esc to cancel</Text>
      </Box>
    </Box>
  );
}

function hasVisibleAnswer(state: UserQuestionInteractionState, questionIndex: number): boolean {
  return visibleAnswers(state, questionIndex).length > 0;
}

function visibleAnswers(state: UserQuestionInteractionState, questionIndex: number): string[] {
  const question = state.form.questions[questionIndex] as NormalizedUserQuestion;
  const selectedIndexes = state.selectedIndexesByQuestion[questionIndex] as readonly number[];
  const answers = selectedIndexes.map(
    (selectedIndex) => question.options[selectedIndex]?.label ?? "",
  );
  const customAnswer = state.customAnswersByQuestion[questionIndex];
  return [...answers.filter(Boolean), ...(customAnswer ? [customAnswer] : [])];
}

function QuestionOption({
  chosen,
  current,
  description,
  index,
  label,
  multiSelect,
}: {
  readonly chosen: boolean;
  readonly current: boolean;
  readonly description: string;
  readonly index: number;
  readonly label: string;
  readonly multiSelect: boolean;
}) {
  return (
    <Box flexDirection="column">
      <Text color={current ? "cyan" : chosen ? "green" : "white"}>
        {current ? "›" : " "} {index + 1}. {multiSelect ? (chosen ? "[x] " : "[ ] ") : ""}
        {label}
      </Text>
      {description ? (
        <Text color="gray">
          {"     "}
          {description}
        </Text>
      ) : null}
    </Box>
  );
}

function CustomAnswerInput({
  chosen,
  focused,
  index,
  value,
}: {
  readonly chosen: boolean;
  readonly focused: boolean;
  readonly index: number;
  readonly value: string;
}) {
  const display = customAnswerDisplay(focused, value);
  const color = focused ? "white" : chosen ? "green" : "gray";

  return (
    <Box>
      <Text color={focused ? "cyan" : "white"}>
        {focused ? "›" : " "} {index + 1}.{" "}
      </Text>
      {display.cursor === "first-character" ? (
        <>
          <Text backgroundColor="gray" color="white">
            T
          </Text>
          <Text color="gray">{display.remainder}</Text>
        </>
      ) : display.cursor === "after-value" ? (
        <>
          <Text color={color}>{display.text}</Text>
          <Text backgroundColor="gray"> </Text>
        </>
      ) : (
        <Text color={display.tone === "placeholder" ? "gray" : color}>{display.text}</Text>
      )}
    </Box>
  );
}

export function customAnswerDisplay(focused: boolean, value: string): CustomAnswerDisplay {
  if (!focused) {
    return {
      cursor: "none",
      text: value.length === 0 ? "Type something." : truncateInline(value, 2_000),
      tone: value.length === 0 ? "placeholder" : "answer",
    };
  }
  if (value.length === 0) {
    return {
      cursor: "first-character",
      remainder: "ype something.",
    };
  }
  return {
    cursor: "after-value",
    text: truncateInline(value, 2_000),
  };
}

function questionHint(state: UserQuestionInteractionState): string {
  const question = state.form.questions[state.activeQuestionIndex] as NormalizedUserQuestion;
  if (question.freeText) {
    return "Type your answer · Enter to select · Ctrl+U to clear · Esc to cancel";
  }
  if (state.customInputActive) {
    return "Type your answer · ↑↓ to select · ←→/Tab to change question · Enter to select · Esc to go back";
  }
  const navigation = question.multiSelect ? "Space to toggle · " : "";
  const questionNavigation =
    state.form.source === "structured" && state.form.questions.length > 1
      ? "←→/Tab to change question · "
      : "";
  return `↑↓ to select · ${questionNavigation}${navigation}Enter to select · Esc to cancel`;
}

function InteractionFrame({
  children,
  color,
  error,
  hint,
  options,
  selectedIndex,
  title,
}: {
  readonly children: ReactNode;
  readonly color: "cyan" | "magenta" | "yellow";
  readonly error?: string | undefined;
  readonly hint: string;
  readonly options: readonly string[];
  readonly selectedIndex: number;
  readonly title: string;
}) {
  return (
    <Box
      borderColor={color}
      borderStyle="round"
      flexDirection="column"
      marginBottom={LAYOUT_SPACING.prompt}
      paddingX={1}
      width="100%"
    >
      <Text bold color={color}>
        {title}
      </Text>
      {children}
      {error ? <Text color="red">{error}</Text> : null}
      <Box flexDirection="column" marginTop={1}>
        {options.map((option, index) => (
          <Box key={option}>
            <Text color={selectedIndex === index ? color : "gray"}>
              {selectedIndex === index ? "●" : "○"} {option}
            </Text>
          </Box>
        ))}
      </Box>
      <Text color="gray">{hint}</Text>
    </Box>
  );
}

function isTextInput(
  state: UserInteractionState,
): state is Extract<UserInteractionState, { readonly draft: string }> {
  return (
    (state.kind === "mcp-elicitation" && state.request.mode !== "url") ||
    (state.kind === "question" && isQuestionTextInput(state))
  );
}

function normalizeLineBreaks(value: string): string {
  return value.replace(/\r\n?/gu, "\n");
}

function truncateInline(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}...`;
}
