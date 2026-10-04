import { z } from "zod";
import { sessionStateV2Schema } from "./session-state-v2.js";

export const SESSION_STATE_V1_SCHEMA_VERSION = 1;

export const sessionStateV1Schema = sessionStateV2Schema
  .omit({
    subagentInstances: true,
    subagentProfiles: true,
  })
  .extend({
    schemaVersion: z.literal(SESSION_STATE_V1_SCHEMA_VERSION),
  })
  .strict();

export type SessionStateV1 = z.infer<typeof sessionStateV1Schema>;
