import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { AccessToken, RoomServiceClient, TrackSource } from "livekit-server-sdk";
import type { CallCapabilities, CallType } from "@hahatalk/contracts";
import { LiveKitEgressProviderService } from "../recordings/livekit-egress-provider.service.js";

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
  constructor(private readonly egress: LiveKitEgressProviderService) {}

  capabilities(): CallCapabilities {
    const configuration = this.configuration();
    if (!configuration) {
      return {
        available: false,
        deployment: "unconfigured",
        provider: "livekit",
        recording: this.egress.capabilities(),
        reason: "Voice and video calls require a configured LiveKit service.",
        tokenTtlSeconds
      };
    }
    return {
      available: true,
      deployment: configuration.deployment,
      provider: "livekit",
      recording: this.egress.capabilities(),
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

  async ensureRoom(roomName: string, participantCount: number) {
    const { client } = this.client();
    const rooms = await client.listRooms([roomName]);
    if (rooms.some((room) => room.name === roomName)) return;
    await this.createRoom(roomName, participantCount);
  }

  async deleteRoom(roomName: string) {
    const { client } = this.client();
    await client.deleteRoom(roomName);
  }

  async removeParticipant(roomName: string, identity: string) {
    const { client } = this.client();
    await client.removeParticipant(roomName, identity);
  }

  async updateParticipantPermissions(
    roomName: string,
    identity: string,
    canPublishAudio: boolean,
    canPublishVideo: boolean,
    canShareScreen = false,
    hidden = false
  ) {
    const { client } = this.client();
    const sources = [
      ...(canPublishAudio ? [TrackSource.MICROPHONE] : []),
      ...(canPublishVideo ? [TrackSource.CAMERA] : []),
      ...(canShareScreen ? [TrackSource.SCREEN_SHARE] : [])
    ];
    await client.updateParticipant(roomName, identity, {
      permission: {
        canPublish: sources.length > 0,
        canPublishData: false,
        canPublishSources: sources,
        canSubscribe: true,
        canUpdateMetadata: false,
        hidden
      }
    });
  }

  async joinCredential(input: {
    callId: string;
    callType: CallType;
    canPublishAudio?: boolean;
    canPublishVideo?: boolean;
    displayName: string;
    hidden?: boolean;
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
    const canPublishAudio = input.canPublishAudio ?? true;
    const canPublishVideo = input.canPublishVideo ?? input.callType === "video";
    const sources = [
      ...(canPublishAudio ? [TrackSource.MICROPHONE] : []),
      ...(canPublishVideo ? [TrackSource.CAMERA] : [])
    ];
    token.addGrant({
      canPublish: sources.length > 0,
      canPublishData: false,
      ...(sources.length ? { canPublishSources: sources } : {}),
      canSubscribe: true,
      canUpdateOwnMetadata: false,
      hidden: input.hidden === true,
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
      if (parsed.username || parsed.password) return undefined;
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
