import { Box, Text, useInput, usePaste } from "ink";
import { useMemo, useState } from "react";
import type {
  ModelPickerOverlay,
  SlashCommandModelSummary,
  SlashCommandResult,
} from "../slash-commands/types.js";

const PAGE_SIZE = 15;
const OTHER_PROVIDER = "other";

export function ModelPicker({
  onCancel,
  onResult,
  overlay,
}: {
  readonly onCancel: () => void;
  readonly onResult: (result: SlashCommandResult) => void;
  readonly overlay: ModelPickerOverlay;
}) {
  const [busy, setBusy] = useState(false);
  const [global, setGlobal] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const models = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const filteredModels = normalizedQuery
      ? overlay.models.filter((model) =>
          [model.key, model.model, model.provider]
            .filter((value): value is string => value !== undefined)
            .some((value) => value.toLowerCase().includes(normalizedQuery)),
        )
      : overlay.models;
    return groupModelsByProvider(filteredModels);
  }, [overlay.models, query]);
  const resolvedSelectedIndex = Math.min(selectedIndex, Math.max(0, models.length - 1));
  const pageStart = Math.floor(resolvedSelectedIndex / PAGE_SIZE) * PAGE_SIZE;
  const pageModels = models.slice(pageStart, pageStart + PAGE_SIZE);

  usePaste((text) => {
    if (!busy) {
      setQuery((current) => current + text);
      setSelectedIndex(0);
    }
  });

  useInput((input, key) => {
    if (busy) {
      return;
    }
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.upArrow) {
      setSelectedIndex(Math.max(0, resolvedSelectedIndex - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex(Math.min(Math.max(0, models.length - 1), resolvedSelectedIndex + 1));
      return;
    }
    if (input.toLowerCase() === "g") {
      setGlobal((current) => !current);
      return;
    }
    if (key.backspace || key.delete) {
      setQuery((current) => current.slice(0, -1));
      setSelectedIndex(0);
      return;
    }
    if (key.return) {
      const model = models[resolvedSelectedIndex];
      if (model === undefined) {
        return;
      }
      setBusy(true);
      void overlay
        .onSelect(model.key, { global })
        .then(onResult)
        .catch((error: unknown) =>
          onResult({
            kind: "error",
            message: error instanceof Error ? error.message : String(error),
            title: "Command Error",
          }),
        )
        .finally(() => setBusy(false));
      return;
    }
    if (!key.ctrl && !key.meta && input) {
      setQuery((current) => current + input);
      setSelectedIndex(0);
    }
  });

  return (
    <Box borderColor="magenta" borderStyle="round" flexDirection="column" paddingX={1}>
      <Text bold color="magenta">
        {overlay.title}
      </Text>
      <Text color="gray">
        Search: {query || "all models"} · scope: {global ? "global default" : "this Session"}
      </Text>
      {pageModels.map((model, index) => {
        const absoluteIndex = pageStart + index;
        const previousModel = pageModels[index - 1];
        const showProvider =
          previousModel === undefined || providerKey(previousModel) !== providerKey(model);
        return (
          <Box flexDirection="column" key={model.key}>
            {showProvider ? (
              <Text bold color="cyan">
                {providerLabel(model)}
              </Text>
            ) : null}
            <Text color={absoluteIndex === resolvedSelectedIndex ? "yellow" : "gray"}>
              {absoluteIndex === resolvedSelectedIndex ? "› " : "  "}
              {model.key} · {model.model}
              {model.key === overlay.currentModel ? " · current" : ""}
            </Text>
          </Box>
        );
      })}
      {models.length === 0 ? <Text color="gray">No models found.</Text> : null}
      <Text color="gray">↑↓ select · Enter apply · g global · Esc cancel</Text>
    </Box>
  );
}

function groupModelsByProvider(
  models: readonly SlashCommandModelSummary[],
): readonly SlashCommandModelSummary[] {
  const providerOrder: string[] = [];
  const groups = new Map<string, SlashCommandModelSummary[]>();

  for (const model of models) {
    const key = providerKey(model);
    const group = groups.get(key);
    if (group === undefined) {
      providerOrder.push(key);
      groups.set(key, [model]);
    } else {
      group.push(model);
    }
  }

  return providerOrder.flatMap((provider) => groups.get(provider) ?? []);
}

function providerKey(model: SlashCommandModelSummary): string {
  return model.provider?.trim().toLowerCase() || OTHER_PROVIDER;
}

function providerLabel(model: SlashCommandModelSummary): string {
  return (model.provider?.trim() || OTHER_PROVIDER).toUpperCase();
}
