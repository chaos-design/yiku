import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAutomationAnswers } from "../../src/automation/answer-file.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("loadAutomationAnswers", () => {
  it("loads stable option and text answers while tracking unused keys", async () => {
    const filePath = await answersFile({
      answers: {
        "cli.output.format@1": { optionId: "json" },
        "code.checks.enabled@1": { optionIds: ["test", "lint"] },
        "code.release.note@1": { value: "Use the approved release text." },
      },
      manifests: [
        manifest("cli.output.format@1", ["json", "text"]),
        manifest("code.checks.enabled@1", ["test", "lint"], true),
        {
          ...manifest("code.release.note@1", ["approved", "custom"]),
          preconfiguredAnswer: true,
          risk: "required-input",
        },
      ],
      schemaVersion: 1,
    });

    const answers = await loadAutomationAnswers(filePath);

    expect(answers.consume("cli.output.format@1")).toEqual({ optionId: "json" });
    expect(answers.consume("code.checks.enabled@1")).toEqual({
      optionIds: ["test", "lint"],
    });
    expect(answers.unusedQuestionKeys()).toEqual(["code.release.note@1"]);
  });

  it("rejects invalid schemas, unknown fields, and duplicate question keys", async () => {
    await expect(
      loadAutomationAnswers(await answersFile({ manifests: [], schemaVersion: 2 })),
    ).rejects.toThrow("schemaVersion must be 1");
    await expect(
      loadAutomationAnswers(
        await answersFile({
          answers: { "cli.output.format@1": { optionId: "json", unexpected: true } },
          manifests: [manifest("cli.output.format@1", ["json", "text"])],
          schemaVersion: 1,
        }),
      ),
    ).rejects.toThrow("unknown field");

    const duplicatePath = await rawAnswersFile(
      `{"schemaVersion":1,"manifests":[${JSON.stringify(manifest("cli.output.format@1", ["json", "text"]))}],"answers":{"cli.output.format@1":{"optionId":"json"},"cli.output.format@1":{"optionId":"text"}}}`,
    );
    await expect(loadAutomationAnswers(duplicatePath)).rejects.toThrow("duplicate key");
  });

  it("rejects unstable keys and invalid answer variants", async () => {
    await expect(
      loadAutomationAnswers(
        await answersFile({
          answers: { INVALID: { optionId: "json" } },
          manifests: [],
          schemaVersion: 1,
        }),
      ),
    ).rejects.toThrow("Invalid answer question key");
    await expect(
      loadAutomationAnswers(
        await answersFile({
          answers: {
            "cli.output.format@1": { optionId: "json", optionIds: ["text"] },
          },
          manifests: [manifest("cli.output.format@1", ["json", "text"])],
          schemaVersion: 1,
        }),
      ),
    ).rejects.toThrow("exactly one");
  });

  it("rejects symbolic links and writable answer files", async () => {
    const target = await answersFile({ answers: {}, manifests: [], schemaVersion: 1 });
    const link = join(dirname(target), "answers-link.json");
    await symlink(target, link);
    await expect(loadAutomationAnswers(link)).rejects.toThrow("not trusted");

    await chmod(target, 0o622);
    await expect(loadAutomationAnswers(target)).rejects.toThrow("not trusted");
  });

  it("rejects malformed manifests and answer values", async () => {
    const key = "cli.output.format@1";
    const validManifest = manifest(key, ["json", "text"]);
    const cases: ReadonlyArray<readonly [unknown, string]> = [
      [{ answers: {}, manifests: {}, schemaVersion: 1 }, "manifests must be an array"],
      [
        {
          answers: {},
          manifests: [validManifest, validManifest],
          schemaVersion: 1,
        },
        "duplicate manifest",
      ],
      [
        {
          answers: {},
          manifests: [{ ...validManifest, questionKey: "INVALID" }],
          schemaVersion: 1,
        },
        "stable versioned question key",
      ],
      [
        {
          answers: {},
          manifests: [{ ...validManifest, optionIds: ["json"] }],
          schemaVersion: 1,
        },
        "at least two option IDs",
      ],
      [
        {
          answers: {},
          manifests: [{ ...validManifest, optionIds: ["json", "json"] }],
          schemaVersion: 1,
        },
        "unique option IDs",
      ],
      [
        {
          answers: {},
          manifests: [{ ...validManifest, risk: "secret" }],
          schemaVersion: 1,
        },
        "risk must be preference or required-input",
      ],
      [
        {
          answers: {},
          manifests: [{ ...validManifest, multiSelect: "false" }],
          schemaVersion: 1,
        },
        "multiSelect must be a boolean",
      ],
      [
        {
          answers: {},
          manifests: [{ ...validManifest, recommendedOptionId: "xml" }],
          schemaVersion: 1,
        },
        "must be declared in optionIds",
      ],
      [
        {
          answers: {},
          manifests: [{ ...validManifest, allowAutoRecommended: true }],
          schemaVersion: 1,
        },
        "automatic recommendation requires",
      ],
      [
        {
          answers: { [key]: { optionId: "json" } },
          manifests: [],
          schemaVersion: 1,
        },
        "no trusted manifest",
      ],
      [
        {
          answers: { [key]: null },
          manifests: [validManifest],
          schemaVersion: 1,
        },
        "must be an object",
      ],
      [
        {
          answers: { [key]: { optionIds: [] } },
          manifests: [validManifest],
          schemaVersion: 1,
        },
        "non-empty array",
      ],
      [
        {
          answers: { [key]: { optionIds: ["json", "json"] } },
          manifests: [{ ...validManifest, multiSelect: true }],
          schemaVersion: 1,
        },
        "must be unique",
      ],
      [
        {
          answers: { [key]: { optionId: "INVALID" } },
          manifests: [validManifest],
          schemaVersion: 1,
        },
        "stable lowercase ASCII option ID",
      ],
      [
        {
          answers: { [key]: { value: " " } },
          manifests: [{ ...validManifest, preconfiguredAnswer: true }],
          schemaVersion: 1,
        },
        "non-empty string",
      ],
      [
        {
          answers: { [key]: { value: "x".repeat(10_001) } },
          manifests: [{ ...validManifest, preconfiguredAnswer: true }],
          schemaVersion: 1,
        },
        "exceeds 10000",
      ],
      [
        {
          answers: { [key]: { optionId: "json" } },
          manifests: [{ ...validManifest, risk: "required-input" }],
          schemaVersion: 1,
        },
        "does not permit a preconfigured answer",
      ],
      [
        {
          answers: { [key]: { value: "custom" } },
          manifests: [validManifest],
          schemaVersion: 1,
        },
        "does not permit a text answer",
      ],
      [
        {
          answers: { [key]: { optionIds: ["json", "text"] } },
          manifests: [validManifest],
          schemaVersion: 1,
        },
        "requires exactly one option",
      ],
      [
        {
          answers: { [key]: { optionId: "xml" } },
          manifests: [validManifest],
          schemaVersion: 1,
        },
        "outside its manifest",
      ],
      [{ answers: {}, manifests: [], schemaVersion: 1, unknown: true }, "unknown field"],
      [[], "Answers file must be an object"],
    ];

    for (const [document, message] of cases) {
      await expect(loadAutomationAnswers(await answersFile(document))).rejects.toThrow(message);
    }

    await expect(loadAutomationAnswers(await rawAnswersFile("{"))).rejects.toThrow(
      "Unable to parse answers file",
    );

    const recommended = await loadAutomationAnswers(
      await answersFile({
        answers: {},
        manifests: [
          {
            ...validManifest,
            allowAutoRecommended: true,
            recommendedOptionId: "json",
          },
        ],
        schemaVersion: 1,
      }),
    );
    expect(recommended.manifest(key)).toMatchObject({
      allowAutoRecommended: true,
      recommendedOptionId: "json",
    });
  });

  it("rejects oversized files and empty answer keys", async () => {
    await expect(
      loadAutomationAnswers(await rawAnswersFile(" ".repeat(1024 * 1024 + 1))),
    ).rejects.toThrow("exceeds");
    await expect(
      loadAutomationAnswers(
        await answersFile({
          answers: { "": { optionId: "json" } },
          manifests: [],
          schemaVersion: 1,
        }),
      ),
    ).rejects.toThrow("(empty)");
  });
});

async function answersFile(value: unknown): Promise<string> {
  return rawAnswersFile(`${JSON.stringify(value)}\n`);
}

async function rawAnswersFile(value: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "yiku-answers-"));
  directories.push(directory);
  const filePath = join(directory, "answers.json");
  await writeFile(filePath, value, { encoding: "utf8", mode: 0o600 });
  return filePath;
}

function manifest(questionKey: string, optionIds: readonly string[], multiSelect = false) {
  return {
    allowAutoRecommended: false,
    multiSelect,
    optionIds,
    preconfiguredAnswer: false,
    questionKey,
    risk: "preference",
  };
}
