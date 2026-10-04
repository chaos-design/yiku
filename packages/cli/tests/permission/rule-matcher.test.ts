import { describe, expect, it } from "vitest";
import { createDefaultPermissionProfileDocument } from "../../src/permission/profile-schema.js";
import { PermissionRuleMatcher } from "../../src/permission/rule-matcher.js";

describe("PermissionRuleMatcher", () => {
  it("matches policy IDs and defaults to ask", () => {
    const matcher = new PermissionRuleMatcher(createDefaultPermissionProfileDocument());

    expect(matcher.policy("known-low-risk-command")).toBe("allow");
    expect(matcher.policy("workspace-file-write")).toBe("allow");
    expect(matcher.policy("workspace-delete")).toBe("ask");
  });

  it("matches normalized command and MCP wildcard rules with deny precedence", () => {
    const document = createDefaultPermissionProfileDocument();
    const profile = document.profiles.default;
    if (profile === undefined) {
      throw new Error("Expected default permission profile.");
    }
    const matcher = new PermissionRuleMatcher({
      ...document,
      profiles: {
        default: {
          ...profile,
          approval: {
            ...profile.approval,
            commandRules: {
              "": "allow",
              "* status": "allow",
              "cat *": "ask",
              pwd: "allow",
              "start*end": "allow",
              "git *": "allow",
              "git push *": "deny",
            },
            mcpRules: {
              "github/*": "allow",
              "github/delete_*": "deny",
            },
          },
        },
      },
    });

    expect(matcher.command("  git   status ")).toBe("allow");
    expect(matcher.command("pwd")).toBe("allow");
    expect(matcher.command("working tree status")).toBe("allow");
    expect(matcher.command("start-middle")).toBe("ask");
    expect(matcher.command("unmatched")).toBe("ask");
    expect(matcher.command("git push origin main")).toBe("deny");
    expect(matcher.command("rm -rf tmp")).toBe("ask");
    expect(matcher.mcp("github/search_repositories")).toBe("allow");
    expect(matcher.mcp("github/delete_repository")).toBe("deny");
    expect(
      matcher.resolve(
        {
          policyId: "known-low-risk-command",
          subject: "cat README.md",
          toolName: "bashTool",
        },
        "allow",
      ),
    ).toBe("ask");
    expect(
      matcher.resolve(
        {
          policyId: "known-low-risk-command",
          subject: "git push origin main",
          toolName: "bashTool",
        },
        "allow",
      ),
    ).toBe("deny");
    expect(
      matcher.resolve(
        {
          policyId: "unconfigured",
          subject: "custom",
          toolName: "bashTool",
        },
        "allow",
      ),
    ).toBe("allow");
  });

  it("uses the profile network default for network.connect capabilities", () => {
    const document = createDefaultPermissionProfileDocument();
    const profile = document.profiles.default;
    if (profile === undefined) {
      throw new Error("Expected default permission profile.");
    }
    const request = {
      capabilities: ["process.execute", "network.connect"],
      policyId: "shell-network-allowed",
      subject: "curl https://example.test",
      toolName: "bashTool",
    };

    expect(new PermissionRuleMatcher(document).resolve(request, "ask")).toBe("allow");
    expect(
      new PermissionRuleMatcher(document).resolve(
        {
          ...request,
          capabilities: [...request.capabilities, "package.publish"],
          policyId: "package-publish",
          subject: "pnpm publish",
        },
        "ask",
      ),
    ).toBe("ask");
    expect(
      new PermissionRuleMatcher({
        ...document,
        profiles: {
          default: {
            ...profile,
            network: { default: "deny" },
          },
        },
      }).resolve(request, "allow"),
    ).toBe("deny");
  });

  it("rejects a document whose active profile is missing", () => {
    const document = createDefaultPermissionProfileDocument();

    expect(
      () =>
        new PermissionRuleMatcher({
          ...document,
          activeProfile: "missing",
        }),
    ).toThrow("Active permission profile does not exist");
  });
});
