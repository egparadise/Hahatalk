import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards
} from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested
} from "class-validator";
import type {
  CallType,
  MeetingRoleAssignment,
  ScheduleMeetingInput
} from "@hahatalk/contracts";
import { CurrentAuth } from "../auth/auth.decorators.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { MeetingsService } from "./meetings.service.js";

const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

class MeetingRoleAssignmentDto implements MeetingRoleAssignment {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  userId = "";

  @IsIn(["cohost", "speaker", "attendee"])
  role: MeetingRoleAssignment["role"] = "attendee";
}

class ScheduleMeetingDto implements ScheduleMeetingInput {
  @IsString()
  @MinLength(8)
  @MaxLength(160)
  clientMeetingId = "";

  @IsUUID()
  eventId = "";

  @Matches(instantPattern)
  occurrenceStartsAt = "";

  @IsIn(["voice", "video"])
  callType: CallType = "video";

  @IsArray()
  @ArrayMaxSize(49)
  @ValidateNested({ each: true })
  @Type(() => MeetingRoleAssignmentDto)
  roleAssignments: MeetingRoleAssignmentDto[] = [];
}

class VersionDto {
  @IsInt()
  @Min(1)
  version = 1;
}

class MeetingRoleDto extends VersionDto {
  @IsIn(["cohost", "speaker", "attendee"])
  role: MeetingRoleAssignment["role"] = "attendee";
}

@Controller("meetings")
@UseGuards(ThrottlerGuard)
export class MeetingsController {
  constructor(private readonly meetings: MeetingsService) {}

  @Get("capabilities")
  capabilities() {
    return this.meetings.capabilities();
  }

  @Get()
  occurrence(
    @Query("eventId", ParseUUIDPipe) eventId: string,
    @Query("occurrenceStartsAt") occurrenceStartsAt: string,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.meetings.forOccurrence(principal, eventId, occurrenceStartsAt);
  }

  @Post()
  schedule(@Body() body: ScheduleMeetingDto, @CurrentAuth() principal: AuthPrincipal) {
    return this.meetings.schedule(principal, body);
  }

  @Get(":meetingId")
  get(@Param("meetingId", ParseUUIDPipe) meetingId: string, @CurrentAuth() principal: AuthPrincipal) {
    return this.meetings.get(principal, meetingId);
  }

  @Post(":meetingId/open")
  @HttpCode(HttpStatus.OK)
  open(
    @Param("meetingId", ParseUUIDPipe) meetingId: string,
    @Body() body: VersionDto,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.meetings.open(principal, meetingId, body.version);
  }

  @Post(":meetingId/enter")
  @HttpCode(HttpStatus.OK)
  enter(@Param("meetingId", ParseUUIDPipe) meetingId: string, @CurrentAuth() principal: AuthPrincipal) {
    return this.meetings.enter(principal, meetingId);
  }

  @Post(":meetingId/participants/:userId/admit")
  @HttpCode(HttpStatus.OK)
  admit(
    @Param("meetingId", ParseUUIDPipe) meetingId: string,
    @Param("userId") userId: string,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.meetings.moderate(principal, meetingId, userId, "admit");
  }

  @Post(":meetingId/participants/:userId/deny")
  @HttpCode(HttpStatus.OK)
  deny(
    @Param("meetingId", ParseUUIDPipe) meetingId: string,
    @Param("userId") userId: string,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.meetings.moderate(principal, meetingId, userId, "deny");
  }

  @Patch(":meetingId/participants/:userId/role")
  role(
    @Param("meetingId", ParseUUIDPipe) meetingId: string,
    @Param("userId") userId: string,
    @Body() body: MeetingRoleDto,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.meetings.changeRole(principal, meetingId, userId, body.role, body.version);
  }

  @Post(":meetingId/join")
  @HttpCode(HttpStatus.OK)
  join(@Param("meetingId", ParseUUIDPipe) meetingId: string, @CurrentAuth() principal: AuthPrincipal) {
    return this.meetings.join(principal, meetingId);
  }

  @Post(":meetingId/connected")
  @HttpCode(HttpStatus.OK)
  connected(@Param("meetingId", ParseUUIDPipe) meetingId: string, @CurrentAuth() principal: AuthPrincipal) {
    return this.meetings.connected(principal, meetingId);
  }

  @Post(":meetingId/leave")
  @HttpCode(HttpStatus.OK)
  leave(@Param("meetingId", ParseUUIDPipe) meetingId: string, @CurrentAuth() principal: AuthPrincipal) {
    return this.meetings.leave(principal, meetingId);
  }

  @Post(":meetingId/end")
  @HttpCode(HttpStatus.OK)
  end(
    @Param("meetingId", ParseUUIDPipe) meetingId: string,
    @Body() body: VersionDto,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.meetings.end(principal, meetingId, body.version);
  }
}
