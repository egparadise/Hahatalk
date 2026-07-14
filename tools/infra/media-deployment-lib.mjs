import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";

export const mediaSecretNames = [
  "LIVEKIT_API_KEY",
  "LIVEKIT_API_SECRET",
  "REDIS_PASSWORD",
  "LIVEKIT_EGRESS_S3_ACCESS_KEY",
  "LIVEKIT_EGRESS_S3_SECRET_KEY"
];

const smokeSecretNames = ["MINIO_ROOT_USER", "MINIO_ROOT_PASSWORD"];
const placeholderFragments = ["change-me", "changeme", "example", "placeholder", "replace", ".invalid"];

function assertObject(value, label, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} must be an object.`);
    return {};
  }
  return value;
}

function integer(value, label, minimum, maximum, errors) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    errors.push(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
}

function parseUrl(value, label, protocols, errors) {
  if (typeof value !== "string") {
    errors.push(`${label} must be a URL.`);
    return undefined;
  }
  try {
    const parsed = new URL(value);
    if (!protocols.includes(parsed.protocol)) errors.push(`${label} must use ${protocols.join(" or ")}.`);
    if (parsed.username || parsed.password) errors.push(`${label} must not contain credentials.`);
    return parsed;
  } catch {
    errors.push(`${label} must be a valid URL.`);
    return undefined;
  }
}

function isLoopbackOrPrivate(hostname) {
  const normalized = hostname.toLowerCase();
  if (["localhost", "::1"].includes(normalized) || normalized.endsWith(".localhost")) return true;
  if (isIP(normalized) === 4) {
    const [first, second] = normalized.split(".").map(Number);
    return first === 10
      || first === 127
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168);
  }
  return normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
}

function isPlaceholder(value) {
  const normalized = String(value ?? "").toLowerCase();
  return placeholderFragments.some((fragment) => normalized.includes(fragment));
}

function isHostname(value) {
  if (typeof value !== "string" || value.length > 253 || !value.includes(".")) return false;
  return value.split(".").every((label) => (
    label.length >= 1
    && label.length <= 63
    && /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label)
  ));
}

function validateSecret(secrets, name, minimum, errors) {
  const value = secrets[name];
  if (typeof value !== "string" || value.length < minimum) {
    errors.push(`${name} must contain at least ${minimum} characters.`);
  } else if (/\s/.test(value) || isPlaceholder(value)) {
    errors.push(`${name} must not contain whitespace or a placeholder value.`);
  }
}

export async function readDeploymentManifest(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export function generateSmokeSecrets() {
  const token = (bytes) => randomBytes(bytes).toString("base64url");
  return {
    LIVEKIT_API_KEY: `API${randomBytes(9).toString("hex")}`,
    LIVEKIT_API_SECRET: token(36),
    REDIS_PASSWORD: token(36),
    LIVEKIT_EGRESS_S3_ACCESS_KEY: `EG${randomBytes(9).toString("hex")}`,
    LIVEKIT_EGRESS_S3_SECRET_KEY: token(36),
    MINIO_ROOT_USER: `ROOT${randomBytes(7).toString("hex")}`,
    MINIO_ROOT_PASSWORD: token(36)
  };
}

export function deploymentSecretsFromEnvironment(environment = process.env) {
  return Object.fromEntries([...mediaSecretNames, ...smokeSecretNames].map((name) => [name, environment[name] ?? ""]));
}

export function validateMediaDeployment(manifest, secrets) {
  const errors = [];
  const root = assertObject(manifest, "deployment", errors);
  if (root.schemaVersion !== 1) errors.push("schemaVersion must be 1.");
  if (!["production", "smoke"].includes(root.environment)) errors.push("environment must be production or smoke.");
  const production = root.environment === "production";

  const livekit = assertObject(root.livekit, "livekit", errors);
  const publicUrl = parseUrl(livekit.publicUrl, "livekit.publicUrl", production ? ["wss:"] : ["ws:", "wss:"], errors);
  const workerUrl = parseUrl(livekit.workerUrl, "livekit.workerUrl", production ? ["wss:"] : ["ws:", "wss:"], errors);
  if (production) {
    for (const [label, parsed] of [["livekit.publicUrl", publicUrl], ["livekit.workerUrl", workerUrl]]) {
      if (parsed && (isLoopbackOrPrivate(parsed.hostname) || isPlaceholder(parsed.hostname))) {
        errors.push(`${label} must use a real non-loopback production host.`);
      }
    }
  }
  const redisMatch = typeof livekit.redisAddress === "string"
    ? livekit.redisAddress.match(/^([a-zA-Z0-9._-]+):(\d{2,5})$/)
    : null;
  if (!redisMatch || Number(redisMatch[2]) < 1 || Number(redisMatch[2]) > 65535) {
    errors.push("livekit.redisAddress must be host:port without credentials.");
  }
  if (typeof livekit.useExternalIp !== "boolean") errors.push("livekit.useExternalIp must be boolean.");
  if (production && livekit.useExternalIp !== true) errors.push("Production LiveKit must discover or advertise its external IP.");
  if (livekit.nodeIp !== null && livekit.nodeIp !== undefined && typeof livekit.nodeIp !== "string") {
    errors.push("livekit.nodeIp must be a string or null.");
  }

  const rtc = assertObject(livekit.rtc, "livekit.rtc", errors);
  integer(rtc.tcpPort, "livekit.rtc.tcpPort", 1024, 65535, errors);
  if (rtc.udpPort !== undefined) integer(rtc.udpPort, "livekit.rtc.udpPort", 1024, 65535, errors);
  if (rtc.portRangeStart !== undefined || rtc.portRangeEnd !== undefined) {
    integer(rtc.portRangeStart, "livekit.rtc.portRangeStart", 1024, 65535, errors);
    integer(rtc.portRangeEnd, "livekit.rtc.portRangeEnd", 1024, 65535, errors);
    if (Number.isInteger(rtc.portRangeStart) && Number.isInteger(rtc.portRangeEnd) && rtc.portRangeStart >= rtc.portRangeEnd) {
      errors.push("livekit.rtc.portRangeStart must be lower than portRangeEnd.");
    }
  }
  if (rtc.udpPort !== undefined && rtc.portRangeStart !== undefined) {
    errors.push("Choose either rtc.udpPort or an RTC UDP port range, not both.");
  }
  if (production && rtc.portRangeStart === undefined && rtc.udpPort === undefined) {
    errors.push("Production LiveKit requires an RTC UDP port or port range.");
  }

  const turn = assertObject(livekit.turn, "livekit.turn", errors);
  if (typeof turn.enabled !== "boolean") errors.push("livekit.turn.enabled must be boolean.");
  if (production && turn.enabled !== true) errors.push("Production requires TURN/TLS for restrictive networks.");
  if (turn.enabled) {
    if (!isHostname(turn.domain) || isPlaceholder(turn.domain) || isLoopbackOrPrivate(turn.domain)) {
      errors.push("livekit.turn.domain must be a real non-loopback hostname.");
    }
    integer(turn.tlsPort, "livekit.turn.tlsPort", 1, 65535, errors);
    if (publicUrl && turn.domain === publicUrl.hostname) errors.push("TURN must use a separate hostname from LiveKit signaling.");
    if (turn.externalTls !== true && turn.tlsPort !== 443) {
      errors.push("TURN/TLS without a layer-4 load balancer must advertise port 443.");
    }
  }

  const egress = assertObject(root.egress, "egress", errors);
  integer(egress.healthPort, "egress.healthPort", 1024, 65535, errors);
  integer(egress.prometheusPort, "egress.prometheusPort", 1024, 65535, errors);
  if (egress.healthPort === egress.prometheusPort) errors.push("Egress health and Prometheus ports must be different.");
  if (typeof egress.fileOutputMaxDuration !== "string" || !/^\d+(ms|s|m|h)$/.test(egress.fileOutputMaxDuration)) {
    errors.push("egress.fileOutputMaxDuration must be a bounded duration such as 15m or 4h.");
  }

  const storage = assertObject(root.storage, "storage", errors);
  const storageEndpoint = parseUrl(storage.endpoint, "storage.endpoint", production ? ["https:"] : ["http:", "https:"], errors);
  const verificationEndpoint = parseUrl(storage.verificationEndpoint, "storage.verificationEndpoint", production ? ["https:"] : ["http:", "https:"], errors);
  if (production) {
    for (const [label, parsed] of [["storage.endpoint", storageEndpoint], ["storage.verificationEndpoint", verificationEndpoint]]) {
      if (parsed && (isLoopbackOrPrivate(parsed.hostname) || isPlaceholder(parsed.hostname))) {
        errors.push(`${label} must use a real non-loopback production host.`);
      }
    }
  }
  if (typeof storage.bucket !== "string" || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(storage.bucket)) {
    errors.push("storage.bucket must be a valid lowercase S3 bucket name.");
  }
  if (typeof storage.region !== "string" || storage.region.length < 3 || isPlaceholder(storage.region)) {
    errors.push("storage.region must be configured.");
  }
  if (typeof storage.forcePathStyle !== "boolean") errors.push("storage.forcePathStyle must be boolean.");
  integer(storage.retentionDays, "storage.retentionDays", 1, 3650, errors);

  const webhookUrl = root.webhookUrl === null
    ? undefined
    : parseUrl(root.webhookUrl, "webhookUrl", production ? ["https:"] : ["http:", "https:"], errors);
  if (production && !webhookUrl) errors.push("Production requires a signed HTTPS LiveKit webhook URL.");
  if (production && webhookUrl && (isLoopbackOrPrivate(webhookUrl.hostname) || isPlaceholder(webhookUrl.hostname))) {
    errors.push("webhookUrl must use a real non-loopback production host.");
  }

  validateSecret(secrets, "LIVEKIT_API_KEY", 16, errors);
  validateSecret(secrets, "LIVEKIT_API_SECRET", 32, errors);
  validateSecret(secrets, "REDIS_PASSWORD", 24, errors);
  validateSecret(secrets, "LIVEKIT_EGRESS_S3_ACCESS_KEY", 16, errors);
  validateSecret(secrets, "LIVEKIT_EGRESS_S3_SECRET_KEY", 32, errors);
  if (!production) {
    validateSecret(secrets, "MINIO_ROOT_USER", 16, errors);
    validateSecret(secrets, "MINIO_ROOT_PASSWORD", 32, errors);
  }

  if (errors.length) throw new Error(`Invalid HahaTalk media deployment:\n- ${errors.join("\n- ")}`);
  return { production, publicUrl, storageEndpoint, verificationEndpoint, webhookUrl, workerUrl };
}

function envLines(values) {
  return `${Object.entries(values).map(([name, value]) => `${name}=${value ?? ""}`).join("\n")}\n`;
}

async function writePrivate(filePath, content) {
  await writeFile(filePath, content, { encoding: "utf8", mode: 0o600 });
  await chmod(filePath, 0o600).catch(() => undefined);
}

export async function renderMediaDeployment({ manifest, outputDirectory, secrets }) {
  const validation = validateMediaDeployment(manifest, secrets);
  await mkdir(outputDirectory, { recursive: true });

  const rtc = {
    tcp_port: manifest.livekit.rtc.tcpPort,
    use_external_ip: manifest.livekit.useExternalIp,
    ...(manifest.livekit.nodeIp ? { node_ip: manifest.livekit.nodeIp } : {}),
    ...(manifest.livekit.rtc.udpPort ? { udp_port: manifest.livekit.rtc.udpPort } : {}),
    ...(manifest.livekit.rtc.portRangeStart ? {
      port_range_start: manifest.livekit.rtc.portRangeStart,
      port_range_end: manifest.livekit.rtc.portRangeEnd
    } : {})
  };
  const livekitConfig = {
    port: 7880,
    redis: { address: manifest.livekit.redisAddress, password: secrets.REDIS_PASSWORD },
    rtc,
    keys: { [secrets.LIVEKIT_API_KEY]: secrets.LIVEKIT_API_SECRET },
    logging: { json: true, level: "info" },
    room: { auto_create: false, departure_timeout: 20, empty_timeout: 300 },
    ...(manifest.livekit.turn.enabled ? {
      turn: {
        domain: manifest.livekit.turn.domain,
        enabled: true,
        external_tls: manifest.livekit.turn.externalTls === true,
        tls_port: manifest.livekit.turn.tlsPort,
        ttl_seconds: 300
      }
    } : {}),
    ...(manifest.webhookUrl ? { webhook: { api_key: secrets.LIVEKIT_API_KEY, urls: [manifest.webhookUrl] } } : {})
  };
  const egressConfig = {
    api_key: secrets.LIVEKIT_API_KEY,
    api_secret: secrets.LIVEKIT_API_SECRET,
    ws_url: manifest.livekit.workerUrl,
    insecure: validation.workerUrl.protocol === "ws:",
    redis: { address: manifest.livekit.redisAddress, password: secrets.REDIS_PASSWORD },
    health_port: manifest.egress.healthPort,
    prometheus_port: manifest.egress.prometheusPort,
    backup_storage: "/var/lib/livekit-egress/backup",
    logging: { json: true, level: "info" },
    session_limits: { file_output_max_duration: manifest.egress.fileOutputMaxDuration }
  };
  const centralApiEnvironment = {
    LIVEKIT_URL: manifest.livekit.publicUrl,
    LIVEKIT_API_KEY: secrets.LIVEKIT_API_KEY,
    LIVEKIT_API_SECRET: secrets.LIVEKIT_API_SECRET,
    LIVEKIT_EGRESS_ENABLED: "1",
    LIVEKIT_EGRESS_S3_ACCESS_KEY: secrets.LIVEKIT_EGRESS_S3_ACCESS_KEY,
    LIVEKIT_EGRESS_S3_SECRET_KEY: secrets.LIVEKIT_EGRESS_S3_SECRET_KEY,
    LIVEKIT_EGRESS_S3_BUCKET: manifest.storage.bucket,
    LIVEKIT_EGRESS_S3_REGION: manifest.storage.region,
    LIVEKIT_EGRESS_S3_ENDPOINT: manifest.storage.endpoint,
    LIVEKIT_EGRESS_S3_FORCE_PATH_STYLE: manifest.storage.forcePathStyle ? "1" : "0",
    HAHATALK_LIVEKIT_WEBHOOK_URL: manifest.webhookUrl ?? "",
    HAHATALK_RECORDING_RETENTION_DAYS: String(manifest.storage.retentionDays),
    ...(manifest.environment === "smoke" ? { HAHATALK_TEST_MEDIA_INFRA: "1" } : {})
  };
  const egressPolicy = {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "RecordingBucketDiscovery",
        Effect: "Allow",
        Action: ["s3:GetBucketLocation"],
        Resource: [`arn:aws:s3:::${manifest.storage.bucket}`]
      },
      {
        Sid: "RecordingObjectUploadOnly",
        Effect: "Allow",
        Action: ["s3:AbortMultipartUpload", "s3:ListMultipartUploadParts", "s3:PutObject"],
        Resource: [`arn:aws:s3:::${manifest.storage.bucket}/recordings/*`]
      }
    ]
  };
  const summary = {
    schemaVersion: 1,
    environment: manifest.environment,
    livekit: {
      publicUrl: manifest.livekit.publicUrl,
      workerUrl: manifest.livekit.workerUrl,
      rtc: manifest.livekit.rtc,
      turn: manifest.livekit.turn
    },
    egress: manifest.egress,
    storage: manifest.storage,
    webhookConfigured: Boolean(manifest.webhookUrl),
    requiredSecretNames: mediaSecretNames,
    generatedAt: new Date().toISOString()
  };

  await writePrivate(path.join(outputDirectory, "livekit.yaml"), stringifyYaml(livekitConfig));
  await writePrivate(path.join(outputDirectory, "egress.yaml"), stringifyYaml(egressConfig));
  await writePrivate(path.join(outputDirectory, "central-api.env"), envLines(centralApiEnvironment));
  await writePrivate(path.join(outputDirectory, "egress-write-policy.json"), `${JSON.stringify(egressPolicy, null, 2)}\n`);
  await writePrivate(path.join(outputDirectory, "deployment-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

  if (manifest.environment === "smoke") {
    await writePrivate(path.join(outputDirectory, "redis.env"), envLines({
      REDIS_PASSWORD: secrets.REDIS_PASSWORD
    }));
    await writePrivate(path.join(outputDirectory, "minio.env"), envLines({
      MINIO_ROOT_USER: secrets.MINIO_ROOT_USER,
      MINIO_ROOT_PASSWORD: secrets.MINIO_ROOT_PASSWORD
    }));
    await writePrivate(path.join(outputDirectory, "provision.env"), envLines({
      MINIO_ROOT_USER: secrets.MINIO_ROOT_USER,
      MINIO_ROOT_PASSWORD: secrets.MINIO_ROOT_PASSWORD,
      LIVEKIT_EGRESS_S3_ACCESS_KEY: secrets.LIVEKIT_EGRESS_S3_ACCESS_KEY,
      LIVEKIT_EGRESS_S3_SECRET_KEY: secrets.LIVEKIT_EGRESS_S3_SECRET_KEY,
      RECORDING_BUCKET: manifest.storage.bucket,
      RECORDING_RETENTION_DAYS: String(manifest.storage.retentionDays)
    }));
  }

  return { centralApiEnvironment, egressConfig, livekitConfig, summary };
}
