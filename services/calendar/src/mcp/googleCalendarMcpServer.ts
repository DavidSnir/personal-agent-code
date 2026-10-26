import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { safeCalendarErrorMessage } from "../google/calendarError.js";
import { google } from "googleapis";
import type { calendar_v3 } from "googleapis";
import { z } from "zod";

import type { GoogleCalendarConfig } from "../google/config.js";
import { createOAuthClientFromStoredToken } from "../google/oauth.js";
import { GoogleCalendarRepository } from "../google/repository.js";
import { addDays, dateStringInTimeZone, utcMsForLocalDateStart } from "../google/time.js";

const calendarIdsSchema = z.array(z.string().min(1)).optional();
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");
const dateTimeSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T/, "Expected an ISO date-time")
  .refine((value) => !Number.isNaN(Date.parse(value)), "Expected an ISO date-time");
const sendUpdatesSchema = z.enum(["all", "externalOnly", "none"]).optional();
const attendeeSchema = z.object({ email: z.string().email(), optional: z.boolean().optional() });
const timeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:mm");

export async function runGoogleCalendarMcpServer(config: GoogleCalendarConfig): Promise<void> {
  const { repository, server } = createGoogleCalendarMcpServer(config);
  const transport = new StdioServerTransport();
  process.on("SIGINT", () => {
    repository.close();
    void server.close().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    repository.close();
    void server.close().finally(() => process.exit(0));
  });
  await server.connect(transport);
}

export async function runGoogleCalendarHttpMcpServer(config: GoogleCalendarConfig, options: { hostname: string; port: number; path: string }): Promise<void> {
  const httpServer = createServer((request, response) => void handleMcpHttpRequest(request, response, config, options.path));
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, options.hostname, () => {
      httpServer.off("error", reject);
      console.error(`Google Calendar MCP listening on http://${options.hostname}:${options.port}${options.path}`);
      resolve();
    });
  });

  const shutdown = (): void => {
    httpServer.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function createGoogleCalendarMcpServer(config: GoogleCalendarConfig): { repository: GoogleCalendarRepository; server: McpServer } {
  const repository = new GoogleCalendarRepository(config.dbPath);
  repository.initialize();

  const server = new McpServer({ name: "personal-agent-google-calendar", version: "0.1.0" });

  server.registerTool(
    "calendar_list_calendars",
    {
      title: "List Calendars",
      description: "List cached Google calendars with primary flag, timezone, access role, hidden, and selected status."
    },
    () => jsonResult({ calendars: repository.listCalendars().map(withoutRawJson) })
  );

  server.registerTool(
    "calendar_view_day",
    {
      title: "View Calendar Day",
      description: "Return cached all-day and timed events for one local date.",
      inputSchema: {
        date: dateSchema,
        timeZone: z.string().optional(),
        calendarIds: calendarIdsSchema
      }
    },
    (args) => {
      const events = repository.viewDay(args.date, args.timeZone, args.calendarIds);
      return jsonResult({ date: args.date, timeZone: args.timeZone ?? repository.getDefaultTimeZone(), events: events.map(withoutRawJson) });
    }
  );

  server.registerTool(
    "calendar_view_range",
    {
      title: "View Calendar Range",
      description: "Return cached all-day and timed events overlapping [startDate, endDate).",
      inputSchema: {
        startDate: dateSchema,
        endDate: dateSchema,
        timeZone: z.string().optional(),
        calendarIds: calendarIdsSchema
      }
    },
    (args) => {
      const events = repository.viewRange(args.startDate, args.endDate, args.timeZone, args.calendarIds);
      return jsonResult({
        startDate: args.startDate,
        endDate: args.endDate,
        timeZone: args.timeZone ?? repository.getDefaultTimeZone(),
        events: events.map(withoutRawJson)
      });
    }
  );

  server.registerTool(
    "calendar_search_events",
    {
      title: "Search Calendar Events",
      description: "Search cached event summary, description, and location text with optional date range.",
      inputSchema: {
        query: z.string().min(1),
        startDate: dateSchema.optional(),
        endDate: dateSchema.optional(),
        timeZone: z.string().optional(),
        calendarIds: calendarIdsSchema,
        limit: z.number().int().positive().max(100).optional()
      }
    },
    (args) => {
      const events = repository.searchEvents(args.query, {
        startDate: args.startDate,
        endDate: args.endDate,
        timeZone: args.timeZone,
        calendarIds: args.calendarIds,
        limit: args.limit ?? 25
      });
      return jsonResult({ query: args.query, events: events.map(withoutRawJson) });
    }
  );

  server.registerTool(
    "calendar_next_events",
    {
      title: "Next Calendar Events",
      description: "Return upcoming cached events from now.",
      inputSchema: {
        timeZone: z.string().optional(),
        calendarIds: calendarIdsSchema,
        limit: z.number().int().positive().max(100).optional()
      }
    },
    (args) => {
      const events = repository.nextEvents({ timeZone: args.timeZone, calendarIds: args.calendarIds, limit: args.limit ?? 10 });
      return jsonResult({ timeZone: args.timeZone ?? repository.getDefaultTimeZone(), events: events.map(withoutRawJson) });
    }
  );

  server.registerTool(
    "calendar_sync_status",
    {
      title: "Calendar Sync Status",
      description: "Return cache database path, token presence, sync window, counts, and per-calendar sync state."
    },
    () => jsonResult(repository.getStatus(config))
  );

  server.registerTool(
    "calendar_create_event",
    {
      title: "Create Calendar Event",
      description: "Preview or create a Google Calendar event. By default this is a dry run; repeat with confirm=true to create it.",
      inputSchema: {
        calendarId: z.string().min(1).optional(),
        summary: z.string().min(1),
        description: z.string().optional(),
        location: z.string().optional(),
        startDateTime: dateTimeSchema.optional(),
        endDateTime: dateTimeSchema.optional(),
        startDate: dateSchema.optional(),
        endDate: dateSchema.optional(),
        timeZone: z.string().optional(),
        attendees: z.array(attendeeSchema).optional(),
        sendUpdates: sendUpdatesSchema,
        confirm: z.boolean().optional()
      }
    },
    async (args) => {
      try {
        const calendarId = resolveWriteCalendarId(repository, args.calendarId);
        const event = buildCreateEvent(args);
        const preview = {
          action: "create_event",
          calendarId,
          sendUpdates: args.sendUpdates ?? "none",
          event
        };
        if (!args.confirm) {
          return jsonResult({ ok: true, dryRun: true, requiresConfirmation: true, confirmToApply: true, preview });
        }

        const calendar = await createCalendarClient(config, repository);
        const response = await calendar.events.insert({
          calendarId,
          sendUpdates: args.sendUpdates ?? "none",
          requestBody: event
        });
        if (response.data.id && repository.hasCalendar(calendarId)) {
          repository.upsertEvent(calendarId, response.data);
        }
        return jsonResult({ ok: true, dryRun: false, created: eventResponse(response.data), calendarId });
      } catch (error) {
        return jsonResult({ ok: false, error: safeErrorMessage(error) });
      }
    }
  );

  server.registerTool(
    "calendar_update_event",
    {
      title: "Update Calendar Event",
      description: "Preview or patch an existing Google Calendar event. By default this is a dry run; repeat with confirm=true to update it.",
      inputSchema: {
        calendarId: z.string().min(1).optional(),
        eventId: z.string().min(1),
        summary: z.string().optional(),
        description: z.string().optional(),
        location: z.string().optional(),
        startDateTime: dateTimeSchema.optional(),
        endDateTime: dateTimeSchema.optional(),
        startDate: dateSchema.optional(),
        endDate: dateSchema.optional(),
        timeZone: z.string().optional(),
        attendees: z.array(attendeeSchema).optional(),
        sendUpdates: sendUpdatesSchema,
        confirm: z.boolean().optional()
      }
    },
    async (args) => {
      try {
        const calendarId = resolveWriteCalendarId(repository, args.calendarId);
        const event = buildPatchEvent(args);
        const preview = {
          action: "update_event",
          calendarId,
          eventId: args.eventId,
          sendUpdates: args.sendUpdates ?? "none",
          patch: event
        };
        if (!args.confirm) {
          return jsonResult({ ok: true, dryRun: true, requiresConfirmation: true, confirmToApply: true, preview });
        }

        const calendar = await createCalendarClient(config, repository);
        const response = await calendar.events.patch({
          calendarId,
          eventId: args.eventId,
          sendUpdates: args.sendUpdates ?? "none",
          requestBody: event
        });
        if (response.data.id && repository.hasCalendar(calendarId)) {
          repository.upsertEvent(calendarId, response.data);
        }
        return jsonResult({ ok: true, dryRun: false, updated: eventResponse(response.data), calendarId });
      } catch (error) {
        return jsonResult({ ok: false, error: safeErrorMessage(error) });
      }
    }
  );

  server.registerTool(
    "calendar_find_free_time",
    {
      title: "Find Free Calendar Time",
      description: "Find candidate free slots across calendars using Google Calendar freebusy, with optional working-hours constraints.",
      inputSchema: {
        timeMin: dateTimeSchema,
        timeMax: dateTimeSchema,
        durationMinutes: z.number().int().positive().max(1440),
        calendarIds: calendarIdsSchema,
        timeZone: z.string().optional(),
        workingHours: z
          .object({
            startTime: timeOfDaySchema,
            endTime: timeOfDaySchema,
            daysOfWeek: z.array(z.number().int().min(0).max(6)).optional()
          })
          .optional(),
        slotIncrementMinutes: z.number().int().positive().max(1440).optional(),
        limit: z.number().int().positive().max(100).optional()
      }
    },
    async (args) => {
      try {
        const timeZone = args.timeZone ?? repository.getDefaultTimeZone();
        const calendarIds = args.calendarIds?.length ? args.calendarIds : defaultFreeBusyCalendarIds(repository);
        const range = parseTimeRange(args.timeMin, args.timeMax);
        const calendar = await createCalendarClient(config, repository);
        const response = await calendar.freebusy.query({
          requestBody: {
            timeMin: new Date(range.startMs).toISOString(),
            timeMax: new Date(range.endMs).toISOString(),
            timeZone,
            items: calendarIds.map((id) => ({ id }))
          }
        });
        const slots = findFreeSlots({
          range,
          busy: freeBusyIntervals(response.data),
          durationMinutes: args.durationMinutes,
          incrementMinutes: args.slotIncrementMinutes ?? Math.min(args.durationMinutes, 30),
          limit: args.limit ?? 10,
          timeZone,
          workingHours: args.workingHours
        });
        return jsonResult({
          ok: true,
          timeZone,
          calendars: calendarIds,
          durationMinutes: args.durationMinutes,
          workingHours: args.workingHours,
          slots,
          calendarErrors: freeBusyErrors(response.data)
        });
      } catch (error) {
        return jsonResult({ ok: false, error: safeErrorMessage(error) });
      }
    }
  );

  return { repository, server };
}

async function handleMcpHttpRequest(request: IncomingMessage, response: ServerResponse, config: GoogleCalendarConfig, path: string): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (request.method === "GET" && url.pathname === "/health") {
    response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}\n');
    return;
  }
  if (url.pathname !== path) {
    response.writeHead(404, { "content-type": "application/json" }).end('{"error":"Not found"}\n');
    return;
  }
  if (request.method !== "POST") {
    response
      .writeHead(405, { "content-type": "application/json" })
      .end('{"jsonrpc":"2.0","error":{"code":-32000,"message":"Method not allowed."},"id":null}\n');
    return;
  }

  const { repository, server } = createGoogleCalendarMcpServer(config);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    repository.close();
    void transport.close();
    void server.close();
  };
  response.once("close", cleanup);
  try {
    await server.connect(transport);
    await transport.handleRequest(request, response);
  } catch (error) {
    console.error(`Error handling Google Calendar MCP request: ${safeCalendarErrorMessage(error)}`);
    if (!response.headersSent) {
      response
        .writeHead(500, { "content-type": "application/json" })
        .end('{"jsonrpc":"2.0","error":{"code":-32603,"message":"Internal server error"},"id":null}\n');
    }
  } finally {
    if (response.writableEnded || response.destroyed) cleanup();
  }
}

function jsonResult(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function withoutRawJson<T extends { rawJson?: string }>(value: T): Omit<T, "rawJson"> {
  const { rawJson: _rawJson, ...rest } = value;
  return rest;
}

async function createCalendarClient(config: GoogleCalendarConfig, repository: GoogleCalendarRepository): Promise<calendar_v3.Calendar> {
  const auth = await createOAuthClientFromStoredToken(config, repository);
  return google.calendar({ version: "v3", auth });
}

function resolveWriteCalendarId(repository: GoogleCalendarRepository, calendarId: string | undefined): string {
  return calendarId ?? repository.getPrimaryCalendarId() ?? "primary";
}

function defaultFreeBusyCalendarIds(repository: GoogleCalendarRepository): string[] {
  const calendars = repository.listCalendars();
  const selected = calendars.filter((calendar) => calendar.selected && !calendar.hidden).map((calendar) => calendar.id);
  if (selected.length) {
    return selected;
  }
  const primary = repository.getPrimaryCalendarId();
  return primary ? [primary] : ["primary"];
}

function buildCreateEvent(args: {
  summary: string;
  description?: string;
  location?: string;
  startDateTime?: string;
  endDateTime?: string;
  startDate?: string;
  endDate?: string;
  timeZone?: string;
  attendees?: Array<{ email: string; optional?: boolean }>;
}): calendar_v3.Schema$Event {
  const event: calendar_v3.Schema$Event = { summary: args.summary };
  applyOptionalEventFields(event, args);
  applyEventTime(event, args);
  return event;
}

function buildPatchEvent(args: {
  summary?: string;
  description?: string;
  location?: string;
  startDateTime?: string;
  endDateTime?: string;
  startDate?: string;
  endDate?: string;
  timeZone?: string;
  attendees?: Array<{ email: string; optional?: boolean }>;
}): calendar_v3.Schema$Event {
  const event: calendar_v3.Schema$Event = {};
  if (args.summary !== undefined) {
    event.summary = args.summary;
  }
  applyOptionalEventFields(event, args);
  applyEventTime(event, args, true);
  if (Object.keys(event).length === 0) {
    throw new Error("At least one event field must be provided to update.");
  }
  return event;
}

function applyOptionalEventFields(
  event: calendar_v3.Schema$Event,
  args: { description?: string; location?: string; attendees?: Array<{ email: string; optional?: boolean }> }
): void {
  if (args.description !== undefined) {
    event.description = args.description;
  }
  if (args.location !== undefined) {
    event.location = args.location;
  }
  if (args.attendees !== undefined) {
    event.attendees = args.attendees.map((attendee) => ({ email: attendee.email, optional: attendee.optional }));
  }
}

function applyEventTime(
  event: calendar_v3.Schema$Event,
  args: { startDateTime?: string; endDateTime?: string; startDate?: string; endDate?: string; timeZone?: string },
  optional = false
): void {
  const hasTimed = args.startDateTime !== undefined || args.endDateTime !== undefined;
  const hasAllDay = args.startDate !== undefined || args.endDate !== undefined;
  if (hasTimed && hasAllDay) {
    throw new Error("Use either startDateTime/endDateTime for timed events or startDate/endDate for all-day events, not both.");
  }
  if (!hasTimed && !hasAllDay) {
    if (optional) {
      return;
    }
    throw new Error("Event time is required. Provide startDateTime/endDateTime or startDate/endDate.");
  }
  if (hasTimed) {
    if (!args.startDateTime || !args.endDateTime) {
      throw new Error("Timed events require both startDateTime and endDateTime.");
    }
    if (Date.parse(args.endDateTime) <= Date.parse(args.startDateTime)) {
      throw new Error("endDateTime must be after startDateTime.");
    }
    event.start = { dateTime: args.startDateTime, timeZone: args.timeZone };
    event.end = { dateTime: args.endDateTime, timeZone: args.timeZone };
    return;
  }

  if (!args.startDate || !args.endDate) {
    throw new Error("All-day events require both startDate and endDate. Google Calendar treats endDate as exclusive.");
  }
  if (args.endDate <= args.startDate) {
    throw new Error("endDate must be after startDate for all-day events. Google Calendar treats endDate as exclusive.");
  }
  event.start = { date: args.startDate };
  event.end = { date: args.endDate };
}

function eventResponse(event: calendar_v3.Schema$Event): Record<string, unknown> {
  return {
    id: event.id,
    status: event.status,
    summary: event.summary,
    description: event.description,
    location: event.location,
    htmlLink: event.htmlLink,
    start: event.start,
    end: event.end,
    attendees: event.attendees?.map((attendee) => ({ email: attendee.email, responseStatus: attendee.responseStatus, optional: attendee.optional })),
    updated: event.updated
  };
}

function parseTimeRange(timeMin: string, timeMax: string): { startMs: number; endMs: number } {
  const startMs = Date.parse(timeMin);
  const endMs = Date.parse(timeMax);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    throw new Error("timeMin and timeMax must be valid ISO date-times.");
  }
  if (endMs <= startMs) {
    throw new Error("timeMax must be after timeMin.");
  }
  if (endMs - startMs > 366 * 24 * 60 * 60 * 1000) {
    throw new Error("Free-time range must be 366 days or shorter.");
  }
  return { startMs, endMs };
}

function freeBusyIntervals(response: calendar_v3.Schema$FreeBusyResponse): Array<{ startMs: number; endMs: number }> {
  const busy: Array<{ startMs: number; endMs: number }> = [];
  for (const calendar of Object.values(response.calendars ?? {})) {
    for (const interval of calendar.busy ?? []) {
      if (!interval.start || !interval.end) {
        continue;
      }
      const startMs = Date.parse(interval.start);
      const endMs = Date.parse(interval.end);
      if (!Number.isNaN(startMs) && !Number.isNaN(endMs) && endMs > startMs) {
        busy.push({ startMs, endMs });
      }
    }
  }
  return mergeIntervals(busy);
}

function freeBusyErrors(response: calendar_v3.Schema$FreeBusyResponse): Array<{ calendarId: string; reason?: string; domain?: string }> {
  const errors: Array<{ calendarId: string; reason?: string; domain?: string }> = [];
  for (const [calendarId, calendar] of Object.entries(response.calendars ?? {})) {
    for (const error of calendar.errors ?? []) {
      errors.push({ calendarId, reason: error.reason ?? undefined, domain: error.domain ?? undefined });
    }
  }
  return errors;
}

function findFreeSlots(options: {
  range: { startMs: number; endMs: number };
  busy: Array<{ startMs: number; endMs: number }>;
  durationMinutes: number;
  incrementMinutes: number;
  limit: number;
  timeZone: string;
  workingHours?: { startTime: string; endTime: string; daysOfWeek?: number[] };
}): Array<{ start: string; end: string; localStart: string; localEnd: string }> {
  const durationMs = options.durationMinutes * 60 * 1000;
  const incrementMs = options.incrementMinutes * 60 * 1000;
  const windows = availabilityWindows(options.range, options.timeZone, options.workingHours);
  const slots: Array<{ start: string; end: string; localStart: string; localEnd: string }> = [];

  for (const window of windows) {
    let cursor = window.startMs;
    for (const interval of options.busy) {
      if (interval.endMs <= cursor || interval.startMs >= window.endMs) {
        continue;
      }
      addSlots(slots, cursor, Math.min(interval.startMs, window.endMs), durationMs, incrementMs, options.limit, options.timeZone);
      if (slots.length >= options.limit) {
        return slots;
      }
      cursor = Math.max(cursor, interval.endMs);
      if (cursor >= window.endMs) {
        break;
      }
    }
    addSlots(slots, cursor, window.endMs, durationMs, incrementMs, options.limit, options.timeZone);
    if (slots.length >= options.limit) {
      return slots;
    }
  }
  return slots;
}

function availabilityWindows(
  range: { startMs: number; endMs: number },
  timeZone: string,
  workingHours: { startTime: string; endTime: string; daysOfWeek?: number[] } | undefined
): Array<{ startMs: number; endMs: number }> {
  if (!workingHours) {
    return [{ startMs: range.startMs, endMs: range.endMs }];
  }

  const windows: Array<{ startMs: number; endMs: number }> = [];
  const days = new Set(workingHours.daysOfWeek ?? [1, 2, 3, 4, 5]);
  let date = dateStringInTimeZone(new Date(range.startMs), timeZone);
  for (let i = 0; i < 370; i += 1) {
    const dayStartMs = utcMsForLocalDateStart(date, timeZone);
    if (dayStartMs >= range.endMs) {
      break;
    }
    if (days.has(dayOfWeek(date))) {
      const startMs = dayStartMs + minutesSinceMidnight(workingHours.startTime) * 60 * 1000;
      let endMs = dayStartMs + minutesSinceMidnight(workingHours.endTime) * 60 * 1000;
      if (endMs <= startMs) {
        endMs += 24 * 60 * 60 * 1000;
      }
      const clippedStart = Math.max(startMs, range.startMs);
      const clippedEnd = Math.min(endMs, range.endMs);
      if (clippedEnd > clippedStart) {
        windows.push({ startMs: clippedStart, endMs: clippedEnd });
      }
    }
    date = addDays(date, 1);
  }
  return windows;
}

function addSlots(
  slots: Array<{ start: string; end: string; localStart: string; localEnd: string }>,
  startMs: number,
  endMs: number,
  durationMs: number,
  incrementMs: number,
  limit: number,
  timeZone: string
): void {
  for (let slotStartMs = startMs; slotStartMs + durationMs <= endMs && slots.length < limit; slotStartMs += incrementMs) {
    const slotEndMs = slotStartMs + durationMs;
    slots.push({
      start: new Date(slotStartMs).toISOString(),
      end: new Date(slotEndMs).toISOString(),
      localStart: formatLocalDateTime(slotStartMs, timeZone),
      localEnd: formatLocalDateTime(slotEndMs, timeZone)
    });
  }
}

function mergeIntervals(intervals: Array<{ startMs: number; endMs: number }>): Array<{ startMs: number; endMs: number }> {
  const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs);
  const merged: Array<{ startMs: number; endMs: number }> = [];
  for (const interval of sorted) {
    const last = merged.at(-1);
    if (!last || interval.startMs > last.endMs) {
      merged.push({ ...interval });
      continue;
    }
    last.endMs = Math.max(last.endMs, interval.endMs);
  }
  return merged;
}

function minutesSinceMidnight(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function dayOfWeek(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function formatLocalDateTime(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).formatToParts(new Date(ms));
  const value = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")}`;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message.replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]");
  }
  return String(error).replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]");
}

export const googleCalendarMcpServerTestHooks = {
  buildCreateEvent,
  buildPatchEvent,
  parseTimeRange,
  freeBusyIntervals,
  freeBusyErrors,
  findFreeSlots,
  safeErrorMessage
};
