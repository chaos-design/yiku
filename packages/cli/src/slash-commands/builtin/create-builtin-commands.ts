import type { SlashCommand } from "../types.js";
import { agentNewCommand } from "./agent-new.js";
import { agentsCommand } from "./agents.js";
import { branchCommand } from "./branch.js";
import { cancelCommand } from "./cancel.js";
import { clearCommand } from "./clear.js";
import { compactCommand } from "./compact.js";
import { contextCommand } from "./context.js";
import { copyCommand } from "./copy.js";
import { doctorCommand } from "./doctor.js";
import { exitCommand } from "./exit.js";
import { exportCommand } from "./export.js";
import { helpCommand } from "./help.js";
import { hooksCommand } from "./hooks.js";
import { initCommand } from "./init.js";
import { mcpCommand } from "./mcp.js";
import { memoryCommand } from "./memory.js";
import { modelCommand } from "./model.js";
import { outputStyleCommand } from "./output-style.js";
import { renameCommand } from "./rename.js";
import { resumeCommand } from "./resume.js";
import { reviewCommand } from "./review.js";
import { rewindCommand } from "./rewind.js";
import { skillsCommand } from "./skills.js";
import { specBrainstormCommand } from "./spec-brainstorm.js";
import { specExecutePlanCommand } from "./spec-execute-plan.js";
import { specSaveDesignCommand } from "./spec-save-design.js";
import { specWritePlanCommand } from "./spec-write-plan.js";
import { statusCommand } from "./status.js";
import { tasksCommand } from "./tasks.js";
import { usageCommand } from "./usage.js";

export function createBuiltinCommands(): readonly SlashCommand[] {
  return Object.freeze([
    clearCommand,
    helpCommand,
    agentNewCommand,
    agentsCommand,
    statusCommand,
    contextCommand,
    usageCommand,
    tasksCommand,
    memoryCommand,
    skillsCommand,
    compactCommand,
    initCommand,
    doctorCommand,
    cancelCommand,
    hooksCommand,
    resumeCommand,
    renameCommand,
    branchCommand,
    rewindCommand,
    modelCommand,
    mcpCommand,
    outputStyleCommand,
    reviewCommand,
    copyCommand,
    exportCommand,
    specBrainstormCommand,
    specWritePlanCommand,
    specExecutePlanCommand,
    specSaveDesignCommand,
    exitCommand,
  ]);
}
