const path = require("node:path");
const http = require("node:http");
const { app, utilityProcess } = require("electron");

const agentPath = path.join(process.cwd(), "apps", "desktop", "remote-support-agent.cjs");
let child;
let server;
let finished = false;

function finish(error) {
  if (finished) return;
  finished = true;
  child?.kill();
  server?.close();
  if (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    app.exit(1);
  } else {
    console.log("Windows remote support utility process bridge passed.");
    app.exit(0);
  }
}

app.whenReady().then(() => {
  server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/internal/remote-support/activate") {
        response.end(JSON.stringify({
          agentMode: "dry_run",
          agentToken: "probe-agent-token-at-least-thirty-two-characters",
          controlEpoch: 1,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          sessionId: "00000000-0000-4000-8000-000000000901"
        }));
      } else {
        response.end(JSON.stringify({ commands: [], controlEpoch: 1, sessionStatus: "active" }));
      }
    });
  });
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    child = utilityProcess.fork(agentPath, [], {
      env: { NODE_ENV: "test" },
      serviceName: "HahaTalk Remote Support Agent Probe",
      stdio: "pipe"
    });
    child.stderr?.on("data", (chunk) => console.error(String(chunk).trimEnd()));
    child.on("message", (message) => {
      if (message?.type !== "remote-support-status") return;
      if (message.state === "ready") {
        child.postMessage({
          type: "activate",
          configuration: {
            activationSecret: "probe-activation-secret-at-least-thirty-two-characters",
            agentInstanceId: "hht_agent_process_probe",
            agentVersion: "probe",
            apiBaseUrl: `http://127.0.0.1:${port}`,
            deviceId: "hht_device_process_probe",
            platform: "win32",
            sessionId: "00000000-0000-4000-8000-000000000901"
          }
        });
      }
      if (message.state === "online") finish();
      if (message.state === "failed") finish(new Error(`Remote support utility process failed: ${message.detail}`));
    });
    child.on("exit", (code) => {
      if (!finished) finish(new Error(`Remote support utility process exited before online with code ${code}.`));
    });
  });
  setTimeout(() => finish(new Error("Remote support utility process did not complete activation.")), 10_000).unref();
}).catch(finish);
