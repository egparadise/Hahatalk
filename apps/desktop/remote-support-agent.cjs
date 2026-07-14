const { setTimeout: delay } = require("node:timers/promises");

const allowedKinds = new Set(["pointer_move", "pointer_button", "wheel", "key"]);
const allowedKeys = new Set([
  "Tab", "Enter", "Escape", "Backspace", "Delete", "Space",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Home", "End", "PageUp", "PageDown",
  ...Array.from({ length: 26 }, (_, index) => `Key${String.fromCharCode(65 + index)}`),
  ...Array.from({ length: 10 }, (_, index) => `Digit${index}`),
  ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`)
]);

function validateCommand(command, expectedEpoch) {
  if (!command || typeof command !== "object") throw new Error("invalid_command");
  if (!allowedKinds.has(command.kind)) throw new Error("command_kind_not_allowed");
  if (!Number.isSafeInteger(command.sequence) || command.sequence < 1) throw new Error("invalid_sequence");
  if (command.controlEpoch !== expectedEpoch) throw new Error("stale_control_epoch");
  if (Date.parse(command.expiresAt) <= Date.now()) throw new Error("command_expired");
  const payload = command.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid_payload");
  if (command.kind === "pointer_move") {
    if (![payload.x, payload.y].every((value) => typeof value === "number" && value >= 0 && value <= 1)) {
      throw new Error("invalid_pointer_coordinates");
    }
  } else if (command.kind === "pointer_button") {
    if (!["click", "down", "up"].includes(payload.action) || !["left", "middle", "right"].includes(payload.button)) {
      throw new Error("invalid_pointer_button");
    }
  } else if (command.kind === "wheel") {
    if (
      ![payload.deltaX, payload.deltaY].every((value) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000)
    ) {
      throw new Error("invalid_wheel_delta");
    }
  } else if (!["press", "down", "up"].includes(payload.action) || !allowedKeys.has(payload.code)) {
    throw new Error("key_not_allowed");
  }
  return true;
}

function runtimeFetch(url, options) {
  if (process.versions.electron) {
    const electron = require("electron");
    if (electron.net?.fetch) return electron.net.fetch(url, options);
  }
  return fetch(url, options);
}

async function requestJson(apiBaseUrl, pathName, options = {}) {
  const response = await runtimeFetch(`${apiBaseUrl}${pathName}`, {
    body: options.payload === undefined ? undefined : JSON.stringify(options.payload),
    headers: {
      "Content-Type": "application/json",
      ...(options.activation ? { "X-HahaTalk-Remote-Agent": "agent-v1" } : {}),
      ...(options.token ? { "X-HahaTalk-Remote-Agent-Token": options.token } : {})
    },
    method: "POST",
    signal: AbortSignal.timeout(10_000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(typeof body.message === "string" ? body.message : `agent_http_${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

async function runAgent(configuration, notify, signal) {
  const { apiBaseUrl, agentInstanceId, agentVersion, deviceId, platform, sessionId } = configuration;
  let activationSecret = configuration.activationSecret;
  let credential;
  try {
    notify({ state: "activating" });
    credential = await requestJson(apiBaseUrl, "/internal/remote-support/activate", {
      activation: true,
      payload: { activationSecret, agentInstanceId, agentVersion, deviceId, platform }
    });
  } finally {
    activationSecret = undefined;
    configuration.activationSecret = undefined;
  }
  if (credential.sessionId !== sessionId || credential.agentMode !== "dry_run") {
    throw new Error("unsupported_agent_credential");
  }

  let agentToken = credential.agentToken;
  let controlEpoch = credential.controlEpoch;
  notify({ controlEpoch, mode: credential.agentMode, state: "online" });
  try {
    while (!signal.aborted) {
      let poll;
      try {
        poll = await requestJson(apiBaseUrl, `/internal/remote-support/sessions/${sessionId}/commands/claim`, {
          token: agentToken
        });
      } catch (error) {
        if ([401, 403, 409].includes(error.status)) break;
        notify({ detail: "poll_retry", state: "degraded" });
        await delay(1_500, undefined, { signal }).catch(() => undefined);
        continue;
      }
      controlEpoch = poll.controlEpoch;
      if (poll.sessionStatus !== "active") break;
      notify({ controlEpoch, state: "online" });
      for (const command of poll.commands ?? []) {
        let outcome = "simulated";
        let resultCode = "unsigned_agent_dry_run";
        try {
          validateCommand(command, controlEpoch);
        } catch (error) {
          outcome = "rejected";
          resultCode = error instanceof Error ? error.message : "command_validation_failed";
        }
        await requestJson(
          apiBaseUrl,
          `/internal/remote-support/sessions/${sessionId}/commands/${command.id}/complete`,
          { payload: { outcome, resultCode }, token: agentToken }
        );
        notify({ commandKind: command.kind, outcome, sequence: command.sequence, state: "online" });
      }
      await delay(600, undefined, { signal }).catch(() => undefined);
    }
  } finally {
    agentToken = undefined;
    credential = undefined;
  }
  notify({ state: "stopped" });
}

function utilityParentPort() {
  if (!process.versions.electron) return undefined;
  if (process.parentPort) return process.parentPort;
  try {
    const electron = require("electron");
    return electron && typeof electron === "object" ? electron.parentPort : undefined;
  } catch {
    return undefined;
  }
}

const parentPort = utilityParentPort();
if (parentPort) {
  const controller = new AbortController();
  let started = false;
  const notify = (payload) => parentPort.postMessage({ type: "remote-support-status", ...payload });
  parentPort.on("message", (event) => {
    const message = event.data;
    if (message?.type === "stop") {
      controller.abort();
      return;
    }
    if (message?.type !== "activate" || started) return;
    started = true;
    void runAgent(message.configuration, notify, controller.signal)
      .catch((error) => notify({ detail: error instanceof Error ? error.message : "agent_failed", state: "failed" }))
      .finally(() => setTimeout(() => process.exit(0), 25));
  });
  notify({ state: "ready" });
}

module.exports = { runAgent, validateCommand };
