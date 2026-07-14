import { randomUUID } from "node:crypto";
import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import {
  EgressClient,
  EgressStatus,
  EncodedFileOutput,
  EncodedFileType,
  EncodingOptionsPreset,
  RoomServiceClient,
  S3Upload,
  WebhookConfig,
  WebhookReceiver,
  type EgressInfo,
  type WebhookEvent
} from "livekit-server-sdk";
import type { RecordingCapabilities } from "@hahatalk/contracts";

export const recordingPolicyVersion = "hahatalk-recording-v1";

export type RecordingProviderStatus =
  | "starting"
  | "active"
  | "ending"
  | "complete"
  | "failed"
  | "aborted"
  | "limit_reached";

export type RecordingProviderState = {
  id: string;
  roomName?: string;
  status: RecordingProviderStatus;
  startedAt?: Date;
  endedAt?: Date;
  outputSizeBytes?: number;
  outputDurationSeconds?: number;
  failureCode?: string;
};

type TestConfiguration = {
  driver: "memory";
  apiKey: string;
  apiSecret: string;
  deployment: "local" | "remote";
  serviceUrl: string;
};

type LiveKitConfiguration = {
  driver: "livekit";
  apiKey: string;
  apiSecret: string;
  deployment: "local" | "remote";
  serviceUrl: string;
  storage: {
    accessKey: string;
    bucket: string;
    endpoint: string;
    forcePathStyle: boolean;
    region: string;
    secret: string;
    sessionToken: string;
  };
  webhookUrl?: string;
};

type EgressConfiguration = TestConfiguration | LiveKitConfiguration;

@Injectable()
export class LiveKitEgressProviderService {
  private readonly testRecordings = new Map<string, RecordingProviderState>();

  capabilities(): RecordingCapabilities {
    const configuration = this.configuration();
    if (!configuration) {
      return {
        available: false,
        deployment: "unconfigured",
        mode: "room_composite",
        outputFormat: "mp4",
        policyVersion: recordingPolicyVersion,
        provider: "livekit-egress",
        reason: "Recording requires a configured LiveKit Egress service and protected S3-compatible storage."
      };
    }
    return {
      available: true,
      deployment: configuration.deployment,
      mode: "room_composite",
      outputFormat: "mp4",
      policyVersion: recordingPolicyVersion,
      provider: "livekit-egress"
    };
  }

  async startRoomComposite(input: { objectKey: string; recordingId: string; roomName: string }) {
    const configuration = this.requiredConfiguration();
    if (configuration.driver === "memory") {
      if (process.env.HAHATALK_TEST_EGRESS_FAIL_START === "1") {
        throw new ServiceUnavailableException("The recording provider could not start.");
      }
      const state: RecordingProviderState = {
        id: `EG_TEST_${randomUUID().replaceAll("-", "")}`,
        roomName: input.roomName,
        startedAt: new Date(),
        status: "active"
      };
      this.testRecordings.set(state.id, state);
      return state;
    }

    const output = new EncodedFileOutput({
      fileType: EncodedFileType.MP4,
      filepath: input.objectKey,
      output: {
        case: "s3",
        value: new S3Upload({
          accessKey: configuration.storage.accessKey,
          bucket: configuration.storage.bucket,
          endpoint: configuration.storage.endpoint,
          forcePathStyle: configuration.storage.forcePathStyle,
          metadata: { "hahatalk-recording-id": input.recordingId },
          region: configuration.storage.region,
          secret: configuration.storage.secret,
          sessionToken: configuration.storage.sessionToken
        })
      }
    });
    const webhooks = configuration.webhookUrl
      ? [new WebhookConfig({ signingKey: configuration.apiKey, url: configuration.webhookUrl })]
      : undefined;
    const info = await this.egressClient(configuration).startRoomCompositeEgress(
      input.roomName,
      output,
      {
        encodingOptions: EncodingOptionsPreset.H264_720P_30,
        layout: "grid",
        ...(webhooks ? { webhooks } : {})
      }
    );
    return this.mapInfo(info);
  }

  async stop(egressId: string) {
    const configuration = this.requiredConfiguration();
    if (configuration.driver === "memory") {
      if (process.env.HAHATALK_TEST_EGRESS_FAIL_STOP === "1") {
        throw new ServiceUnavailableException("The recording provider could not stop.");
      }
      const existing = this.testRecordings.get(egressId);
      if (!existing) throw new ServiceUnavailableException("The recording provider state was not found.");
      const endedAt = new Date();
      const state: RecordingProviderState = {
        ...existing,
        endedAt,
        outputDurationSeconds: existing.startedAt
          ? Math.max(0, (endedAt.getTime() - existing.startedAt.getTime()) / 1_000)
          : 0,
        outputSizeBytes: 0,
        status: "complete"
      };
      this.testRecordings.set(egressId, state);
      return state;
    }
    return this.mapInfo(await this.egressClient(configuration).stopEgress(egressId));
  }

  async get(egressId: string) {
    const configuration = this.requiredConfiguration();
    if (configuration.driver === "memory") return this.testRecordings.get(egressId);
    const states = await this.egressClient(configuration).listEgress({ active: false, egressId });
    const info = states[0];
    return info ? this.mapInfo(info) : undefined;
  }

  async findActiveForRoom(roomName: string) {
    const configuration = this.requiredConfiguration();
    if (configuration.driver === "memory") {
      const states = [...this.testRecordings.values()].filter((state) => (
        state.roomName === roomName && ["starting", "active", "ending"].includes(state.status)
      ));
      return states.length === 1 ? states[0] : undefined;
    }
    const states = await this.egressClient(configuration).listEgress({ active: true, roomName });
    return states.length === 1 ? this.mapInfo(states[0]!) : undefined;
  }

  async deleteRoom(roomName: string) {
    const configuration = this.requiredConfiguration();
    await new RoomServiceClient(
      configuration.serviceUrl,
      configuration.apiKey,
      configuration.apiSecret,
      { failover: false, requestTimeout: 5 }
    ).deleteRoom(roomName);
  }

  async receiveWebhook(body: string, authorization?: string): Promise<WebhookEvent> {
    const configuration = this.requiredConfiguration();
    return new WebhookReceiver(configuration.apiKey, configuration.apiSecret).receive(body, authorization);
  }

  mapInfo(info: EgressInfo): RecordingProviderState {
    const file = info.fileResults[0];
    const startedAt = this.instant(info.startedAt);
    const endedAt = this.instant(info.endedAt);
    return {
      id: info.egressId,
      ...(info.roomName ? { roomName: info.roomName } : {}),
      status: this.mapStatus(info.status),
      ...(startedAt ? { startedAt } : {}),
      ...(endedAt ? { endedAt } : {}),
      ...(file && file.size >= 0n ? { outputSizeBytes: Number(file.size) } : {}),
      ...(file && file.duration >= 0n ? { outputDurationSeconds: Number(file.duration) / 1_000_000_000 } : {}),
      ...(info.errorCode ? { failureCode: `provider_${info.errorCode}` } : {})
    };
  }

  private mapStatus(status: EgressStatus): RecordingProviderStatus {
    switch (status) {
      case EgressStatus.EGRESS_STARTING: return "starting";
      case EgressStatus.EGRESS_ACTIVE: return "active";
      case EgressStatus.EGRESS_ENDING: return "ending";
      case EgressStatus.EGRESS_COMPLETE: return "complete";
      case EgressStatus.EGRESS_ABORTED: return "aborted";
      case EgressStatus.EGRESS_LIMIT_REACHED: return "limit_reached";
      default: return "failed";
    }
  }

  private instant(value: bigint) {
    return value > 0n ? new Date(Number(value / 1_000_000n)) : undefined;
  }

  private egressClient(configuration: LiveKitConfiguration) {
    return new EgressClient(
      configuration.serviceUrl,
      configuration.apiKey,
      configuration.apiSecret,
      { failover: false, requestTimeout: 10 }
    );
  }

  private requiredConfiguration() {
    const configuration = this.configuration();
    if (!configuration) {
      throw new ServiceUnavailableException("Recording is not configured.");
    }
    return configuration;
  }

  private configuration(): EgressConfiguration | undefined {
    const rawUrl = process.env.LIVEKIT_URL?.trim();
    const apiKey = process.env.LIVEKIT_API_KEY?.trim();
    const apiSecret = process.env.LIVEKIT_API_SECRET?.trim();
    if (!rawUrl || !apiKey || !apiSecret) return undefined;

    let deployment: "local" | "remote";
    let serviceUrl: string;
    try {
      const parsed = new URL(rawUrl);
      const local = ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
      if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) return undefined;
      if (parsed.username || parsed.password) return undefined;
      if (!local && !["https:", "wss:"].includes(parsed.protocol)) return undefined;
      deployment = local ? "local" : "remote";
      parsed.protocol = parsed.protocol === "https:" || parsed.protocol === "wss:" ? "https:" : "http:";
      serviceUrl = parsed.toString().replace(/\/$/, "");
    } catch {
      return undefined;
    }

    if (process.env.NODE_ENV === "test" && process.env.HAHATALK_TEST_EGRESS_DRIVER === "memory") {
      return { apiKey, apiSecret, deployment, driver: "memory", serviceUrl };
    }
    if (process.env.LIVEKIT_EGRESS_ENABLED !== "1") return undefined;
    const accessKey = process.env.LIVEKIT_EGRESS_S3_ACCESS_KEY?.trim();
    const bucket = process.env.LIVEKIT_EGRESS_S3_BUCKET?.trim();
    const region = process.env.LIVEKIT_EGRESS_S3_REGION?.trim();
    const secret = process.env.LIVEKIT_EGRESS_S3_SECRET_KEY?.trim();
    if (!accessKey || !bucket || !region || !secret) return undefined;
    const rawEndpoint = process.env.LIVEKIT_EGRESS_S3_ENDPOINT?.trim();
    let endpoint = "";
    if (rawEndpoint) {
      try {
        const parsed = new URL(rawEndpoint);
        const local = ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
        const privateSmokeEndpoint = process.env.NODE_ENV === "test"
          && process.env.HAHATALK_TEST_MEDIA_INFRA === "1"
          && deployment === "local"
          && ["minio", "host.docker.internal"].includes(parsed.hostname);
        if (parsed.username || parsed.password) return undefined;
        if (parsed.protocol !== "https:" && !((local || privateSmokeEndpoint) && parsed.protocol === "http:")) {
          return undefined;
        }
        endpoint = parsed.toString().replace(/\/$/, "");
      } catch {
        return undefined;
      }
    }
    const webhookUrl = process.env.HAHATALK_LIVEKIT_WEBHOOK_URL?.trim();
    if (webhookUrl) {
      try {
        const parsed = new URL(webhookUrl);
        const local = ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
        if (parsed.username || parsed.password) return undefined;
        if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) return undefined;
      } catch {
        return undefined;
      }
    }
    return {
      apiKey,
      apiSecret,
      deployment,
      driver: "livekit",
      serviceUrl,
      storage: {
        accessKey,
        bucket,
        endpoint,
        forcePathStyle: process.env.LIVEKIT_EGRESS_S3_FORCE_PATH_STYLE === "1",
        region,
        secret,
        sessionToken: process.env.LIVEKIT_EGRESS_S3_SESSION_TOKEN?.trim() ?? ""
      },
      ...(webhookUrl ? { webhookUrl } : {})
    };
  }
}
