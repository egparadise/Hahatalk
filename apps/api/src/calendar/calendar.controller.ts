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
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested
} from "class-validator";
import type {
  CalendarEventVisibility,
  CalendarRecurrence,
  CalendarRecurrenceFrequency,
  CalendarResponseStatus,
  CalendarWeekday,
  CreateCalendarEventInput,
  UpdateCalendarEventInput
} from "@hahatalk/contracts";
import { CurrentAuth } from "../auth/auth.decorators.js";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { CalendarService } from "./calendar.service.js";

class RecurrenceDto implements CalendarRecurrence {
  @IsIn(["daily", "weekly", "monthly"])
  frequency: CalendarRecurrenceFrequency = "weekly";

  @IsInt()
  @Min(1)
  @Max(12)
  interval = 1;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(7, { each: true })
  weekdays?: CalendarWeekday[];

  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(366)
  count?: number;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  untilLocalDate?: string;
}
class CreateEventDto implements CreateCalendarEventInput {
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  title = "";

  @IsOptional()
  @IsString()
  @MaxLength(4_000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  location?: string;

  @IsIn(["private", "attendees", "space"])
  visibility: CalendarEventVisibility = "private";

  @IsOptional()
  @IsUUID()
  spaceId?: string;

  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  attendeeIds: string[] = [];

  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/)
  startsLocal = "";

  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/)
  endsLocal = "";

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  timezone = "Asia/Seoul";

  @IsBoolean()
  allDay = false;

  @IsOptional()
  @ValidateNested()
  @Type(() => RecurrenceDto)
  recurrence?: RecurrenceDto;

  @IsArray()
  @ArrayMaxSize(5)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(10_080, { each: true })
  reminderOffsetsMinutes: number[] = [];
}

class UpdateEventDto extends CreateEventDto implements UpdateCalendarEventInput {
  @IsInt()
  @Min(1)
  version = 1;
}

class CancelEventDto {
  @IsInt()
  @Min(1)
  version = 1;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

class RespondEventDto {
  @IsIn(["accepted", "declined", "tentative"])
  response: Exclude<CalendarResponseStatus, "needs_action"> = "accepted";
}

class DismissReminderDto {
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/)
  occurrenceStartsAt = "";
}

@Controller("calendar")
@UseGuards(ThrottlerGuard)
export class CalendarController {
  constructor(private readonly calendar: CalendarService) {}

  @Get("context")
  context(@CurrentAuth() principal: AuthPrincipal) {
    return this.calendar.context(principal);
  }

  @Get("events")
  events(
    @Query("from") from: string | undefined,
    @Query("to") to: string | undefined,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.calendar.window(principal, from, to);
  }

  @Post("events")
  create(@Body() body: CreateEventDto, @CurrentAuth() principal: AuthPrincipal) {
    return this.calendar.create(principal, body);
  }

  @Patch("events/:eventId")
  update(
    @Param("eventId", ParseUUIDPipe) eventId: string,
    @Body() body: UpdateEventDto,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.calendar.update(principal, eventId, body);
  }

  @Post("events/:eventId/cancel")
  @HttpCode(HttpStatus.OK)
  cancel(
    @Param("eventId", ParseUUIDPipe) eventId: string,
    @Body() body: CancelEventDto,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.calendar.cancel(principal, eventId, body.version, body.reason);
  }

  @Post("events/:eventId/rsvp")
  @HttpCode(HttpStatus.OK)
  respond(
    @Param("eventId", ParseUUIDPipe) eventId: string,
    @Body() body: RespondEventDto,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.calendar.respond(principal, eventId, body.response);
  }

  @Post("events/:eventId/reminders/:reminderId/dismiss")
  @HttpCode(HttpStatus.OK)
  dismissReminder(
    @Param("eventId", ParseUUIDPipe) eventId: string,
    @Param("reminderId", ParseUUIDPipe) reminderId: string,
    @Body() body: DismissReminderDto,
    @CurrentAuth() principal: AuthPrincipal
  ) {
    return this.calendar.dismissReminder(principal, eventId, reminderId, body.occurrenceStartsAt);
  }
}
