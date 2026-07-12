import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import {
  findCharacterPreset,
  type CalendarAttendeeCounts,
  type CalendarAttendeeView,
  type CalendarContext,
  type CalendarEventView,
  type CalendarOccurrenceView,
  type CalendarPerson,
  type CalendarRecurrence,
  type CalendarReminderView,
  type CalendarResponseStatus,
  type CalendarSpaceOption,
  type CalendarWindowView,
  type ConversationType,
  type CreateCalendarEventInput,
  type MemberRole,
  type RoomPresentationMode,
  type UpdateCalendarEventInput
} from "@hahatalk/contracts";
import type { PoolClient } from "pg";
import type { AuthPrincipal } from "../auth/auth.types.js";
import { DatabaseService } from "../database/database.service.js";
import {
  canonicalRecurrenceRule,
  localDateTimeToPseudoUtc,
  normalizeLocalDateTime,
  normalizeRecurrence,
  parseStoredRecurrence,
  recurrenceLocalStarts
} from "./calendar-recurrence.js";

type EventRow = {
  all_day: boolean;
  cancellation_reason: string | null;
  cancelled_at: Date | null;
  created_at: Date;
  created_by: string;
  creator_character_id: string | null;
  creator_display_name: string;
  creator_public_id: string;
  creator_role: MemberRole;
  description: string;
  ends_at: Date;
  ends_local_text: string;
  id: string;
  location: string;
  organization_id: string;
  recurrence_ends_at: Date | null;
  recurrence_json: unknown;
  recurrence_rule: string | null;
  space_id: string | null;
  space_name: string | null;
  space_owner_display_name: string | null;
  space_owner_id: string | null;
  space_type: ConversationType | null;
  starts_at: Date;
  starts_local_text: string;
  status: "scheduled" | "cancelled";
  timezone: string;
  title: string;
  updated_at: Date;
  version: number;
  viewer_response: CalendarResponseStatus | null;
  visibility: "private" | "attendees" | "space";
};

type SpaceRow = {
  id: string;
  name: string;
  owner_character_id: string | null;
  owner_display_name: string;
  owner_id: string;
  owner_public_id: string;
  owner_role: MemberRole;
  type: ConversationType;
  viewer_role: MemberRole;
};

type SpacePersonRow = {
  character_id: string | null;
  display_name: string;
  internal_user_id: string;
  public_id: string;
  role: MemberRole;
};

type OccurrenceInstant = {
  ends_at: Date;
  ends_local_text: string;
  starts_at: Date;
  starts_local_text: string;
  valid: boolean;
};

type PreparedEvent = {
  allDay: boolean;
  attendeeInternalIds: string[];
  description: string;
  endsAt: Date;
  endsLocal: string;
  invitationSource: "explicit" | "space_snapshot";
  location: string;
  recurrence?: CalendarRecurrence;
  recurrenceEndsAt?: Date;
  recurrenceRule?: string;
  reminderOffsetsMinutes: number[];
  spaceId?: string;
  startsAt: Date;
  startsLocal: string;
  timezone: string;
  title: string;
  visibility: "private" | "attendees" | "space";
};

type ReminderRow = { id: string; offset_minutes: number };

const maximumWindowMilliseconds = 93 * 86_400_000;
const maximumDurationMilliseconds = 31 * 86_400_000;
const maximumWindowOccurrences = 500;

@Injectable()
export class CalendarService {
  constructor(private readonly database: DatabaseService) {}

  context(principal: AuthPrincipal): Promise<CalendarContext> {
    return this.database.transaction(async (client) => {
      const role = await this.activeRole(client, principal);
      const timezoneResult = await client.query<{ timezone: string }>(
        "select timezone from users where id = $1",
        [principal.internalUserId]
      );
      const spaces = await client.query<SpaceRow>(
        `select
           s.id, s.type, s.name, s.owner_id,
           owner_user.public_id as owner_public_id,
           owner_user.display_name as owner_display_name,
           owner_membership.role as owner_role,
           owner_profile.public_profile_json ->> 'characterId' as owner_character_id,
           viewer_membership.role as viewer_role
         from conversation_spaces s
         join space_memberships viewer_membership
           on viewer_membership.space_id = s.id
          and viewer_membership.user_id = $1
          and viewer_membership.status in ('active', 'muted')
         join users owner_user on owner_user.id = s.owner_id
         join organization_memberships owner_membership
           on owner_membership.organization_id = s.organization_id
          and owner_membership.user_id = s.owner_id
         left join profiles owner_profile on owner_profile.user_id = owner_user.id
         where s.organization_id = $2 and s.archived_at is null
         order by s.updated_at desc, s.created_at asc`,
        [principal.internalUserId, principal.state.user.organizationId]
      );
      const options: CalendarSpaceOption[] = [];
      for (const space of spaces.rows) {
        const personRows = role === "guest" || role === "subscriber"
          ? []
          : await this.visibleSpacePeople(client, principal, space);
        options.push({
          canInviteAll: personRows.length > 0 && this.canInviteWholeSpace(principal, role, space),
          id: space.id,
          mode: this.spaceMode(space, principal.internalUserId),
          people: personRows.map((person) => this.calendarPerson(person)),
          title: this.spaceTitle(space, principal.internalUserId, personRows)
        });
      }
      return {
        defaultTimezone: timezoneResult.rows[0]?.timezone ?? "Asia/Seoul",
        spaces: options
      };
    });
  }

  window(principal: AuthPrincipal, rawFrom?: string, rawTo?: string): Promise<CalendarWindowView> {
    const { from, to } = this.windowBounds(rawFrom, rawTo);
    return this.database.transaction(async (client) => {
      await this.activeRole(client, principal);
      const result = await client.query<EventRow>(
        `${this.eventSelect()}
         where e.organization_id = $1
           and (e.created_by = $2 or viewer_attendee.user_id = $2)
           and e.starts_at < $4
           and coalesce(e.recurrence_ends_at, e.ends_at) > $3
         order by e.starts_at, e.id`,
        [principal.state.user.organizationId, principal.internalUserId, from, to]
      );

      const occurrences: CalendarOccurrenceView[] = [];
      const reminderCandidates: Array<{
        creatorDisplayName: string;
        eventId: string;
        occurrenceEndsAt: Date;
        occurrenceKey: string;
        occurrenceStartsAt: Date;
        reminder: ReminderRow;
        title: string;
      }> = [];
      for (const row of result.rows) {
        const event = await this.projectEvent(client, principal, row);
        const recurrence = parseStoredRecurrence(row.recurrence_json);
        const localStarts = recurrenceLocalStarts(row.starts_local_text, recurrence);
        const durationSeconds = this.durationSeconds(row.starts_local_text, row.ends_local_text);
        const instants = await this.occurrenceInstants(client, localStarts, durationSeconds, row.timezone);
        const reminders = row.status === "scheduled" ? await this.reminderRows(client, row.id) : [];
        for (const instant of instants) {
          if (!instant.valid || instant.ends_at <= from || instant.starts_at >= to) continue;
          const occurrenceKey = this.occurrenceKey(row.id, instant.starts_at);
          occurrences.push({
            ...event,
            occurrenceEndsAt: instant.ends_at.toISOString(),
            occurrenceEndsLocal: instant.ends_local_text,
            occurrenceKey,
            occurrenceStartsAt: instant.starts_at.toISOString(),
            occurrenceStartsLocal: instant.starts_local_text
          });
          for (const reminder of reminders) {
            reminderCandidates.push({
              creatorDisplayName: row.creator_display_name,
              eventId: row.id,
              occurrenceEndsAt: instant.ends_at,
              occurrenceKey,
              occurrenceStartsAt: instant.starts_at,
              reminder,
              title: row.title
            });
          }
        }
      }

      if (occurrences.length > maximumWindowOccurrences) {
        throw new BadRequestException("Calendar window contains too many occurrences. Choose a shorter range.");
      }
      occurrences.sort((left, right) => (
        left.occurrenceStartsAt.localeCompare(right.occurrenceStartsAt)
        || left.id.localeCompare(right.id)
      ));
      const reminders = await this.pendingReminders(client, principal, reminderCandidates);
      return { from: from.toISOString(), occurrences, reminders, to: to.toISOString() };
    });
  }

  create(principal: AuthPrincipal, input: CreateCalendarEventInput): Promise<CalendarEventView> {
    return this.database.transaction(async (client) => {
      const prepared = await this.prepareEvent(client, principal, input);
      const inserted = await client.query<{ id: string }>(
        `insert into events (
           organization_id, space_id, created_by, title, description, location, visibility,
           starts_local, ends_local, starts_at, ends_at, timezone, all_day,
           recurrence_rule, recurrence_json, recurrence_ends_at
         ) values (
           $1, $2, $3, $4, $5, $6, $7,
           $8::timestamp, $9::timestamp, $10, $11, $12, $13,
           $14, $15::jsonb, $16
         ) returning id`,
        [
          principal.state.user.organizationId,
          prepared.spaceId ?? null,
          principal.internalUserId,
          prepared.title,
          prepared.description,
          prepared.location,
          prepared.visibility,
          prepared.startsLocal,
          prepared.endsLocal,
          prepared.startsAt,
          prepared.endsAt,
          prepared.timezone,
          prepared.allDay,
          prepared.recurrenceRule ?? null,
          JSON.stringify(prepared.recurrence ?? {}),
          prepared.recurrenceEndsAt ?? null
        ]
      );
      const eventId = inserted.rows[0]!.id;
      await this.replaceAttendees(client, principal, eventId, prepared, false);
      await this.replaceReminders(client, eventId, prepared.reminderOffsetsMinutes);
      await this.writeAudit(client, principal, "calendar.event_created", eventId, {
        attendeeCount: prepared.attendeeInternalIds.length,
        recurring: Boolean(prepared.recurrence),
        visibility: prepared.visibility
      });
      return this.projectEvent(client, principal, await this.loadEvent(client, principal, eventId));
    });
  }

  update(
    principal: AuthPrincipal,
    eventId: string,
    input: UpdateCalendarEventInput
  ): Promise<CalendarEventView> {
    return this.database.transaction(async (client) => {
      const current = await this.loadEvent(client, principal, eventId, true);
      this.assertCreator(principal, current);
      if (current.status !== "scheduled") throw new ConflictException("Cancelled events cannot be edited.");
      if (current.version !== input.version) {
        throw new ConflictException("This event changed in another window. Refresh before saving again.");
      }
      const prepared = await this.prepareEvent(client, principal, input);
      const updated = await client.query<{ version: number }>(
        `update events set
           space_id = $3, title = $4, description = $5, location = $6, visibility = $7,
           starts_local = $8::timestamp, ends_local = $9::timestamp,
           starts_at = $10, ends_at = $11, timezone = $12, all_day = $13,
           recurrence_rule = $14, recurrence_json = $15::jsonb, recurrence_ends_at = $16,
           version = version + 1, updated_at = now()
         where id = $1 and created_by = $2 and version = $17 and status = 'scheduled'
         returning version`,
        [
          eventId,
          principal.internalUserId,
          prepared.spaceId ?? null,
          prepared.title,
          prepared.description,
          prepared.location,
          prepared.visibility,
          prepared.startsLocal,
          prepared.endsLocal,
          prepared.startsAt,
          prepared.endsAt,
          prepared.timezone,
          prepared.allDay,
          prepared.recurrenceRule ?? null,
          JSON.stringify(prepared.recurrence ?? {}),
          prepared.recurrenceEndsAt ?? null,
          input.version
        ]
      );
      if (!updated.rowCount) throw new ConflictException("Event update lost an optimistic version race.");
      await this.replaceAttendees(client, principal, eventId, prepared, true);
      await this.replaceReminders(client, eventId, prepared.reminderOffsetsMinutes);
      await this.writeAudit(client, principal, "calendar.event_updated", eventId, {
        attendeeCount: prepared.attendeeInternalIds.length,
        fromVersion: input.version,
        toVersion: updated.rows[0]!.version,
        visibility: prepared.visibility
      });
      return this.projectEvent(client, principal, await this.loadEvent(client, principal, eventId));
    });
  }

  cancel(
    principal: AuthPrincipal,
    eventId: string,
    version: number,
    rawReason?: string
  ): Promise<CalendarEventView> {
    return this.database.transaction(async (client) => {
      const current = await this.loadEvent(client, principal, eventId, true);
      this.assertCreator(principal, current);
      if (current.status !== "scheduled") throw new ConflictException("This event is already cancelled.");
      if (current.version !== version) {
        throw new ConflictException("This event changed in another window. Refresh before cancelling.");
      }
      const reason = rawReason?.trim() || null;
      const updated = await client.query(
        `update events set
           status = 'cancelled', cancellation_reason = $3, cancelled_at = now(),
           version = version + 1, updated_at = now()
         where id = $1 and created_by = $2 and version = $4 and status = 'scheduled'`,
        [eventId, principal.internalUserId, reason, version]
      );
      if (!updated.rowCount) throw new ConflictException("Event cancellation lost an optimistic version race.");
      await this.writeAudit(client, principal, "calendar.event_cancelled", eventId, {
        fromVersion: version,
        reasonProvided: Boolean(reason)
      });
      return this.projectEvent(client, principal, await this.loadEvent(client, principal, eventId));
    });
  }

  respond(
    principal: AuthPrincipal,
    eventId: string,
    response: Exclude<CalendarResponseStatus, "needs_action">
  ): Promise<CalendarEventView> {
    return this.database.transaction(async (client) => {
      const event = await this.loadEvent(client, principal, eventId, true);
      if (event.created_by === principal.internalUserId || !event.viewer_response) {
        throw new ForbiddenException("Only an invited attendee can respond to this event.");
      }
      if (event.status !== "scheduled") throw new ConflictException("Cancelled events no longer accept responses.");
      await client.query(
        `update event_attendees set response_status = $3, responded_at = now()
         where event_id = $1 and user_id = $2 and revoked_at is null`,
        [eventId, principal.internalUserId, response]
      );
      await this.writeAudit(client, principal, "calendar.event_rsvp", eventId, { response });
      return this.projectEvent(client, principal, await this.loadEvent(client, principal, eventId));
    });
  }

  dismissReminder(
    principal: AuthPrincipal,
    eventId: string,
    reminderId: string,
    rawOccurrenceStartsAt: string
  ) {
    const requestedOccurrence = this.parseInstant(rawOccurrenceStartsAt, "Reminder occurrence");
    return this.database.transaction(async (client) => {
      const event = await this.loadEvent(client, principal, eventId, true);
      if (event.status !== "scheduled") throw new ConflictException("Cancelled event reminders cannot be changed.");
      const reminderResult = await client.query<ReminderRow>(
        "select id, offset_minutes from event_reminders where id = $1 and event_id = $2",
        [reminderId, eventId]
      );
      const reminder = reminderResult.rows[0];
      if (!reminder) throw new NotFoundException("Reminder not found.");
      const recurrence = parseStoredRecurrence(event.recurrence_json);
      const instants = await this.occurrenceInstants(
        client,
        recurrenceLocalStarts(event.starts_local_text, recurrence),
        this.durationSeconds(event.starts_local_text, event.ends_local_text),
        event.timezone
      );
      const occurrence = instants.find((item) => item.valid && item.starts_at.getTime() === requestedOccurrence.getTime());
      if (!occurrence) throw new BadRequestException("Reminder occurrence does not belong to this event series.");
      const triggerAt = new Date(occurrence.starts_at.getTime() - reminder.offset_minutes * 60_000);
      const receipt = await client.query<{ dismissed_at: Date }>(
        `insert into event_reminder_receipts (
           reminder_id, user_id, occurrence_start_at, trigger_at, status, dismissed_at
         ) values ($1, $2, $3, $4, 'dismissed', now())
         on conflict (reminder_id, user_id, occurrence_start_at) do update set
           trigger_at = excluded.trigger_at, status = 'dismissed', dismissed_at = now(), updated_at = now()
         returning dismissed_at`,
        [reminderId, principal.internalUserId, occurrence.starts_at, triggerAt]
      );
      await this.writeAudit(client, principal, "calendar.reminder_dismissed", eventId, {
        offsetMinutes: reminder.offset_minutes,
        occurrenceStartsAt: occurrence.starts_at.toISOString()
      });
      return { dismissedAt: receipt.rows[0]!.dismissed_at.toISOString(), status: "dismissed" as const };
    });
  }

  private async prepareEvent(
    client: PoolClient,
    principal: AuthPrincipal,
    input: CreateCalendarEventInput
  ): Promise<PreparedEvent> {
    const role = await this.activeRole(client, principal);
    const title = input.title.trim();
    if (!title) throw new BadRequestException("Event title is required.");
    const startsLocal = normalizeLocalDateTime(input.startsLocal, "Event start");
    const endsLocal = normalizeLocalDateTime(input.endsLocal, "Event end");
    const durationSeconds = this.durationSeconds(startsLocal, endsLocal);
    if (durationSeconds <= 0 || durationSeconds * 1_000 > maximumDurationMilliseconds) {
      throw new BadRequestException("Event end must be after its start and within 31 days.");
    }
    if (input.allDay && (!startsLocal.endsWith("T00:00:00") || !endsLocal.endsWith("T00:00:00"))) {
      throw new BadRequestException("All-day events must start and end at local midnight.");
    }
    const timezone = input.timezone.trim();
    await this.assertTimezone(client, timezone);
    const recurrence = normalizeRecurrence(input.recurrence, startsLocal);
    const localStarts = recurrenceLocalStarts(startsLocal, recurrence);
    const instants = await this.occurrenceInstants(client, localStarts, durationSeconds, timezone);
    const validInstants = instants.filter((instant) => instant.valid);
    if (!validInstants[0] || validInstants[0].starts_local_text !== startsLocal) {
      throw new BadRequestException("Event start or end falls in a nonexistent local timezone interval.");
    }
    const first = validInstants[0];
    const recurrenceUntil = recurrence?.untilLocalDate
      ? await this.localInstant(client, `${recurrence.untilLocalDate}T23:59:59`, timezone)
      : undefined;
    const recurrenceRule = recurrence
      ? canonicalRecurrenceRule(recurrence, recurrenceUntil)
      : undefined;
    const audience = await this.resolveAudience(client, principal, role, input);
    const reminderOffsetsMinutes = [...new Set(input.reminderOffsetsMinutes)].sort((left, right) => left - right);
    return {
      allDay: input.allDay,
      attendeeInternalIds: audience.attendeeInternalIds,
      description: input.description?.trim() ?? "",
      endsAt: first.ends_at,
      endsLocal,
      invitationSource: audience.invitationSource,
      location: input.location?.trim() ?? "",
      ...(recurrence ? { recurrence } : {}),
      ...(recurrence ? { recurrenceEndsAt: validInstants.at(-1)!.ends_at } : {}),
      ...(recurrenceRule ? { recurrenceRule } : {}),
      reminderOffsetsMinutes,
      ...(audience.spaceId ? { spaceId: audience.spaceId } : {}),
      startsAt: first.starts_at,
      startsLocal,
      timezone,
      title,
      visibility: input.visibility
    };
  }

  private async resolveAudience(
    client: PoolClient,
    principal: AuthPrincipal,
    role: MemberRole,
    input: CreateCalendarEventInput
  ) {
    if (input.visibility === "private") {
      if (input.spaceId || input.attendeeIds.length) {
        throw new BadRequestException("Private events cannot include a conversation or attendees.");
      }
      return {
        attendeeInternalIds: [] as string[],
        invitationSource: "explicit" as const
      };
    }
    if (role === "guest" || role === "subscriber") {
      throw new ForbiddenException("Guest accounts can create private events only.");
    }
    if (!input.spaceId) throw new BadRequestException("Shared events require a conversation context.");
    const space = await this.spaceForViewer(client, principal, input.spaceId);
    const visiblePeople = await this.visibleSpacePeople(client, principal, space);
    const allowed = new Map(visiblePeople.map((person) => [person.public_id, person.internal_user_id]));
    let publicIds: string[];
    let invitationSource: "explicit" | "space_snapshot";
    if (input.visibility === "space") {
      if (input.attendeeIds.length) throw new BadRequestException("Whole-space events do not accept selected attendee IDs.");
      if (!this.canInviteWholeSpace(principal, role, space)) {
        throw new ForbiddenException("This conversation view cannot invite the whole room.");
      }
      publicIds = [...allowed.keys()];
      invitationSource = "space_snapshot";
    } else {
      publicIds = [...new Set(input.attendeeIds)];
      if (publicIds.length === 0) throw new BadRequestException("Select at least one attendee.");
      invitationSource = "explicit";
    }
    if (publicIds.length > 500) throw new BadRequestException("An event cannot invite more than 500 people.");
    const unknown = publicIds.filter((publicId) => !allowed.has(publicId));
    if (unknown.length) throw new ForbiddenException("One or more attendees are outside your visible conversation audience.");
    const attendeeInternalIds = publicIds.map((publicId) => allowed.get(publicId)!);
    if (!attendeeInternalIds.length) throw new BadRequestException("This conversation has no eligible event attendees.");
    return { attendeeInternalIds, invitationSource, spaceId: space.id };
  }

  private async replaceAttendees(
    client: PoolClient,
    principal: AuthPrincipal,
    eventId: string,
    prepared: PreparedEvent,
    revokeMissing: boolean
  ) {
    if (revokeMissing) {
      await client.query(
        `update event_attendees set revoked_at = now()
         where event_id = $1 and revoked_at is null and not (user_id = any($2::uuid[]))`,
        [eventId, prepared.attendeeInternalIds]
      );
    }
    for (const attendeeId of prepared.attendeeInternalIds) {
      await client.query(
        `insert into event_attendees (
           event_id, user_id, invited_by, invitation_source
         ) values ($1, $2, $3, $4)
         on conflict (event_id, user_id) do update set
           invited_by = excluded.invited_by,
           invitation_source = excluded.invitation_source,
           invited_at = case when event_attendees.revoked_at is not null then now() else event_attendees.invited_at end,
           response_status = case when event_attendees.revoked_at is not null then 'needs_action' else event_attendees.response_status end,
           responded_at = case when event_attendees.revoked_at is not null then null else event_attendees.responded_at end,
           revoked_at = null`,
        [eventId, attendeeId, principal.internalUserId, prepared.invitationSource]
      );
    }
  }

  private async replaceReminders(client: PoolClient, eventId: string, offsets: number[]) {
    await client.query("delete from event_reminders where event_id = $1", [eventId]);
    for (const offset of offsets) {
      await client.query(
        "insert into event_reminders (event_id, offset_minutes) values ($1, $2)",
        [eventId, offset]
      );
    }
  }

  private async projectEvent(client: PoolClient, principal: AuthPrincipal, row: EventRow): Promise<CalendarEventView> {
    const isCreator = row.created_by === principal.internalUserId;
    const recurrence = parseStoredRecurrence(row.recurrence_json);
    const creator: CalendarPerson = {
      character: findCharacterPreset(row.creator_character_id ?? ""),
      displayName: row.creator_display_name,
      id: row.creator_public_id,
      role: row.creator_role
    };
    const base: CalendarEventView = {
      allDay: row.all_day,
      canCancel: isCreator && row.status === "scheduled",
      canEdit: isCreator && row.status === "scheduled",
      canRespond: !isCreator && Boolean(row.viewer_response) && row.status === "scheduled",
      createdAt: row.created_at.toISOString(),
      creator,
      description: row.description,
      endsAt: row.ends_at.toISOString(),
      endsLocal: row.ends_local_text,
      id: row.id,
      isCreator,
      location: row.location,
      ...(row.viewer_response ? { myResponse: row.viewer_response } : {}),
      ...(recurrence ? { recurrence } : {}),
      startsAt: row.starts_at.toISOString(),
      startsLocal: row.starts_local_text,
      status: row.status,
      timezone: row.timezone,
      title: row.title,
      updatedAt: row.updated_at.toISOString(),
      version: row.version,
      visibility: row.visibility,
      ...(row.cancelled_at ? { cancelledAt: row.cancelled_at.toISOString() } : {}),
      ...(row.cancellation_reason ? { cancellationReason: row.cancellation_reason } : {})
    };
    if (!isCreator) return base;

    const attendees = await this.attendeeViews(client, row);
    const reminderOffsetsMinutes = (await this.reminderRows(client, row.id)).map((item) => item.offset_minutes);
    return {
      ...base,
      attendeeCounts: this.attendeeCounts(attendees),
      attendees,
      reminderOffsetsMinutes,
      ...(row.space_id && row.space_name && row.space_type
        ? {
            space: {
              id: row.space_id,
              mode: this.eventSpaceMode(row),
              title: row.space_type === "hub" && row.created_by !== row.space_owner_id
                ? row.space_owner_display_name ?? row.creator_display_name
                : row.space_name
            }
          }
        : {})
    };
  }

  private async attendeeViews(client: PoolClient, event: EventRow): Promise<CalendarAttendeeView[]> {
    const result = await client.query<SpacePersonRow & {
      responded_at: Date | null;
      response_status: CalendarResponseStatus;
    }>(
      `select
         attendee_user.id as internal_user_id,
         attendee_user.public_id,
         attendee_user.display_name,
         attendee_membership.role,
         attendee_profile.public_profile_json ->> 'characterId' as character_id,
         attendee.response_status,
         attendee.responded_at
       from event_attendees attendee
       join users attendee_user on attendee_user.id = attendee.user_id
       join organization_memberships attendee_membership
         on attendee_membership.organization_id = $2
        and attendee_membership.user_id = attendee.user_id
       left join profiles attendee_profile on attendee_profile.user_id = attendee.user_id
       where attendee.event_id = $1 and attendee.revoked_at is null
       order by attendee.invited_at, attendee_user.display_name`,
      [event.id, event.organization_id]
    );
    return result.rows.map((row) => ({
      person: this.calendarPerson(row),
      response: row.response_status,
      ...(row.responded_at ? { respondedAt: row.responded_at.toISOString() } : {})
    }));
  }

  private attendeeCounts(attendees: CalendarAttendeeView[]): CalendarAttendeeCounts {
    return attendees.reduce<CalendarAttendeeCounts>((counts, attendee) => {
      if (attendee.response === "needs_action") counts.needsAction += 1;
      else counts[attendee.response] += 1;
      return counts;
    }, { accepted: 0, declined: 0, needsAction: 0, tentative: 0 });
  }

  private async pendingReminders(
    client: PoolClient,
    principal: AuthPrincipal,
    candidates: Array<{
      creatorDisplayName: string;
      eventId: string;
      occurrenceEndsAt: Date;
      occurrenceKey: string;
      occurrenceStartsAt: Date;
      reminder: ReminderRow;
      title: string;
    }>
  ): Promise<CalendarReminderView[]> {
    const now = new Date();
    const due = candidates.filter((candidate) => (
      candidate.occurrenceEndsAt > now
      && candidate.occurrenceStartsAt.getTime() - candidate.reminder.offset_minutes * 60_000 <= now.getTime()
    ));
    if (!due.length) return [];
    const reminderIds = [...new Set(due.map((item) => item.reminder.id))];
    const dismissed = await client.query<{ occurrence_start_at: Date; reminder_id: string }>(
      `select reminder_id, occurrence_start_at
       from event_reminder_receipts
       where user_id = $1 and status = 'dismissed' and reminder_id = any($2::uuid[])`,
      [principal.internalUserId, reminderIds]
    );
    const dismissedKeys = new Set(dismissed.rows.map((row) => `${row.reminder_id}:${row.occurrence_start_at.toISOString()}`));
    return due
      .filter((item) => !dismissedKeys.has(`${item.reminder.id}:${item.occurrenceStartsAt.toISOString()}`))
      .map((item) => ({
        creatorDisplayName: item.creatorDisplayName,
        eventId: item.eventId,
        occurrenceKey: item.occurrenceKey,
        occurrenceStartsAt: item.occurrenceStartsAt.toISOString(),
        reminderId: item.reminder.id,
        title: item.title,
        triggerAt: new Date(item.occurrenceStartsAt.getTime() - item.reminder.offset_minutes * 60_000).toISOString()
      }))
      .sort((left, right) => left.triggerAt.localeCompare(right.triggerAt));
  }

  private async reminderRows(client: PoolClient, eventId: string) {
    return (await client.query<ReminderRow>(
      "select id, offset_minutes from event_reminders where event_id = $1 order by offset_minutes",
      [eventId]
    )).rows;
  }

  private async loadEvent(client: PoolClient, principal: AuthPrincipal, eventId: string, lock = false) {
    const result = await client.query<EventRow>(
      `${this.eventSelect()}
       where e.id = $3 and e.organization_id = $1
         and (e.created_by = $2 or viewer_attendee.user_id = $2)
       ${lock ? "for update of e" : ""}`,
      [principal.state.user.organizationId, principal.internalUserId, eventId]
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundException("Calendar event not found.");
    return row;
  }

  private eventSelect() {
    return `select
      e.id, e.organization_id, e.space_id, e.created_by, e.title, e.description, e.location,
      e.visibility, to_char(e.starts_local, 'YYYY-MM-DD"T"HH24:MI:SS') as starts_local_text,
      to_char(e.ends_local, 'YYYY-MM-DD"T"HH24:MI:SS') as ends_local_text,
      e.starts_at, e.ends_at, e.timezone, e.all_day, e.recurrence_rule, e.recurrence_json,
      e.recurrence_ends_at, e.status, e.version, e.cancellation_reason, e.cancelled_at,
      e.created_at, e.updated_at,
      creator_user.public_id as creator_public_id,
      creator_user.display_name as creator_display_name,
      creator_membership.role as creator_role,
      creator_profile.public_profile_json ->> 'characterId' as creator_character_id,
      viewer_attendee.response_status as viewer_response,
      space.type as space_type, space.name as space_name, space.owner_id as space_owner_id,
      space_owner.display_name as space_owner_display_name
    from events e
    join users creator_user on creator_user.id = e.created_by
    join organization_memberships creator_membership
      on creator_membership.organization_id = e.organization_id
     and creator_membership.user_id = e.created_by
    left join profiles creator_profile on creator_profile.user_id = e.created_by
    left join event_attendees viewer_attendee
      on viewer_attendee.event_id = e.id
     and viewer_attendee.user_id = $2
     and viewer_attendee.revoked_at is null
    left join conversation_spaces space on space.id = e.space_id
    left join users space_owner on space_owner.id = space.owner_id`;
  }

  private async occurrenceInstants(
    client: PoolClient,
    localStarts: string[],
    durationSeconds: number,
    timezone: string
  ) {
    const result = await client.query<OccurrenceInstant>(
      `with occurrence(local_start) as (
         select unnest($1::timestamp[])
       ), expanded as (
         select local_start, local_start + make_interval(secs => $2::double precision) as local_end
         from occurrence
       )
       select
         to_char(local_start, 'YYYY-MM-DD"T"HH24:MI:SS') as starts_local_text,
         to_char(local_end, 'YYYY-MM-DD"T"HH24:MI:SS') as ends_local_text,
         local_start at time zone $3 as starts_at,
         local_end at time zone $3 as ends_at,
         ((local_start at time zone $3) at time zone $3) = local_start
           and ((local_end at time zone $3) at time zone $3) = local_end as valid
       from expanded
       order by local_start`,
      [localStarts, durationSeconds, timezone]
    );
    return result.rows;
  }

  private async assertTimezone(client: PoolClient, timezone: string) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    } catch {
      throw new BadRequestException("Timezone is not recognized by the application runtime.");
    }
    const result = await client.query("select 1 from pg_timezone_names where name = $1 limit 1", [timezone]);
    if (!result.rowCount) throw new BadRequestException("Timezone is not recognized by PostgreSQL.");
  }

  private async localInstant(client: PoolClient, local: string, timezone: string) {
    const result = await client.query<{ instant: Date; valid: boolean }>(
      `select
         $1::timestamp at time zone $2 as instant,
         (($1::timestamp at time zone $2) at time zone $2) = $1::timestamp as valid`,
      [local, timezone]
    );
    if (!result.rows[0]?.valid) throw new BadRequestException("Local time does not exist in the selected timezone.");
    return result.rows[0].instant;
  }

  private durationSeconds(startsLocal: string, endsLocal: string) {
    return Math.round(
      (localDateTimeToPseudoUtc(endsLocal).getTime() - localDateTimeToPseudoUtc(startsLocal).getTime()) / 1_000
    );
  }

  private async activeRole(client: PoolClient, principal: AuthPrincipal) {
    const result = await client.query<{ role: MemberRole }>(
      `select membership.role
       from organization_memberships membership
       join users viewer on viewer.id = membership.user_id and viewer.status = 'active'
       where membership.organization_id = $1 and membership.user_id = $2 and membership.status = 'active'`,
      [principal.state.user.organizationId, principal.internalUserId]
    );
    const role = result.rows[0]?.role;
    if (!role) throw new ForbiddenException("Active organization membership is required.");
    return role;
  }

  private async spaceForViewer(client: PoolClient, principal: AuthPrincipal, spaceId: string) {
    const result = await client.query<SpaceRow>(
      `select
         s.id, s.type, s.name, s.owner_id,
         owner_user.public_id as owner_public_id,
         owner_user.display_name as owner_display_name,
         owner_membership.role as owner_role,
         owner_profile.public_profile_json ->> 'characterId' as owner_character_id,
         viewer_membership.role as viewer_role
       from conversation_spaces s
       join space_memberships viewer_membership
         on viewer_membership.space_id = s.id
        and viewer_membership.user_id = $1
        and viewer_membership.status in ('active', 'muted')
       join users owner_user on owner_user.id = s.owner_id
       join organization_memberships owner_membership
         on owner_membership.organization_id = s.organization_id
        and owner_membership.user_id = s.owner_id
       left join profiles owner_profile on owner_profile.user_id = owner_user.id
       where s.id = $3 and s.organization_id = $2 and s.archived_at is null`,
      [principal.internalUserId, principal.state.user.organizationId, spaceId]
    );
    const space = result.rows[0];
    if (!space) throw new NotFoundException("Conversation context not found.");
    return space;
  }

  private async visibleSpacePeople(client: PoolClient, principal: AuthPrincipal, space: SpaceRow) {
    const result = await client.query<SpacePersonRow>(
      `select
         member_user.id as internal_user_id,
         member_user.public_id,
         member_user.display_name,
         member_membership.role,
         member_profile.public_profile_json ->> 'characterId' as character_id
       from space_memberships member
       join users member_user on member_user.id = member.user_id and member_user.status = 'active'
       join organization_memberships member_membership
         on member_membership.organization_id = $2
        and member_membership.user_id = member.user_id
        and member_membership.status = 'active'
       left join profiles member_profile on member_profile.user_id = member.user_id
       where member.space_id = $1
         and member.status in ('active', 'muted')
         and member.user_id <> $3
         and ($4::boolean = false or member.user_id = $5)
       order by member.joined_at, member_user.display_name`,
      [space.id, principal.state.user.organizationId, principal.internalUserId, space.type === "hub" && space.owner_id !== principal.internalUserId, space.owner_id]
    );
    return result.rows;
  }

  private canInviteWholeSpace(principal: AuthPrincipal, role: MemberRole, space: SpaceRow) {
    if (role === "guest" || role === "subscriber") return false;
    if (space.type === "hub") return space.owner_id === principal.internalUserId;
    return space.type === "open_group" || space.type === "direct" || space.type === "meeting_backstage";
  }

  private spaceMode(space: SpaceRow, viewerId: string): RoomPresentationMode {
    if (space.type === "hub") return space.owner_id === viewerId ? "hub_owner" : "direct";
    if (space.type === "open_group") return "group";
    if (space.type === "broadcast_channel") return "channel";
    if (space.type === "meeting_backstage") return "meeting";
    return "direct";
  }

  private eventSpaceMode(row: EventRow): RoomPresentationMode {
    if (row.space_type === "hub") return row.created_by === row.space_owner_id ? "hub_owner" : "direct";
    if (row.space_type === "open_group") return "group";
    if (row.space_type === "broadcast_channel") return "channel";
    if (row.space_type === "meeting_backstage") return "meeting";
    return "direct";
  }

  private spaceTitle(space: SpaceRow, viewerId: string, people: SpacePersonRow[]) {
    if (space.type === "hub" && space.owner_id !== viewerId) return space.owner_display_name;
    if (space.type === "direct") return people[0]?.display_name ?? space.name;
    return space.name;
  }

  private calendarPerson(row: SpacePersonRow): CalendarPerson {
    return {
      character: findCharacterPreset(row.character_id ?? ""),
      displayName: row.display_name,
      id: row.public_id,
      role: row.role
    };
  }

  private windowBounds(rawFrom?: string, rawTo?: string) {
    const now = new Date();
    const defaultFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const defaultTo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1));
    const from = rawFrom ? this.parseInstant(rawFrom, "Calendar window start") : defaultFrom;
    const to = rawTo ? this.parseInstant(rawTo, "Calendar window end") : defaultTo;
    if (to <= from) throw new BadRequestException("Calendar window end must be after its start.");
    if (to.getTime() - from.getTime() > maximumWindowMilliseconds) {
      throw new BadRequestException("Calendar window cannot exceed 93 days.");
    }
    return { from, to };
  }

  private parseInstant(value: string, fieldName: string) {
    const date = new Date(value);
    if (!value || Number.isNaN(date.getTime())) throw new BadRequestException(`${fieldName} is invalid.`);
    return date;
  }

  private occurrenceKey(eventId: string, startsAt: Date) {
    return `${eventId}:${startsAt.toISOString()}`;
  }

  private assertCreator(principal: AuthPrincipal, event: EventRow) {
    if (event.created_by !== principal.internalUserId) {
      throw new ForbiddenException("Only the event creator can change this event.");
    }
  }

  private writeAudit(
    client: PoolClient,
    principal: AuthPrincipal,
    action: string,
    eventId: string,
    metadata: Record<string, unknown>
  ) {
    return client.query(
      `insert into audit_logs (organization_id, actor_id, action, target_type, target_id, metadata_json)
       values ($1, $2, $3, 'calendar_event', $4, $5::jsonb)`,
      [principal.state.user.organizationId, principal.internalUserId, action, eventId, JSON.stringify(metadata)]
    );
  }
}
