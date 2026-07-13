import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { AccessToken, RoomServiceClient, TrackSource } from "livekit-server-sdk";
import type { CallCapabilities, CallType } from "@hahatalk/contracts";

const tokenTtlSeconds = 120;

type LiveKitConfiguration = {
  apiKey: string;
  apiSecret: string;
  clientUrl: string;
  deployment: "local" | "remote";
  serviceUrl: string;
};

@Injectable()
export class LiveKitProviderService {
  capabilities(): CallCapabilities {
    const configuration = this.configuration();
    if (!configuration) {
      return {
        available: false,
        deployment: "unconfigured",
        provider: "livekit",
        reason: "Voice and video calls require a configured LiveKit service.",
        tokenTtlSeconds
      };
    }
    return {
      available: true,
      deployment: configuration.deployment,
      provider: "livekit",
      tokenTtlSeconds
    };
  }

  async createRoom(roomName: string, participantCount: number) {
    const { client } = this.client();
    await client.createRoom({
      departureTimeout: 20,
      emptyTimeout: 120,
      maxParticipants: participantCount,
      name: roomName
    });
  }

  async deleteRoom(roomName: string) {
    const { client } = this.client();
    await client.deleteRoom(roomName);
  }

  async joinCredential(input: {
    callId: string;
    callType: CallType;
    displayName: string;
    identity: string;
    roomName: string;
  }) {
    const configuration = this.requiredConfiguration();
    const expiresAt = new Date(Date.now() + tokenTtlSeconds * 1_000);
    const token = new AccessToken(configuration.apiKey, configuration.apiSecret, {
      identity: input.identity,
      name: input.displayName,
      ttl: tokenTtlSeconds
    });
    token.addGrant({
      canPublish: true,
      canPublishData: false,
      canPublishSources: input.callType === "video"
        ? [TrackSource.MICROPHONE, TrackSource.CAMERA]
        : [TrackSource.MICROPHONE],
      canSubscribe: true,
      canUpdateOwnMetadata: false,
      room: input.roomName,
      roomJoin: true
    });
    return {
      expiresAt,
      serverUrl: configuration.clientUrl,
      token: await token.toJwt()
    };
  }

  private client() {
    const configuration = this.requiredConfiguration();
    return {
      client: new RoomServiceClient(
        configuration.serviceUrl,
        configuration.apiKey,
        configuration.apiSecret,
        { failover: false, requestTimeout: 5 }
      ),
      configuration
    };
  }

  private requiredConfiguration() {
    const configuration = this.configuration();
    if (!configuration) {
      throw new ServiceUnavailableException("Voice and video calls are not configured.");
    }
    return configuration;
  }

  private configuration(): LiveKitConfiguration | undefined {
    const rawUrl = process.env.LIVEKIT_URL?.trim();
    const apiKey = process.env.LIVEKIT_API_KEY?.trim();
    const apiSecret = process.env.LIVEKIT_API_SECRET?.trim();
    if (!rawUrl || !apiKey || !apiSecret) return undefined;

    try {
      const parsed = new URL(rawUrl);
      const local = ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
      if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) return undefined;
      if (!local && !["https:", "wss:"].includes(parsed.protocol)) return undefined;
      const client = new URL(parsed);
      client.protocol = parsed.protocol === "https:" || parsed.protocol === "wss:" ? "wss:" : "ws:";
      const service = new URL(parsed);
      service.protocol = parsed.protocol === "https:" || parsed.protocol === "wss:" ? "https:" : "http:";
      return {
        apiKey,
        apiSecret,
        clientUrl: client.toString().replace(/\/$/, ""),
        deployment: local ? "local" : "remote",
        serviceUrl: service.toString().replace(/\/$/, "")
      };
    } catch {
      return undefined;
    }
  }
}
