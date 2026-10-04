import { spawn } from "node:child_process";

const mode = process.argv[2];
let input = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const event = input.trim() ? JSON.parse(input) : {};

  switch (mode) {
    case "context":
      process.stdout.write(
        JSON.stringify({
          additionalContext: JSON.stringify({
            cwd: process.cwd(),
            eventName: event.hook_event_name,
            projectDir: process.env.CLAUDE_PROJECT_DIR,
            sessionId: process.env.CLAUDE_SESSION_ID,
          }),
        }),
      );
      return;
    case "block":
      process.stderr.write("blocked by fixture");
      process.exitCode = 2;
      return;
    case "error":
      process.stderr.write("fixture failed");
      process.exitCode = 7;
      return;
    case "invalid-json":
      process.stdout.write("{");
      return;
    case "large":
      process.stdout.write("x".repeat(4_096));
      return;
    case "large-stderr":
      process.stderr.write("x".repeat(4_096));
      return;
    case "hang": {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        detached: false,
        stdio: "ignore",
      });
      child.unref();
      setInterval(() => {}, 1_000);
      return;
    }
    default:
      process.stdout.write("unknown mode");
  }
});
