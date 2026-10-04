import { z } from "zod";

export const WORKSPACE_SNAPSHOT_MANIFEST_VERSION = 1;

const relativePosixPathSchema = z.string().refine(isRelativePosixPath, {
  message: "Snapshot entry path must be a normalized relative POSIX path.",
});

export const workspaceSnapshotEntrySchema = z
  .object({
    hash: z.string().regex(/^[a-f0-9]{64}$/u, "Snapshot entry hash must be a SHA-256 digest."),
    mode: z.number().int().min(0).max(0o777),
    path: relativePosixPathSchema,
    size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    type: z.literal("file"),
  })
  .strict();

export const workspaceSnapshotManifestSchema = z
  .object({
    createdAt: z.string().datetime({ offset: true }),
    entries: z.array(workspaceSnapshotEntrySchema),
    eventHead: z.string().optional(),
    id: z.string().uuid(),
    sessionId: z.string().min(1),
    sessionRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    version: z.literal(WORKSPACE_SNAPSHOT_MANIFEST_VERSION),
  })
  .strict()
  .superRefine((manifest, context) => {
    const paths = new Set<string>();
    for (const [index, entry] of manifest.entries.entries()) {
      if (paths.has(entry.path)) {
        context.addIssue({
          code: "custom",
          message: `Snapshot entry path is duplicated: ${entry.path}.`,
          path: ["entries", index, "path"],
        });
      }
      paths.add(entry.path);
    }
  });

export type WorkspaceSnapshotEntry = z.infer<typeof workspaceSnapshotEntrySchema>;
export type WorkspaceSnapshotManifest = z.infer<typeof workspaceSnapshotManifestSchema>;

export function parseWorkspaceSnapshotManifest(value: unknown): WorkspaceSnapshotManifest {
  return workspaceSnapshotManifestSchema.parse(value);
}

function isRelativePosixPath(value: string): boolean {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    /^[a-zA-Z]:\//u.test(value)
  ) {
    return false;
  }

  const segments = value.split("/");
  return !segments.some((segment) => segment === "" || segment === "." || segment === "..");
}
