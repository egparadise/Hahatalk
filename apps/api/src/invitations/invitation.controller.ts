import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, UseGuards } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import type { ApprovalPolicy } from "@hahatalk/contracts";
import {
  Equals,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength
} from "class-validator";
import { CurrentAuth, PublicRoute } from "../auth/auth.decorators.js";
import { AuthService } from "../auth/auth.service.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { InvitationService } from "./invitation.service.js";

class CreateInvitationDto {
  @IsEmail()
  @MaxLength(254)
  email = "";

  @IsIn(["member", "guest"])
  role: "member" | "guest" = "guest";

  @IsOptional()
  @IsIn(["owner_and_invitee", "admins_and_invitee", "all_members_and_invitee", "quorum_and_invitee"])
  approvalPolicy?: ApprovalPolicy;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  requiredApprovalCount?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(168)
  expiresInHours?: number;
}

class InvitationCodeDto {
  @IsString()
  @MinLength(40)
  @MaxLength(128)
  inviteCode = "";
}

class AcceptInvitationDto extends InvitationCodeDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  displayName?: string;

  @IsOptional()
  @IsString()
  @MinLength(12)
  @MaxLength(128)
  password?: string;

  @IsOptional()
  @IsString()
  characterId?: string;

  @Equals(true)
  acceptTerms = false;

  @Equals(true)
  acceptPrivacy = false;

  @Equals(true)
  acceptGroupJoin = false;
}

class InvitationDecisionDto {
  @IsIn(["approved", "rejected"])
  decision: "approved" | "rejected" = "approved";

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

@Controller("invitations")
@UseGuards(ThrottlerGuard)
export class InvitationController {
  constructor(
    private readonly authService: AuthService,
    private readonly invitationService: InvitationService
  ) {}

  @Get()
  list(@CurrentAuth() principal: AuthPrincipal) {
    return this.invitationService.list(principal);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post()
  create(@Body() body: CreateInvitationDto, @CurrentAuth() principal: AuthPrincipal) {
    return this.invitationService.create(principal, body);
  }

  @PublicRoute()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("preview")
  preview(@Body() body: InvitationCodeDto) {
    return this.invitationService.preview(body.inviteCode);
  }

  @PublicRoute()
  @Throttle({ default: { limit: 8, ttl: 60_000 } })
  @Post("accept")
  async accept(
    @Body() body: AcceptInvitationDto,
    @Headers("cookie") cookieHeader: string | undefined,
    @Headers("user-agent") userAgent: string | undefined
  ) {
    const principal = await this.authService.authenticateCookieHeader(cookieHeader);
    return this.invitationService.accept(body, principal, userAgent);
  }

  @PublicRoute()
  @Throttle({ default: { limit: 8, ttl: 60_000 } })
  @Post("decline")
  decline(@Body() body: InvitationCodeDto) {
    return this.invitationService.decline(body.inviteCode);
  }

  @Post(":invitationId/decision")
  decide(
    @Param("invitationId", new ParseUUIDPipe()) invitationId: string,
    @Body() body: InvitationDecisionDto,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.invitationService.decide(principal, invitationId, body.decision, body.note);
  }

  @Post(":invitationId/revoke")
  revoke(
    @Param("invitationId", new ParseUUIDPipe()) invitationId: string,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.invitationService.revoke(principal, invitationId);
  }
}
