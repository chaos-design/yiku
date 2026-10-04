import { describe, expect, it } from "vitest";
import { helpText, parseArgs } from "../src/args.js";

describe("parseArgs", () => {
  it("joins positional arguments into a prompt", () => {
    expect(parseArgs(["hello", "world"])).toEqual({
      help: false,
      prompt: "hello world",
    });
  });

  it("parses agent keys", () => {
    expect(parseArgs(["--agent", "code", "hello"])).toEqual({
      agentKey: "code",
      help: false,
      prompt: "hello",
    });
    expect(parseArgs(["--agent=triage", "hello"])).toEqual({
      agentKey: "triage",
      help: false,
      prompt: "hello",
    });
  });

  it("rejects incomplete and unknown options while supporting a prompt terminator", () => {
    expect(() => parseArgs(["--agent", ""])).toThrow("--agent requires an Agent key");
    expect(() => parseArgs(["--agent=", "hello"])).toThrow("--agent requires an Agent key");
    expect(() => parseArgs(["--unknown"])).toThrow("Unknown yiku option");
    expect(parseArgs(["--", "--literal", "prompt"])).toEqual({
      help: false,
      prompt: "--literal prompt",
    });
    expect(parseArgs([undefined, "hello"] as unknown as readonly string[])).toEqual({
      help: false,
      prompt: "hello",
    });
    expect(parseArgs(["--agent", "triage", "--help"])).toEqual({
      agentKey: "triage",
      help: true,
      prompt: "",
    });
  });

  it("recognizes help flags", () => {
    expect(parseArgs(["--help"])).toEqual({
      help: true,
      prompt: "",
    });
    expect(parseArgs(["-h"])).toEqual({
      help: true,
      prompt: "",
    });
  });

  it("parses setup modes without leaking flags into the prompt", () => {
    expect(parseArgs(["--init", "review"])).toEqual({
      help: false,
      initOnly: false,
      prompt: "review",
      setupMode: "init",
    });
    expect(parseArgs(["--init-only"])).toEqual({
      help: false,
      initOnly: true,
      prompt: "",
      setupMode: "init",
    });
    expect(parseArgs(["--maintenance", "repair"])).toEqual({
      help: false,
      initOnly: false,
      prompt: "repair",
      setupMode: "maintenance",
    });
    expect(() => parseArgs(["--init", "--maintenance"])).toThrow("cannot be used together");
  });

  it("parses structured output formats", () => {
    expect(parseArgs(["--output", "json", "review"])).toMatchObject({
      outputFormat: "json",
      prompt: "review",
    });
    expect(parseArgs(["--output-format=ndjson", "review"])).toMatchObject({
      outputFormat: "ndjson",
      prompt: "review",
    });
    expect(() => parseArgs(["--output", "xml"])).toThrow("must be text, json, or ndjson");
    expect(() => parseArgs(["--output=json", "--output-format=text", "review"])).toThrow(
      "--output may only be provided once",
    );
  });

  it("parses non-interactive answers and Managed Policy files", () => {
    expect(
      parseArgs(["--answers", "/secure/answers.json", "--policy=/secure/policy.json", "review"]),
    ).toMatchObject({
      answersFilePath: "/secure/answers.json",
      policyFilePath: "/secure/policy.json",
      prompt: "review",
    });
    expect(() => parseArgs(["--answers"])).toThrow("--answers requires a file path");
    expect(() => parseArgs(["--policy="])).toThrow("--policy requires a file path");
    expect(() => parseArgs(["--answers=a.json", "--answers=b.json"])).toThrow(
      "--answers may only be provided once",
    );
  });

  it("parses explicit and latest-session resume modes", () => {
    expect(parseArgs(["--resume", "session-1", "continue safely"])).toEqual({
      help: false,
      prompt: "continue safely",
      resumeSessionId: "session-1",
    });
    expect(parseArgs(["--resume=session-2"])).toEqual({
      help: false,
      prompt: "",
      resumeSessionId: "session-2",
    });
    expect(parseArgs(["--continue"])).toEqual({
      continueSession: true,
      help: false,
      prompt: "",
    });
  });

  it("rejects conflicting or incomplete resume flags", () => {
    expect(() => parseArgs(["--resume"])).toThrow("--resume requires a Session ID");
    expect(() => parseArgs(["--resume", "session-1", "--continue"])).toThrow(
      "--resume and --continue cannot be used together",
    );
  });

  it("returns an empty prompt when no arguments are provided", () => {
    expect(parseArgs([])).toEqual({
      help: false,
      prompt: "",
    });
  });

  it("parses the Web observer command and validates its port", () => {
    expect(parseArgs(["web"])).toEqual({
      command: "web",
      help: false,
      port: 4317,
      prompt: "",
    });
    expect(parseArgs(["web", "--port", "3333"])).toEqual({
      command: "web",
      help: false,
      port: 3333,
      prompt: "",
    });
    expect(parseArgs(["web", "--port=4321"])).toMatchObject({
      command: "web",
      port: 4321,
    });
    expect(parseArgs(["web", "--stop"])).toEqual({
      command: "web",
      help: false,
      port: 4317,
      prompt: "",
      webStop: true,
    });
    expect(() => parseArgs(["web", "--port", "0"])).toThrow("between 1 and 65535");
    expect(() => parseArgs(["web", "--port=abc"])).toThrow("between 1 and 65535");
    expect(() => parseArgs(["web", "--stop", "--port", "3333"])).toThrow(
      "--stop cannot be used with --port",
    );
    expect(() => parseArgs(["web", "--unknown"])).toThrow("Unknown yiku web option");
  });
});

describe("helpText", () => {
  it("documents required environment variables", () => {
    expect(helpText).toContain("AI_API_KEY");
    expect(helpText).toContain("AI_BASE_URL");
    expect(helpText).toContain("OPENAI_API_KEY");
    expect(helpText).toContain("AI_MODEL");
    expect(helpText).toContain("AI_MODEL_NAME");
    expect(helpText).toContain("YIKU_AGENT");
    expect(helpText).toContain("--agent");
    expect(helpText).toContain("--answers");
    expect(helpText).toContain("--init-only");
    expect(helpText).toContain("--maintenance");
    expect(helpText).toContain("--output <format>");
    expect(helpText).toContain("--output-format");
    expect(helpText).toContain("--policy");
    expect(helpText).toContain("--resume");
    expect(helpText).toContain("--continue");
    expect(helpText).toContain("yiku web");
    expect(helpText).toContain("--port");
    expect(helpText).toContain("--stop");
  });
});
