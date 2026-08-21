import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const directory = await mkdtemp(join(tmpdir(), "songbook-server-smoke-"));
const databasePath = join(directory, "songbook.sqlite");
const child = spawn(process.execPath, ["dist/main.js"], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: "0",
    ORIGIN: "http://127.0.0.1",
    BETTER_AUTH_SECRET: "smoke-secret-smoke-secret-smoke-secret-1234",
    ALLOWED_USERS_JSON: JSON.stringify({ "allowed@example.com": "Allowed" }),
    DATABASE_PATH: databasePath,
    ASSETS_ROOT: directory
  },
  stdio: ["ignore", "pipe", "pipe"]
});
let output = "";
child.stdout.on("data", (chunk) => { output += chunk.toString(); });
child.stderr.on("data", (chunk) => { output += chunk.toString(); });

try {
  const deadline = Date.now() + 15_000;
  let port = 0;
  while (Date.now() < deadline) {
    const match = output.match(/songbook listening on http:\/\/[^:]+:(\d+)/);
    if (match) { port = Number(match[1]); break; }
    if (child.exitCode !== null) throw new Error(`server exited before listening: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!port) throw new Error(`server did not listen: ${output}`);
  const health = await fetch(`http://127.0.0.1:${port}/healthz`);
  if (!health.ok || (await health.json()).ok !== true) throw new Error(`health check failed: ${health.status}`);
  child.kill("SIGTERM");
  await new Promise((resolve, reject) => {
    child.once("exit", (code, signal) => code === 0 || signal === "SIGTERM" ? resolve() : reject(new Error(`server shutdown failed: ${code}/${signal}`)));
  });
  console.log("start smoke passed");
} finally {
  if (child.exitCode === null) child.kill("SIGTERM");
  await rm(directory, { recursive: true, force: true });
}
