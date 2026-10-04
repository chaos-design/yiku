import { z } from "zod";
import { sessionStateV3Schema } from "./session-state-v3.js";

export const SESSION_STATE_V4_SCHEMA_VERSION = 4;

export const sessionStateV4Schema = sessionStateV3Schema
  .omit({ schemaVersion: true })
  .extend({
    checkpointHead: z.string().trim().min(1).max(256).optional(),
    eventLogPath: z.string().trim().min(1).max(4_096),
    outputStyle: z.enum(["default", "compact", "verbose"]),
    schemaVersion: z.literal(SESSION_STATE_V4_SCHEMA_VERSION),
    title: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export type SessionStateV4 = z.infer<typeof sessionStateV4Schema>;
