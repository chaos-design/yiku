import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { YikuPaths } from "../src/paths.js";

describe("YikuPaths", () => {
  it("maps one Workspace into a readable Home hierarchy", () => {
    const paths = new YikuPaths({
      homeDir: "/users/example",
      workspaceDir: "/work/projects/test",
    });

    expect(paths).toMatchObject({
      atomicRunsDir: join(
        "/users/example",
        ".yiku",
        "workspaces",
        "projects_test",
        "logs",
        "atomic-runs",
      ),
      configFilePath: join("/users/example", ".yiku", "config.yaml"),
      envFilePath: join("/users/example", ".yiku", ".env"),
      evalsDir: join("/users/example", ".yiku", "workspaces", "projects_test", "evals"),
      globalMemoryFilePath: join("/users/example", ".yiku", "memory", "memories.sqlite"),
      permissionFilePath: join("/users/example", ".yiku", "permission", "global.json"),
      runsDir: join("/users/example", ".yiku", "workspaces", "projects_test", "logs", "runs"),
      sessionsDir: join("/users/example", ".yiku", "workspaces", "projects_test", "session"),
      workspaceMemoryFilePath: join(
        "/users/example",
        ".yiku",
        "workspaces",
        "projects_test",
        "memory",
        "memories.sqlite",
      ),
      workspaceMetadataFilePath: join(
        "/users/example",
        ".yiku",
        "workspaces",
        "projects_test",
        "workspace.json",
      ),
      workspaceName: "test",
      workspaceParentName: "projects",
      workspaceStorageName: "projects_test",
    });
  });

  it("normalizes the parent and Workspace names into one readable key", () => {
    const paths = new YikuPaths({
      homeDir: "/users/example",
      workspaceDir: "/work/My Projects/Agent Studio",
    });

    expect(paths.workspaceStorageName).toBe("my_projects_agent_studio");
  });

  it("uses an already resolved Workspace storage name", () => {
    const paths = new YikuPaths({
      homeDir: "/users/example",
      workspaceDir: "/work/projects/test",
      workspaceStorageName: "projects_test_deadbeef",
    });

    expect(paths.workspaceStorageName).toBe("projects_test_deadbeef");
    expect(paths.workspaceStorageDir).toBe(
      join("/users/example", ".yiku", "workspaces", "projects_test_deadbeef"),
    );
  });

  it("accepts normalized Unicode storage names up to 255 characters", () => {
    expect(
      new YikuPaths({
        workspaceDir: "/work/projects/test",
        workspaceStorageName: "项目_工作区2",
      }).workspaceStorageName,
    ).toBe("项目_工作区2");
    expect(
      new YikuPaths({
        workspaceDir: "/work/projects/test",
        workspaceStorageName: "a".repeat(255),
      }).workspaceStorageName,
    ).toBe("a".repeat(255));
  });

  it.each([
    "",
    ".",
    "..",
    "../outside",
    "bad/name",
    "bad\\name",
    "_bad",
    "bad_",
    "bad__name",
    "Bad_Name",
    "ｅxample",
    "e\u0301",
    "a".repeat(256),
  ])("rejects invalid resolved Workspace storage name %j", (workspaceStorageName) => {
    expect(
      () =>
        new YikuPaths({
          workspaceDir: "/work/projects/test",
          workspaceStorageName,
        }),
    ).toThrow("Workspace storage name must be a normalized single directory name");
  });

  it("rejects relative and root Workspace paths", () => {
    expect(() => new YikuPaths({ workspaceDir: "relative" })).toThrow(
      "Workspace path must be absolute",
    );
    expect(() => new YikuPaths({ workspaceDir: "/" })).toThrow(
      "Workspace path must have a directory name",
    );
    expect(() => new YikuPaths({ workspaceDir: "/test" })).toThrow(
      "Workspace path must have a parent directory name",
    );
    expect(() => new YikuPaths({ workspaceDir: "/work/---" })).toThrow(
      "storage name contains no usable characters",
    );
  });
});
