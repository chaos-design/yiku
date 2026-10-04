import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUNTIME_BUDGET_CONFIG,
  resolveRuntimeConfig,
} from "../../src/config/runtime-config.js";

describe("resolveRuntimeConfig", () => {
  it("merges user and project config by structured section", () => {
    const resolved = resolveRuntimeConfig({
      projectConfig: {
        agents: {
          items: {
            code: {
              delegates: ["researcher"],
              skills: ["code", "tasks", "github"],
            },
            researcher: {
              model: "fast",
              skills: ["code"],
            },
          },
        },
        mcp: {
          servers: {
            github: {
              args: ["@modelcontextprotocol/server-github"],
              command: "npx",
              tools: ["search_*", "get_*"],
              transport: "stdio",
            },
          },
        },
        runtime: {
          maxTurnsPerStage: 80,
        },
        skills: {
          items: {
            github: {
              instructions: ".yiku/skills/github/SKILL.md",
              mcp: ["github/*"],
            },
          },
        },
      },
      userConfig: {
        agents: {
          default: "code",
          items: {
            code: {
              model: "default",
              name: "Code",
            },
          },
        },
        models: {
          default: "default",
          items: {
            default: { name: "gpt-default" },
            fast: { name: "gpt-fast" },
          },
        },
        runtime: {
          maxParallelReaders: 2,
          maxTurnsPerStage: 60,
        },
        memory: {
          enabled: true,
          extraction: false,
          failureMode: "strict",
        },
      },
    });

    expect(resolved.modelsConfig).toMatchObject({
      agents: {
        default: "code",
        items: {
          code: {
            delegates: ["researcher"],
            model: "default",
            name: "Code",
            skills: ["code", "tasks", "github"],
          },
          researcher: {
            model: "fast",
            skills: ["code"],
          },
        },
      },
      models: {
        default: "default",
        items: {
          default: { name: "gpt-default" },
          fast: { name: "gpt-fast" },
        },
      },
    });
    expect(resolved.budget).toEqual({
      ...DEFAULT_RUNTIME_BUDGET_CONFIG,
      maxParallelReaders: 2,
      maxTurnsPerStage: 80,
    });
    expect(resolved.skills.github).toEqual({
      instructions: ".yiku/skills/github/SKILL.md",
      mcp: ["github/*"],
      name: "github",
    });
    expect(resolved.mcpServers.github).toMatchObject({
      command: "npx",
      name: "github",
      transport: "stdio",
    });
    expect(resolved.memory).toEqual({
      enabled: true,
      extraction: false,
      failureMode: "strict",
    });
    expect(resolved.flow).toEqual({
      trace: false,
    });
    expect(resolved.evals).toMatchObject({
      enabled: true,
      mode: "enforce",
    });
  });

  it("applies restricted runtime overrides after config", () => {
    const resolved = resolveRuntimeConfig({
      overrides: {
        autoContinue: false,
        maxStagesPerEpoch: 4,
      },
      userConfig: {
        runtime: {
          autoContinue: true,
          maxStagesPerEpoch: 8,
        },
      },
    });

    expect(resolved.budget.autoContinue).toBe(false);
    expect(resolved.budget.maxStagesPerEpoch).toBe(4);
  });

  it("validates runtime bounds and unknown fields with paths", () => {
    expect(() =>
      resolveRuntimeConfig({
        userConfig: {
          runtime: {
            maxTurnsPerStage: 0,
          },
        },
      }),
    ).toThrow("runtime.maxTurnsPerStage must be a positive integer");

    expect(() =>
      resolveRuntimeConfig({
        userConfig: {
          runtime: {
            compactAtContextRatio: 1,
          },
        },
      }),
    ).toThrow("runtime.compactAtContextRatio must be between 0 and 1");

    expect(() =>
      resolveRuntimeConfig({
        userConfig: {
          runtime: {
            unexpected: true,
          },
        },
      }),
    ).toThrow("Unknown configuration field: runtime.unexpected");
  });

  it("rejects MCP URLs that embed credentials or query secrets", () => {
    for (const url of [
      "https://user:secret@mcp.example.test/",
      "https://mcp.example.test/?token=secret",
    ]) {
      expect(() =>
        resolveRuntimeConfig({
          userConfig: {
            mcp: {
              servers: {
                remote: {
                  transport: "streamable-http",
                  url,
                },
              },
            },
          },
        }),
      ).toThrow("must not contain credentials, query parameters, or fragments");
    }
  });

  it("validates Skill, MCP, and Delegate references", () => {
    expect(() =>
      resolveRuntimeConfig({
        userConfig: {
          agents: {
            items: {
              code: {
                skills: ["agents", "code", "skills", "tasks"],
              },
            },
          },
        },
      }),
    ).not.toThrow();

    expect(() =>
      resolveRuntimeConfig({
        userConfig: {
          agents: {
            items: {
              code: {
                skills: ["missing"],
              },
            },
          },
        },
      }),
    ).toThrow("Unknown skill in agents.items.code.skills: missing");

    expect(() =>
      resolveRuntimeConfig({
        userConfig: {
          agents: {
            items: {
              code: {
                delegates: ["missing"],
              },
            },
          },
        },
      }),
    ).toThrow("Unknown delegate in agents.items.code.delegates: missing");

    expect(() =>
      resolveRuntimeConfig({
        userConfig: {
          skills: {
            items: {
              github: {
                mcp: ["missing/*"],
              },
            },
          },
        },
      }),
    ).toThrow("Unknown MCP server in skills.items.github.mcp: missing");
  });

  it("enforces managed capability denies after all config sources", () => {
    expect(() =>
      resolveRuntimeConfig({
        managedDeniedCapabilities: ["skill:github"],
        projectConfig: {
          agents: {
            items: {
              code: {
                skills: ["github"],
              },
            },
          },
          skills: {
            items: {
              github: {
                instructions: ".yiku/skills/github/SKILL.md",
              },
            },
          },
        },
      }),
    ).toThrow("Capability is denied by managed policy: skill:github");
  });

  it("returns deeply frozen JSON configuration", () => {
    const resolved = resolveRuntimeConfig({
      userConfig: {
        runtime: {
          maxTurnsPerStage: 40,
        },
      },
    });

    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.budget)).toBe(true);
    expect(Object.isFrozen(resolved.flow)).toBe(true);
    expect(Object.isFrozen(resolved.evals)).toBe(true);
    expect(Object.isFrozen(resolved.modelsConfig)).toBe(true);
    expect(Object.isFrozen(resolved.skills)).toBe(true);
    expect(Object.isFrozen(resolved.mcpServers)).toBe(true);
    expect(Object.isFrozen(resolved.memory)).toBe(true);
  });

  it("defaults Memory on and validates its fields", () => {
    expect(resolveRuntimeConfig().memory).toEqual({
      enabled: true,
      extraction: true,
      failureMode: "best-effort",
    });
    expect(() =>
      resolveRuntimeConfig({
        userConfig: {
          memory: {
            failureMode: "ignore",
          },
        },
      }),
    ).toThrow("memory.failureMode must be best-effort or strict");
  });

  it("defaults Flow Trace off and validates project overrides", () => {
    expect(resolveRuntimeConfig().flow).toEqual({
      trace: false,
    });
    expect(
      resolveRuntimeConfig({
        projectConfig: {
          flow: {
            trace: false,
          },
        },
        userConfig: {
          flow: {
            trace: true,
          },
        },
      }).flow,
    ).toEqual({
      trace: false,
    });
    expect(() =>
      resolveRuntimeConfig({
        userConfig: {
          flow: {
            trace: "yes",
          },
        },
      }),
    ).toThrow("flow.trace must be a boolean");
    expect(() =>
      resolveRuntimeConfig({
        userConfig: {
          flow: {
            unexpected: true,
          },
        },
      }),
    ).toThrow("Unknown configuration field: flow.unexpected");
  });

  it("validates remaining Memory, MCP, and runtime value shapes", () => {
    expect(() =>
      resolveRuntimeConfig({
        userConfig: {
          memory: { enabled: "yes" },
        },
      }),
    ).toThrow("memory.enabled must be a boolean");
    expect(() =>
      resolveRuntimeConfig({
        userConfig: {
          memory: { extraction: 1 },
        },
      }),
    ).toThrow("memory.extraction must be a boolean");
    expect(() =>
      resolveRuntimeConfig({
        userConfig: {
          memory: { unknown: true },
        },
      }),
    ).toThrow("Unknown configuration field: memory.unknown");
    expect(() =>
      resolveRuntimeConfig({
        userConfig: {
          runtime: {
            compactAtContextRatio: 0.5,
            compactToContextRatio: 0.5,
          },
        },
      }),
    ).toThrow("must be less than");
    expect(() =>
      resolveRuntimeConfig({
        userConfig: {
          runtime: {
            maxStagesPerEpoch: 1_001,
          },
        },
      }),
    ).toThrow("must not exceed");
    expect(() =>
      resolveRuntimeConfig({
        userConfig: {
          mcp: {
            servers: {
              bad: {
                transport: "socket",
              },
            },
          },
        },
      }),
    ).toThrow('must be "stdio" or "streamable-http"');
    expect(() =>
      resolveRuntimeConfig({
        userConfig: {
          mcp: {
            servers: {
              bad: {
                transport: "streamable-http",
                url: "not a URL",
              },
            },
          },
        },
      }),
    ).toThrow("valid HTTPS URL");
    expect(() =>
      resolveRuntimeConfig({
        userConfig: {
          mcp: {
            servers: {
              bad: {
                transport: "streamable-http",
                url: "http://mcp.example.test",
              },
            },
          },
        },
      }),
    ).toThrow("valid HTTPS URL");
    expect(() =>
      resolveRuntimeConfig({
        userConfig: {
          mcp: {
            servers: {
              bad: {
                args: "not-an-array",
                command: "server",
                transport: "stdio",
              },
            },
          },
        },
      }),
    ).toThrow("must be an array of strings");

    const resolved = resolveRuntimeConfig({
      userConfig: {
        mcp: {
          servers: {
            local: {
              args: ["server.js", "server.js"],
              command: "node",
              cwd: "/workspace",
              env: ["TOKEN"],
              transport: "stdio",
            },
            remote: {
              allowedEnvVars: ["TOKEN"],
              headers: {
                Authorization: "Bearer token",
              },
              transport: "streamable-http",
              url: "https://mcp.example.test/api",
            },
          },
        },
      },
    });
    expect(resolved.mcpServers.local).toMatchObject({
      args: ["server.js"],
      cwd: "/workspace",
      env: ["TOKEN"],
      tools: ["*"],
    });
    expect(resolved.mcpServers.remote).toMatchObject({
      allowedEnvVars: ["TOKEN"],
      headers: { Authorization: "Bearer token" },
      tools: ["*"],
    });
  });
});
