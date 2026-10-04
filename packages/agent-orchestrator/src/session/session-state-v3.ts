import { z } from "zod";
import { sessionStateV2Schema } from "./session-state-v2.js";

export const SESSION_STATE_V3_SCHEMA_VERSION = 3;

const subagentProfileV3Schema = sessionStateV2Schema.shape.subagentProfiles.element
  .extend({
    configPath: z.string().trim().min(1).max(4_096).optional(),
    description: z.string().trim().min(1).max(500),
    invocationMode: z.enum(["manual", "proactive"]),
    purpose: z.enum([
      "code-review",
      "test-generation",
      "code-research",
      "feature-implementation",
      "custom",
    ]),
    scopes: z.array(z.string().trim().min(1).max(512)).min(1).max(8),
    source: z.enum(["project", "session", "user"]),
    triggerInstructions: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();

export const sessionStateV3Schema = sessionStateV2Schema
  .omit({
    schemaVersion: true,
    subagentProfiles: true,
  })
  .extend({
    schemaVersion: z.literal(SESSION_STATE_V3_SCHEMA_VERSION),
    subagentProfiles: z.array(subagentProfileV3Schema).max(12),
  })
  .strict();

export type SessionStateV3 = z.infer<typeof sessionStateV3Schema>;
