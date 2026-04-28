import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const piDir = await mkdtemp(join(tmpdir(), "pi-double-paste-"));
const args = [
  "--mode",
  "rpc",
  "--no-session",
  "--no-context-files",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-extensions",
  "-e",
  "./src/index.ts",
];

try {
  const stdout = await new Promise((resolve, reject) => {
    const child = spawn("pi", args, {
      env: { ...process.env, PI_CODING_AGENT_DIR: piDir },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let output = "";
    let errorOutput = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      errorOutput += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`pi exited with code ${code}\n${errorOutput}${output}`));
      }
    });

    child.stdin.end(`${JSON.stringify({ id: "state", type: "get_state" })}\n`);
  });

  const events = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  const sawLoadedNotification = events.some(
    (event) =>
      event.type === "extension_ui_request" &&
      event.method === "notify" &&
      String(event.message).includes("pi-double-paste loaded"),
  );

  const sawStateResponse = events.some(
    (event) =>
      event.id === "state" &&
      event.type === "response" &&
      event.command === "get_state" &&
      event.success === true,
  );

  if (!sawLoadedNotification) {
    throw new Error(`pi-double-paste load notification was not observed:\n${String(stdout)}`);
  }
  if (!sawStateResponse) {
    throw new Error(`RPC get_state response was not observed:\n${String(stdout)}`);
  }

  console.log("pi smoke test passed: extension loaded via pi RPC mode");
} finally {
  await rm(piDir, { recursive: true, force: true });
}
