import type { AgentProgressEvent } from "@yiku/agent-orchestrator";
import { MachineOutputState, stringifyMachineValue } from "./machine-output.js";
import type {
  CliJsonResult,
  CliMachineOutputFailure,
  CliMachineOutputSuccess,
  CliMachineOutputWriter,
} from "./types.js";

export class JsonOutputWriter implements CliMachineOutputWriter {
  private readonly state = new MachineOutputState();

  public constructor(private readonly stdout: NodeJS.WriteStream) {}

  public observe(event: AgentProgressEvent): void {
    this.state.observe(event);
  }

  public writeFailure(input: CliMachineOutputFailure): CliJsonResult {
    return this.write(this.state.failure(input));
  }

  public writeSuccess(input: CliMachineOutputSuccess): CliJsonResult {
    return this.write(this.state.success(input));
  }

  private write(result: CliJsonResult): CliJsonResult {
    this.stdout.write(`${stringifyMachineValue(result)}\n`);
    return result;
  }
}
