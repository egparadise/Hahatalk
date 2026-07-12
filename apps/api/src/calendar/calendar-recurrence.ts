import { BadRequestException } from "@nestjs/common";
import {
  type CalendarRecurrence,
  type CalendarRecurrenceFrequency,
  type CalendarWeekday
} from "@hahatalk/contracts";
import rrulePackage from "rrule";

const { RRule, datetime } = rrulePackage;

export const maxCalendarOccurrences = 366;

const localDateTimePattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const localDatePattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const frequencies: Record<CalendarRecurrenceFrequency, number> = {
  daily: RRule.DAILY,
  monthly: RRule.MONTHLY,
  weekly: RRule.WEEKLY
};
const weekdays = [RRule.MO, RRule.TU, RRule.WE, RRule.TH, RRule.FR, RRule.SA, RRule.SU];
const weekdayCodes = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

export function normalizeLocalDateTime(value: string, fieldName: string) {
  const match = localDateTimePattern.exec(value.trim());
  if (!match) {
    throw new BadRequestException(`${fieldName} must use YYYY-MM-DDTHH:mm local time.`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? 0);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
    || date.getUTCHours() !== hour
    || date.getUTCMinutes() !== minute
    || date.getUTCSeconds() !== second
  ) {
    throw new BadRequestException(`${fieldName} is not a valid local date and time.`);
  }
  return formatLocalDateTime(date);
}

export function normalizeRecurrence(input: CalendarRecurrence | undefined, startsLocal: string) {
  if (!input) return undefined;
  if (!Object.hasOwn(frequencies, input.frequency)) {
    throw new BadRequestException("Recurrence frequency is invalid.");
  }
  if (!Number.isInteger(input.interval) || input.interval < 1 || input.interval > 12) {
    throw new BadRequestException("Recurrence interval must be between 1 and 12.");
  }
  const hasCount = input.count !== undefined;
  const hasUntil = input.untilLocalDate !== undefined;
  if (hasCount === hasUntil) {
    throw new BadRequestException("Recurring events require exactly one of count or until date.");
  }
  if (hasCount && (!Number.isInteger(input.count) || input.count! < 2 || input.count! > maxCalendarOccurrences)) {
    throw new BadRequestException(`Recurrence count must be between 2 and ${maxCalendarOccurrences}.`);
  }

  let untilLocalDate: string | undefined;
  if (hasUntil) {
    const until = parseLocalDate(input.untilLocalDate!);
    const start = localDateTimeToPseudoUtc(startsLocal);
    const startDay = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
    const untilDay = until.getTime();
    const spanDays = Math.round((untilDay - startDay) / 86_400_000);
    if (spanDays < 1 || spanDays > 732) {
      throw new BadRequestException("Recurrence end date must be after the start and within two years.");
    }
    untilLocalDate = input.untilLocalDate;
  }

  let normalizedWeekdays: CalendarWeekday[] | undefined;
  if (input.frequency === "weekly") {
    const values = input.weekdays?.length ? input.weekdays : [isoWeekday(localDateTimeToPseudoUtc(startsLocal))];
    if (values.some((value) => !Number.isInteger(value) || value < 1 || value > 7)) {
      throw new BadRequestException("Weekly recurrence weekdays must be between Monday (1) and Sunday (7).");
    }
    normalizedWeekdays = [...new Set(values)].sort((left, right) => left - right) as CalendarWeekday[];
    if (!normalizedWeekdays.includes(isoWeekday(localDateTimeToPseudoUtc(startsLocal)))) {
      throw new BadRequestException("The first event date must match one of the weekly recurrence weekdays.");
    }
  } else if (input.weekdays?.length) {
    throw new BadRequestException("Weekdays are only supported for weekly recurrence.");
  }

  const recurrence: CalendarRecurrence = {
    frequency: input.frequency,
    interval: input.interval,
    ...(normalizedWeekdays ? { weekdays: normalizedWeekdays } : {}),
    ...(hasCount ? { count: input.count } : {}),
    ...(untilLocalDate ? { untilLocalDate } : {})
  };
  const occurrences = recurrenceLocalStarts(startsLocal, recurrence);
  if (occurrences.length < 2) {
    throw new BadRequestException("Recurrence must produce at least two event occurrences.");
  }
  if (occurrences.length > maxCalendarOccurrences) {
    throw new BadRequestException(`A recurring series cannot exceed ${maxCalendarOccurrences} occurrences.`);
  }
  return recurrence;
}

export function recurrenceLocalStarts(startsLocal: string, recurrence?: CalendarRecurrence) {
  if (!recurrence) return [startsLocal];
  const rule = new RRule({
    dtstart: localDateTimeToPseudoUtc(startsLocal),
    freq: frequencies[recurrence.frequency],
    interval: recurrence.interval,
    ...(recurrence.weekdays
      ? { byweekday: recurrence.weekdays.map((value) => weekdays[value - 1]!) }
      : {}),
    ...(recurrence.count !== undefined ? { count: recurrence.count } : {}),
    ...(recurrence.untilLocalDate
      ? { until: localDateTimeToPseudoUtc(`${recurrence.untilLocalDate}T23:59:59`) }
      : {})
  });
  const dates = rule.all();
  if (dates.length > maxCalendarOccurrences) {
    throw new BadRequestException(`A recurring series cannot exceed ${maxCalendarOccurrences} occurrences.`);
  }
  return dates.map(formatLocalDateTime);
}

export function canonicalRecurrenceRule(recurrence: CalendarRecurrence, untilUtc?: Date) {
  const parts = [`FREQ=${recurrence.frequency.toUpperCase()}`, `INTERVAL=${recurrence.interval}`];
  if (recurrence.weekdays) {
    parts.push(`BYDAY=${recurrence.weekdays.map((value) => weekdayCodes[value - 1]).join(",")}`);
  }
  if (recurrence.count !== undefined) {
    parts.push(`COUNT=${recurrence.count}`);
  } else if (untilUtc) {
    parts.push(`UNTIL=${formatUtcBasic(untilUtc)}`);
  } else {
    throw new BadRequestException("A recurrence until instant is required.");
  }
  return parts.join(";");
}

export function parseStoredRecurrence(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<CalendarRecurrence>;
  if (!candidate.frequency || !Object.hasOwn(frequencies, candidate.frequency)) return undefined;
  return candidate as CalendarRecurrence;
}

export function localDateTimeToPseudoUtc(value: string) {
  const match = localDateTimePattern.exec(value);
  if (!match) throw new BadRequestException("Stored local event time is invalid.");
  return datetime(
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6] ?? 0)
  );
}

export function formatLocalDateTime(date: Date) {
  return [
    String(date.getUTCFullYear()).padStart(4, "0"),
    "-",
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    "-",
    String(date.getUTCDate()).padStart(2, "0"),
    "T",
    String(date.getUTCHours()).padStart(2, "0"),
    ":",
    String(date.getUTCMinutes()).padStart(2, "0"),
    ":",
    String(date.getUTCSeconds()).padStart(2, "0")
  ].join("");
}

function parseLocalDate(value: string) {
  const match = localDatePattern.exec(value);
  if (!match) throw new BadRequestException("Recurrence end date must use YYYY-MM-DD.");
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (
    date.getUTCFullYear() !== Number(match[1])
    || date.getUTCMonth() !== Number(match[2]) - 1
    || date.getUTCDate() !== Number(match[3])
  ) {
    throw new BadRequestException("Recurrence end date is invalid.");
  }
  return date;
}

function isoWeekday(date: Date) {
  const day = date.getUTCDay();
  return (day === 0 ? 7 : day) as CalendarWeekday;
}

function formatUtcBasic(date: Date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}
