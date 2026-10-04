import { setTraceProcessors, setTracingDisabled } from "@openai/agents";

let tracingConfigured = false;

export function disableOpenAISdkTracing(): void {
  if (tracingConfigured) {
    return;
  }

  setTracingDisabled(true);
  setTraceProcessors([]);
  tracingConfigured = true;
}
