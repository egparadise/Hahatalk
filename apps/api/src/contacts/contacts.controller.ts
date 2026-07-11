import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards
} from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import type {
  ContactCollectionKind,
  ContactCollectionVisibility,
  ContactConsentDecision,
  ContactFollowUpState,
  ContactRosterVisibility
} from "@hahatalk/contracts";
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength
} from "class-validator";
import { CurrentAuth } from "../auth/auth.decorators.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { ContactsService } from "./contacts.service.js";

class CreateCollectionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name = "";

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsIn(["family", "team", "customers", "service", "custom"])
  kind: ContactCollectionKind = "custom";
}

class UpdateCollectionDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

class MemberDetailsDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  label?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(32, { each: true })
  tags?: string[];

  @IsOptional()
  @IsIn(["none", "planned", "waiting", "completed"])
  followUpState?: ContactFollowUpState;

  @IsOptional()
  @IsISO8601()
  followUpAt?: string | null;

  @IsOptional()
  @IsInt()
  @Min(-10_000)
  @Max(10_000)
  sortOrder?: number;
}

class AddMemberDto extends MemberDetailsDto {
  @IsString()
  @MinLength(3)
  @MaxLength(80)
  userId = "";
}

class SetPolicyDto {
  @IsIn(["owner_only", "shared"])
  visibility: ContactCollectionVisibility = "owner_only";

  @IsIn(["shared", "owner_only"])
  rosterVisibility: ContactRosterVisibility = "shared";
}

class ConsentDto {
  @IsInt()
  @Min(1)
  policyVersion = 1;

  @IsIn(["granted", "denied", "revoked"])
  decision: ContactConsentDecision = "granted";
}

@Controller()
@UseGuards(ThrottlerGuard)
export class ContactsController {
  constructor(private readonly contacts: ContactsService) {}

  @Get("contacts")
  dashboard(@CurrentAuth() principal: AuthPrincipal) {
    return this.contacts.dashboard(principal);
  }

  @Post("contact-collections")
  create(@Body() body: CreateCollectionDto, @CurrentAuth() principal: AuthPrincipal) {
    return this.contacts.create(principal, body);
  }

  @Patch("contact-collections/:collectionId")
  update(
    @Param("collectionId", ParseUUIDPipe) collectionId: string,
    @Body() body: UpdateCollectionDto,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.contacts.update(principal, collectionId, body);
  }

  @Delete("contact-collections/:collectionId")
  archive(
    @Param("collectionId", ParseUUIDPipe) collectionId: string,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.contacts.archive(principal, collectionId);
  }

  @Post("contact-collections/:collectionId/members")
  addMember(
    @Param("collectionId", ParseUUIDPipe) collectionId: string,
    @Body() body: AddMemberDto,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.contacts.addMember(principal, collectionId, body);
  }

  @Patch("contact-collections/:collectionId/members/:userId")
  updateMember(
    @Param("collectionId", ParseUUIDPipe) collectionId: string,
    @Param("userId") userId: string,
    @Body() body: MemberDetailsDto,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.contacts.updateMember(principal, collectionId, userId, body);
  }

  @Delete("contact-collections/:collectionId/members/:userId")
  removeMember(
    @Param("collectionId", ParseUUIDPipe) collectionId: string,
    @Param("userId") userId: string,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.contacts.removeMember(principal, collectionId, userId);
  }

  @Post("contact-collections/:collectionId/policy")
  setPolicy(
    @Param("collectionId", ParseUUIDPipe) collectionId: string,
    @Body() body: SetPolicyDto,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.contacts.setPolicy(principal, collectionId, body);
  }

  @Post("contact-collections/:collectionId/consent")
  consent(
    @Param("collectionId", ParseUUIDPipe) collectionId: string,
    @Body() body: ConsentDto,
    @Headers("x-hahatalk-client") clientId: string | undefined,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.contacts.consent(principal, collectionId, body.policyVersion, body.decision, clientId);
  }
}
