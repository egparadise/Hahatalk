import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards
} from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength
} from "class-validator";
import type {
  MobilePlatform,
  MobilePushProvider,
  RegisterMobileDeviceInput
} from "@hahatalk/contracts";
import { CurrentAuth, PublicRoute } from "../auth/auth.decorators.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { MobileService } from "./mobile.service.js";

class RegisterMobileDeviceDto implements RegisterMobileDeviceInput {
  @IsUUID()
  installationId = "";

  @IsIn(["android", "ios"])
  platform: MobilePlatform = "android";

  @IsIn(["expo", "fcm", "apns"])
  pushProvider: MobilePushProvider = "expo";

  @IsString()
  @MinLength(20)
  @MaxLength(4096)
  pushToken = "";

  @IsString()
  @MinLength(1)
  @MaxLength(40)
  appVersion = "";

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  osVersion = "";

  @IsString()
  @MinLength(2)
  @MaxLength(32)
  locale = "ko-KR";

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  timezone = "Asia/Seoul";

  @IsObject()
  capabilities: { notifications: boolean; calls: boolean } = { calls: false, notifications: false };
}

class ClaimMobilePushDto {
  @IsString()
  @MinLength(8)
  @MaxLength(160)
  workerId = "";

  @IsInt()
  @Min(1)
  @Max(50)
  limit = 20;
}

class CompleteMobilePushDto {
  @IsString()
  @MinLength(8)
  @MaxLength(160)
  workerId = "";

  @IsIn(["delivered", "failed"])
  outcome: "delivered" | "failed" = "failed";

  @IsOptional()
  @IsString()
  @MaxLength(240)
  providerMessageId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  errorCode?: string;

  @IsOptional()
  @IsBoolean()
  retryable?: boolean;
}

@Controller("mobile")
@UseGuards(ThrottlerGuard)
export class MobileController {
  constructor(private readonly mobile: MobileService) {}

  @Get("capabilities")
  capabilities(@Query("platform") platform: string | undefined) {
    return this.mobile.capabilities(platform === "android" || platform === "ios" ? platform : "unknown");
  }

  @Get("devices")
  devices(@CurrentAuth() principal: AuthPrincipal) {
    return this.mobile.listDevices(principal);
  }

  @Post("devices")
  register(@Body() body: RegisterMobileDeviceDto, @CurrentAuth() principal: AuthPrincipal) {
    return this.mobile.registerDevice(principal, body);
  }

  @Delete("devices/current")
  revokeCurrent(@CurrentAuth() principal: AuthPrincipal) {
    return this.mobile.revokeCurrentDevice(principal);
  }
}

@PublicRoute()
@Controller("internal/mobile/push")
@UseGuards(ThrottlerGuard)
export class MobilePushWorkerController {
  constructor(private readonly mobile: MobileService) {}

  @Post("claim")
  @HttpCode(HttpStatus.OK)
  claim(
    @Headers("x-hahatalk-mobile-worker-token") workerToken: string | undefined,
    @Body() body: ClaimMobilePushDto
  ) {
    return this.mobile.claimPushJobs(workerToken, body.workerId, body.limit);
  }

  @Post(":jobId/complete")
  @HttpCode(HttpStatus.OK)
  complete(
    @Param("jobId", ParseUUIDPipe) jobId: string,
    @Headers("x-hahatalk-mobile-worker-token") workerToken: string | undefined,
    @Body() body: CompleteMobilePushDto
  ) {
    return this.mobile.completePushJob(workerToken, body.workerId, jobId, body.outcome, body);
  }
}
