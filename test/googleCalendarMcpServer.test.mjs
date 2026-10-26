import assert from "node:assert/strict";
import test from "node:test";

import { googleCalendarMcpServerTestHooks } from "../dist/services/calendar/src/mcp/googleCalendarMcpServer.js";

const {
  buildCreateEvent,
  buildPatchEvent,
  parseTimeRange,
  freeBusyIntervals,
  freeBusyErrors,
  findFreeSlots,
  safeErrorMessage
} = googleCalendarMcpServerTestHooks;

test("buildCreateEvent builds timed events without mutating live calendars", () => {
  const event = buildCreateEvent({
    summary: "Planning",
    description: "Quarterly planning",
    location: "Room 1",
    startDateTime: "2026-06-22T09:00:00.000Z",
    endDateTime: "2026-06-22T10:00:00.000Z",
    timeZone: "UTC",
    attendees: [{ email: "guest@example.com", optional: true }]
  });

  assert.deepEqual(event, {
    summary: "Planning",
    description: "Quarterly planning",
    location: "Room 1",
    attendees: [{ email: "guest@example.com", optional: true }],
    start: { dateTime: "2026-06-22T09:00:00.000Z", timeZone: "UTC" },
    end: { dateTime: "2026-06-22T10:00:00.000Z", timeZone: "UTC" }
  });
});

test("buildCreateEvent builds all-day events with exclusive end dates", () => {
  const event = buildCreateEvent({
    summary: "Out of office",
    startDate: "2026-07-01",
    endDate: "2026-07-03"
  });

  assert.deepEqual(event, {
    summary: "Out of office",
    start: { date: "2026-07-01" },
    end: { date: "2026-07-03" }
  });
});

test("event builders reject incomplete, mixed, and empty updates", () => {
  assert.throws(
    () => buildCreateEvent({ summary: "Missing end", startDateTime: "2026-06-22T09:00:00.000Z" }),
    /Timed events require both startDateTime and endDateTime/
  );
  assert.throws(
    () =>
      buildCreateEvent({
        summary: "Mixed",
        startDateTime: "2026-06-22T09:00:00.000Z",
        endDateTime: "2026-06-22T10:00:00.000Z",
        startDate: "2026-06-22",
        endDate: "2026-06-23"
      }),
    /Use either startDateTime\/endDateTime/
  );
  assert.throws(() => buildPatchEvent({}), /At least one event field/);
  assert.deepEqual(buildPatchEvent({ location: "" }), { location: "" });
});

test("parseTimeRange validates ordering and the 366-day free-time limit", () => {
  assert.deepEqual(parseTimeRange("2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"), {
    startMs: Date.parse("2026-01-01T00:00:00.000Z"),
    endMs: Date.parse("2026-01-02T00:00:00.000Z")
  });
  assert.throws(() => parseTimeRange("2026-01-02T00:00:00.000Z", "2026-01-01T00:00:00.000Z"), /timeMax must be after timeMin/);
  assert.throws(() => parseTimeRange("2026-01-01T00:00:00.000Z", "2027-01-03T00:00:00.000Z"), /366 days or shorter/);
});

test("freebusy helpers merge busy intervals and preserve per-calendar errors", () => {
  const response = {
    calendars: {
      primary: {
        busy: [{ start: "2026-06-22T10:00:00.000Z", end: "2026-06-22T11:00:00.000Z" }]
      },
      team: {
        busy: [
          { start: "2026-06-22T10:30:00.000Z", end: "2026-06-22T12:00:00.000Z" },
          { start: "not-a-date", end: "2026-06-22T12:30:00.000Z" }
        ],
        errors: [{ reason: "notFound", domain: "global" }]
      }
    }
  };

  assert.deepEqual(freeBusyIntervals(response), [
    {
      startMs: Date.parse("2026-06-22T10:00:00.000Z"),
      endMs: Date.parse("2026-06-22T12:00:00.000Z")
    }
  ]);
  assert.deepEqual(freeBusyErrors(response), [{ calendarId: "team", reason: "notFound", domain: "global" }]);
});

test("findFreeSlots honors working hours, busy intervals, increments, and limits", () => {
  const slots = findFreeSlots({
    range: parseTimeRange("2026-06-22T08:00:00.000Z", "2026-06-22T13:00:00.000Z"),
    busy: [
      { startMs: Date.parse("2026-06-22T09:30:00.000Z"), endMs: Date.parse("2026-06-22T10:00:00.000Z") },
      { startMs: Date.parse("2026-06-22T10:30:00.000Z"), endMs: Date.parse("2026-06-22T11:00:00.000Z") }
    ],
    durationMinutes: 30,
    incrementMinutes: 30,
    limit: 3,
    timeZone: "UTC",
    workingHours: { startTime: "09:00", endTime: "12:00", daysOfWeek: [1] }
  });

  assert.deepEqual(slots, [
    {
      start: "2026-06-22T09:00:00.000Z",
      end: "2026-06-22T09:30:00.000Z",
      localStart: "2026-06-22 09:00",
      localEnd: "2026-06-22 09:30"
    },
    {
      start: "2026-06-22T10:00:00.000Z",
      end: "2026-06-22T10:30:00.000Z",
      localStart: "2026-06-22 10:00",
      localEnd: "2026-06-22 10:30"
    },
    {
      start: "2026-06-22T11:00:00.000Z",
      end: "2026-06-22T11:30:00.000Z",
      localStart: "2026-06-22 11:00",
      localEnd: "2026-06-22 11:30"
    }
  ]);
});

test("safeErrorMessage redacts bearer tokens", () => {
  const message = safeErrorMessage(new Error("Google failed: Bearer ya29.secret-token and bearer other-token"));

  assert.equal(message, "Google failed: Bearer [redacted] and Bearer [redacted]");
  assert.equal(message.includes("ya29.secret-token"), false);
  assert.equal(message.includes("other-token"), false);
});
