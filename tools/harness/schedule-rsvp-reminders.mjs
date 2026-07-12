import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";

const root = process.cwd();
const apiEntry = path.join(root, "apps", "api", "dist", "main.js");
const migrationsDirectory = path.join(root, "apps", "api", "migrations");
const baseDatabaseUrl = process.env.DATABASE_URL
  ?? "postgresql://hahatalk:hahatalk_dev_only@127.0.0.1:54329/hahatalk";
const databaseName = `hahatalk_calendar_${Date.now()}_${randomUUID().slice(0, 8).replaceAll("-", "")}`;
const adminUrl = new URL(baseDatabaseUrl);
adminUrl.pathname = "/postgres";
const integrationUrl = new URL(baseDatabaseUrl);
integrationUrl.pathname = `/${databaseName}`;
const databaseUrl = integrationUrl.toString();
const cookieName = "hahatalk_calendar_session";
const hubId = "00000000-0000-4000-8000-000000000201";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function startApi(port, webOrigin) {
  const logs = [];
  const child = spawn(process.execPath, [apiEntry], {
    cwd: root,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      HAHATALK_ALLOW_OPEN_SIGNUP: "true",
      HAHATALK_MIGRATIONS_DIR: migrationsDirectory,
      PORT: String(port),
      SESSION_COOKIE_NAME: cookieName,
      WEB_ORIGIN: webOrigin
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr.on("data", (chunk) => logs.push(String(chunk)));
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Calendar API exited during startup.\n${logs.join("")}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return { child, logs };
    } catch {
      // The fresh database is still migrating.
    }
    await delay(125);
  }
  child.kill();
  throw new Error(`Calendar API did not become healthy.\n${logs.join("")}`);
}

async function stopApi(api) {
  if (!api?.child || api.child.exitCode !== null) return;
  api.child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => api.child.once("exit", resolve)),
    delay(5_000).then(() => api.child.exitCode === null && api.child.kill())
  ]);
}

async function request(baseUrl, pathName, { cookie, method = "GET", origin, payload } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (origin) headers.Origin = origin;
  if (payload !== undefined) {
    headers["Content-Type"] = "application/json";
    headers["X-HahaTalk-Client"] = "web-v1";
  }
  const response = await fetch(`${baseUrl}${pathName}`, {
    body: payload === undefined ? undefined : JSON.stringify(payload),
    headers,
    method,
    signal: AbortSignal.timeout(20_000)
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return { body, response };
}

function responseCookie(response) {
  const setCookie = response.headers.get("set-cookie");
  assert(setCookie, "Authentication response did not set a cookie.");
  return setCookie.split(";", 1)[0];
}

async function signup(baseUrl, webOrigin, email, password, displayName, characterId) {
  const result = await request(baseUrl, "/auth/signup", {
    method: "POST",
    origin: webOrigin,
    payload: { characterId, displayName, email, password }
  });
  assert(result.response.status === 201, `Signup failed for ${email}: ${result.response.status} ${JSON.stringify(result.body)}`);
  return { cookie: responseCookie(result.response), userId: result.body.user.id };
}

async function createEvent(baseUrl, webOrigin, cookie, payload, expectedStatus = 201) {
  const result = await request(baseUrl, "/calendar/events", {
    cookie,
    method: "POST",
    origin: webOrigin,
    payload
  });
  assert(result.response.status === expectedStatus, `Event create expected ${expectedStatus}, got ${result.response.status}: ${JSON.stringify(result.body)}`);
  return result.body;
}

async function eventWindow(baseUrl, cookie, from, to) {
  const query = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
  const result = await request(baseUrl, `/calendar/events?${query}` , { cookie });
  assert(result.response.status === 200, `Calendar window failed: ${result.response.status} ${JSON.stringify(result.body)}`);
  return result.body;
}

function baseEvent(overrides = {}) {
  return {
    allDay: false,
    attendeeIds: [],
    description: "Stage 6A integration event",
    endsLocal: "2027-03-07T10:00:00",
    location: "HahaTalk test room",
    reminderOffsetsMinutes: [],
    startsLocal: "2027-03-07T09:00:00",
    timezone: "Asia/Seoul",
    title: "Stage 6A event",
    visibility: "private",
    ...overrides
  };
}

function localInZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone,
    year: "numeric"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}`;
}

const adminDatabase = new Client({ connectionString: adminUrl.toString() });
const database = new Client({ connectionString: databaseUrl });
let adminConnected = false;
let databaseConnected = false;
let api;

try {
  await adminDatabase.connect();
  adminConnected = true;
  await adminDatabase.query(`create database "${databaseName}"`);
  await database.connect();
  databaseConnected = true;

  const port = await findAvailablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const webOrigin = `http://127.0.0.1:${await findAvailablePort()}`;
  api = await startApi(port, webOrigin);

  const owner = await signup(baseUrl, webOrigin, "you@inviz.co.kr", "Stage6!OwnerPass", "Stage6 Owner", "char-calm-lead");
  const mina = await signup(baseUrl, webOrigin, "mina@inviz.co.kr", "Stage6!MinaPass", "Stage6 Mina", "char-focus-maker");
  const jun = await signup(baseUrl, webOrigin, "jun@inviz.co.kr", "Stage6!JunPass", "Stage6 Jun", "char-calm-lead");
  const hana = await signup(baseUrl, webOrigin, "hana.customer@example.com", "Stage6!HanaPass", "Stage6 Hana", "char-customer-guest");

  const ownerContext = await request(baseUrl, "/calendar/context", { cookie: owner.cookie });
  assert(ownerContext.response.status === 200, "Owner calendar context failed.");
  const ownerHub = ownerContext.body.spaces.find((space) => space.id === hubId);
  assert(ownerHub?.mode === "hub_owner" && ownerHub.canInviteAll, "Owner did not receive the hub scheduling console.");
  assert(ownerHub.people.length === 3, "Owner context did not include the three exact active hub recipients.");

  const minaContext = await request(baseUrl, "/calendar/context", { cookie: mina.cookie });
  const minaHub = minaContext.body.spaces.find((space) => space.id === hubId);
  assert(minaHub?.mode === "direct" && !minaHub.canInviteAll, "Hub participant context was not normalized to direct mode.");
  assert(minaHub.people.length === 1 && minaHub.people[0].id === owner.userId, "Hub participant saw someone other than the owner.");
  assert(!JSON.stringify(minaHub).includes("프로젝트 A 허브방") && !JSON.stringify(minaHub).includes(jun.userId), "Hub context leaked hidden room or member identity.");

  const weeklyInput = baseEvent({
    attendeeIds: [mina.userId],
    recurrence: { count: 4, frequency: "weekly", interval: 1, weekdays: [7] },
    spaceId: hubId,
    timezone: "America/New_York",
    title: "New York weekly stand-up",
    visibility: "attendees"
  });
  const weekly = await createEvent(baseUrl, webOrigin, owner.cookie, weeklyInput);
  assert(weekly.attendees.length === 1 && weekly.attendees[0].person.id === mina.userId, "Creator attendee snapshot is incorrect.");
  assert(weekly.space?.mode === "hub_owner" && weekly.recurrence?.count === 4, "Creator recurrence or space projection is incomplete.");

  const marchFrom = new Date("2027-03-01T00:00:00.000Z");
  const marchTo = new Date("2027-04-15T00:00:00.000Z");
  const ownerMarch = await eventWindow(baseUrl, owner.cookie, marchFrom, marchTo);
  const ownerWeekly = ownerMarch.occurrences.filter((item) => item.id === weekly.id);
  assert(ownerWeekly.length === 4, "Weekly recurrence did not expand to four bounded occurrences.");
  assert(
    JSON.stringify(ownerWeekly.map((item) => item.occurrenceStartsAt))
      === JSON.stringify(["2027-03-07T14:00:00.000Z", "2027-03-14T13:00:00.000Z", "2027-03-21T13:00:00.000Z", "2027-03-28T13:00:00.000Z"]),
    "New York weekly recurrence did not preserve 09:00 across the DST boundary."
  );
  assert(ownerWeekly.every((item) => item.occurrenceStartsLocal.endsWith("T09:00:00")), "Recurring local wall-clock time shifted.");

  const minaMarch = await eventWindow(baseUrl, mina.cookie, marchFrom, marchTo);
  const minaWeekly = minaMarch.occurrences.find((item) => item.id === weekly.id);
  assert(minaWeekly, "Invited attendee did not receive the event.");
  const minaProjection = JSON.stringify(minaWeekly);
  assert(!("attendees" in minaWeekly) && !("attendeeCounts" in minaWeekly) && !("reminderOffsetsMinutes" in minaWeekly) && !("space" in minaWeekly), "Attendee projection exposed creator-only event state.");
  assert(!minaProjection.includes(jun.userId) && !minaProjection.includes(hana.userId) && !minaProjection.includes("프로젝트 A 허브방"), "Hub event projection leaked hidden members or room identity.");
  const junMarch = await eventWindow(baseUrl, jun.cookie, marchFrom, marchTo);
  assert(!junMarch.occurrences.some((item) => item.id === weekly.id), "Uninvited hub participant received a selected event.");

  const minaRsvp = await request(baseUrl, `/calendar/events/${weekly.id}/rsvp`, {
    cookie: mina.cookie,
    method: "POST",
    origin: webOrigin,
    payload: { response: "accepted" }
  });
  assert(minaRsvp.response.status === 200 && minaRsvp.body.myResponse === "accepted", "Attendee RSVP did not update their own row.");
  assert(!("attendees" in minaRsvp.body), "RSVP response leaked the creator attendee report.");

  const ownerFromMina = await createEvent(baseUrl, webOrigin, mina.cookie, baseEvent({
    attendeeIds: [owner.userId],
    endsLocal: "2027-04-02T11:00:00",
    spaceId: hubId,
    startsLocal: "2027-04-02T10:00:00",
    title: "Participant to owner schedule",
    visibility: "attendees"
  }));
  assert(ownerFromMina.space?.mode === "direct" && ownerFromMina.attendees.length === 1, "Hub participant could not create their direct owner invitation.");
  await createEvent(baseUrl, webOrigin, mina.cookie, baseEvent({
    attendeeIds: [],
    spaceId: hubId,
    title: "Forbidden participant room event",
    visibility: "space"
  }), 403);

  const wholeSpace = await createEvent(baseUrl, webOrigin, owner.cookie, baseEvent({
    attendeeIds: [],
    endsLocal: "2027-05-02T11:00:00",
    spaceId: hubId,
    startsLocal: "2027-05-02T10:00:00",
    title: "Snapshot all current hub recipients",
    visibility: "space"
  }));
  assert(wholeSpace.attendees.length === 3, "Whole-space event did not materialize the exact current member snapshot.");
  const future = await signup(baseUrl, webOrigin, `future-${Date.now()}@example.test`, "Stage6!FuturePass", "Future Member", "char-calm-lead");
  const futureMay = await eventWindow(baseUrl, future.cookie, new Date("2027-05-01T00:00:00Z"), new Date("2027-05-10T00:00:00Z"));
  assert(!futureMay.occurrences.some((item) => item.id === wholeSpace.id), "Future hub member gained retroactive access to a snapshot event.");

  const hanaMay = await eventWindow(baseUrl, hana.cookie, new Date("2027-05-01T00:00:00Z"), new Date("2027-05-10T00:00:00Z"));
  assert(hanaMay.occurrences.some((item) => item.id === wholeSpace.id), "Guest snapshot attendee did not receive the event.");
  const hanaRsvp = await request(baseUrl, `/calendar/events/${wholeSpace.id}/rsvp`, {
    cookie: hana.cookie,
    method: "POST",
    origin: webOrigin,
    payload: { response: "tentative" }
  });
  assert(hanaRsvp.response.status === 200 && hanaRsvp.body.myResponse === "tentative", "Guest RSVP failed.");
  await createEvent(baseUrl, webOrigin, hana.cookie, baseEvent({
    attendeeIds: [owner.userId],
    spaceId: hubId,
    visibility: "attendees"
  }), 403);
  const guestPrivate = await createEvent(baseUrl, webOrigin, hana.cookie, baseEvent({ title: "Guest private note" }));
  assert(guestPrivate.isCreator && guestPrivate.visibility === "private", "Guest could not create a private personal event.");

  const updatedInput = { ...weeklyInput, title: "New York weekly stand-up updated", version: weekly.version };
  const update = await request(baseUrl, `/calendar/events/${weekly.id}`, {
    cookie: owner.cookie,
    method: "PATCH",
    origin: webOrigin,
    payload: updatedInput
  });
  assert(update.response.status === 200 && update.body.version === weekly.version + 1, "Optimistic event update failed.");
  const stale = await request(baseUrl, `/calendar/events/${weekly.id}`, {
    cookie: owner.cookie,
    method: "PATCH",
    origin: webOrigin,
    payload: updatedInput
  });
  assert(stale.response.status === 409, "Stale event version was not rejected.");
  const unauthorizedCancel = await request(baseUrl, `/calendar/events/${weekly.id}/cancel`, {
    cookie: mina.cookie,
    method: "POST",
    origin: webOrigin,
    payload: { version: update.body.version }
  });
  assert(unauthorizedCancel.response.status === 403, "Attendee cancelled an event they did not create.");
  const cancelled = await request(baseUrl, `/calendar/events/${weekly.id}/cancel`, {
    cookie: owner.cookie,
    method: "POST",
    origin: webOrigin,
    payload: { reason: "Integration cancellation", version: update.body.version }
  });
  assert(cancelled.response.status === 200 && cancelled.body.status === "cancelled" && cancelled.body.version === update.body.version + 1, "Creator cancellation failed.");

  const now = new Date();
  const reminderInput = baseEvent({
    attendeeIds: [mina.userId],
    endsLocal: localInZone(new Date(now.getTime() + 90 * 60_000), "Asia/Seoul"),
    reminderOffsetsMinutes: [60],
    spaceId: hubId,
    startsLocal: localInZone(new Date(now.getTime() + 30 * 60_000), "Asia/Seoul"),
    title: "Due reminder ownership",
    visibility: "attendees"
  });
  const reminderEvent = await createEvent(baseUrl, webOrigin, owner.cookie, reminderInput);
  const reminderFrom = new Date(now.getTime() - 60 * 60_000);
  const reminderTo = new Date(now.getTime() + 24 * 60 * 60_000);
  const ownerReminderWindow = await eventWindow(baseUrl, owner.cookie, reminderFrom, reminderTo);
  const ownerReminder = ownerReminderWindow.reminders.find((item) => item.eventId === reminderEvent.id);
  assert(ownerReminder, "Creator did not receive their due reminder.");
  const minaReminderWindow = await eventWindow(baseUrl, mina.cookie, reminderFrom, reminderTo);
  const minaReminder = minaReminderWindow.reminders.find((item) => item.eventId === reminderEvent.id);
  assert(minaReminder, "Attendee did not receive their own due reminder.");
  const ownerDismiss = await request(baseUrl, `/calendar/events/${reminderEvent.id}/reminders/${ownerReminder.reminderId}/dismiss`, {
    cookie: owner.cookie,
    method: "POST",
    origin: webOrigin,
    payload: { occurrenceStartsAt: ownerReminder.occurrenceStartsAt }
  });
  assert(ownerDismiss.response.status === 200 && ownerDismiss.body.status === "dismissed", "Creator reminder dismissal failed.");
  assert(!(await eventWindow(baseUrl, owner.cookie, reminderFrom, reminderTo)).reminders.some((item) => item.eventId === reminderEvent.id), "Dismissed creator reminder remained pending.");
  assert((await eventWindow(baseUrl, mina.cookie, reminderFrom, reminderTo)).reminders.some((item) => item.eventId === reminderEvent.id), "Creator dismissal changed the attendee reminder.");
  const minaDismiss = await request(baseUrl, `/calendar/events/${reminderEvent.id}/reminders/${minaReminder.reminderId}/dismiss`, {
    cookie: mina.cookie,
    method: "POST",
    origin: webOrigin,
    payload: { occurrenceStartsAt: minaReminder.occurrenceStartsAt }
  });
  assert(minaDismiss.response.status === 200, "Attendee reminder dismissal failed.");

  await createEvent(baseUrl, webOrigin, owner.cookie, baseEvent({
    recurrence: { frequency: "weekly", interval: 1 }
  }), 400);
  await createEvent(baseUrl, webOrigin, owner.cookie, baseEvent({ timezone: "Mars/Olympus_Mons" }), 400);
  await createEvent(baseUrl, webOrigin, owner.cookie, baseEvent({
    endsLocal: "2027-03-14T03:30:00",
    startsLocal: "2027-03-14T02:30:00",
    timezone: "America/New_York"
  }), 400);
  const oversizedWindow = await request(baseUrl, "/calendar/events?from=2027-01-01T00%3A00%3A00.000Z&to=2027-06-01T00%3A00%3A00.000Z", { cookie: owner.cookie });
  assert(oversizedWindow.response.status === 400, "Oversized calendar expansion window was not rejected.");

  await stopApi(api);
  api = await startApi(port, webOrigin);
  const restartWindow = await eventWindow(baseUrl, owner.cookie, reminderFrom, reminderTo);
  assert(restartWindow.occurrences.some((item) => item.id === reminderEvent.id), "Calendar event did not survive API restart.");
  assert(!restartWindow.reminders.some((item) => item.eventId === reminderEvent.id), "Reminder dismissal did not survive API restart.");

  const audit = await database.query(
    `select action, count(*)::int as count
     from audit_logs where target_type = 'calendar_event'
     group by action order by action`
  );
  const auditMap = new Map(audit.rows.map((row) => [row.action, row.count]));
  for (const action of ["calendar.event_created", "calendar.event_updated", "calendar.event_cancelled", "calendar.event_rsvp", "calendar.reminder_dismissed"]) {
    assert((auditMap.get(action) ?? 0) > 0, `Calendar audit action is missing: ${action}`);
  }
  const migration = await database.query("select checksum from schema_migrations where version = '006_schedule_rsvp_reminders.sql'");
  assert(migration.rowCount === 1 && /^[0-9a-f]{64}$/.test(migration.rows[0].checksum), "Migration 006 checksum evidence is missing.");
  const tables = await database.query(
    `select table_name from information_schema.tables
     where table_schema = 'public' and table_name in ('events', 'event_attendees', 'event_reminders', 'event_reminder_receipts')`
  );
  assert(tables.rowCount === 4, "Calendar migration did not create all four tables.");

  console.log("Schedule/RSVP/reminder integration passed: privacy, exact snapshots, RSVP, DST, conflicts, reminders, restart, and audit verified.");
} finally {
  await stopApi(api).catch(() => undefined);
  if (databaseConnected) await database.end().catch(() => undefined);
  if (adminConnected) {
    await adminDatabase.query(
      "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
      [databaseName]
    ).catch(() => undefined);
    await adminDatabase.query(`drop database if exists "${databaseName}"`).catch(() => undefined);
    await adminDatabase.end().catch(() => undefined);
  }
}
