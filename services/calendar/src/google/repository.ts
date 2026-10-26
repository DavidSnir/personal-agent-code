import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";
import type { calendar_v3 } from "googleapis";

import type { GoogleCalendarConfig } from "./config.js";
import { addDays, assertDateString, dateStringInTimeZone, utcMsForLocalDateStart } from "./time.js";

type SqliteDatabase = Database.Database;

export type StoredOAuthToken = {
  accountEmail?: string;
  refreshToken: string;
  accessToken?: string;
  expiryDate?: number;
  scope?: string;
  tokenType?: string;
  updatedAt: number;
};

export type StoredOAuthClientCredentials = {
  clientId: string;
  clientSecret: string;
  updatedAt: number;
};

export type CalendarRecord = {
  id: string;
  summary?: string;
  description?: string;
  primary: boolean;
  accessRole?: string;
  timeZone?: string;
  backgroundColor?: string;
  foregroundColor?: string;
  hidden: boolean;
  selected: boolean;
  etag?: string;
  rawJson: string;
  updatedAt: number;
};

export type CalendarSyncStateRecord = {
  calendarId: string;
  syncToken?: string;
  syncPastDays?: number;
  syncFutureDays?: number;
  lastFullSyncAt?: number;
  lastIncrementalSyncAt?: number;
  lastSuccessAt?: number;
  lastError?: string;
  lastAttemptAt?: number;
};

export type CalendarEventRecord = {
  calendarId: string;
  eventId: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  startDateTime?: string;
  endDateTime?: string;
  startTimeZone?: string;
  endTimeZone?: string;
  startUtcMs?: number;
  endUtcMs?: number;
  allDay: boolean;
  startDate?: string;
  endDate?: string;
  recurringEventId?: string;
  originalStartTimeJson?: string;
  organizerJson?: string;
  creatorJson?: string;
  attendeesJson?: string;
  etag?: string;
  updated?: string;
  updatedAt: number;
  deleted: boolean;
  rawJson: string;
};

export type CalendarStatus = {
  runtimeDirectory: string;
  currentDirectory: string;
  dbPath: string;
  credentials: { configured: boolean; credentialsPath?: string };
  token: { present: boolean; accountEmail?: string; updatedAt?: number };
  syncWindow: { pastDays: number; futureDays: number; intervalSeconds: number };
  calendarCount: number;
  eventCount: number;
  states: CalendarSyncStateRecord[];
};

export class GoogleCalendarRepository {
  readonly dbPath: string;
  private readonly db: SqliteDatabase;

  constructor(dbPath: string) {
    this.dbPath = resolve(dbPath);
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
  }

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS google_oauth_tokens (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        account_email TEXT,
        refresh_token TEXT NOT NULL,
        access_token TEXT,
        expiry_date INTEGER,
        scope TEXT,
        token_type TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS google_oauth_client_credentials (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        client_id TEXT NOT NULL,
        client_secret TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS calendars (
        id TEXT PRIMARY KEY,
        summary TEXT,
        description TEXT,
        primary_calendar INTEGER NOT NULL DEFAULT 0,
        access_role TEXT,
        time_zone TEXT,
        background_color TEXT,
        foreground_color TEXT,
        hidden INTEGER NOT NULL DEFAULT 0,
        selected INTEGER NOT NULL DEFAULT 0,
        etag TEXT,
        raw_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS calendar_sync_state (
        calendar_id TEXT PRIMARY KEY,
        sync_token TEXT,
        sync_past_days INTEGER,
        sync_future_days INTEGER,
        last_full_sync_at INTEGER,
        last_incremental_sync_at INTEGER,
        last_success_at INTEGER,
        last_error TEXT,
        last_attempt_at INTEGER,
        FOREIGN KEY(calendar_id) REFERENCES calendars(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS events (
        calendar_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        status TEXT,
        summary TEXT,
        description TEXT,
        location TEXT,
        html_link TEXT,
        start_date_time TEXT,
        end_date_time TEXT,
        start_time_zone TEXT,
        end_time_zone TEXT,
        start_utc_ms INTEGER,
        end_utc_ms INTEGER,
        all_day INTEGER NOT NULL DEFAULT 0,
        start_date TEXT,
        end_date TEXT,
        recurring_event_id TEXT,
        original_start_time_json TEXT,
        organizer_json TEXT,
        creator_json TEXT,
        attendees_json TEXT,
        etag TEXT,
        updated TEXT,
        updated_at INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0,
        raw_json TEXT NOT NULL,
        PRIMARY KEY(calendar_id, event_id),
        FOREIGN KEY(calendar_id) REFERENCES calendars(id) ON DELETE CASCADE
      );

      CREATE UNIQUE INDEX IF NOT EXISTS events_calendar_event_idx ON events(calendar_id, event_id);
      CREATE INDEX IF NOT EXISTS events_timed_range_idx ON events(start_utc_ms, end_utc_ms);
      CREATE INDEX IF NOT EXISTS events_all_day_date_range_idx ON events(all_day, start_date, end_date);
      CREATE INDEX IF NOT EXISTS events_calendar_deleted_idx ON events(calendar_id, deleted);
    `);
  }

  close(): void {
    this.db.close();
  }

  saveOAuthToken(token: Omit<StoredOAuthToken, "updatedAt">): void {
    this.db
      .prepare(
        `INSERT INTO google_oauth_tokens (id, account_email, refresh_token, access_token, expiry_date, scope, token_type, updated_at)
         VALUES (1, @accountEmail, @refreshToken, @accessToken, @expiryDate, @scope, @tokenType, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           account_email = excluded.account_email,
           refresh_token = excluded.refresh_token,
           access_token = excluded.access_token,
           expiry_date = excluded.expiry_date,
           scope = excluded.scope,
           token_type = excluded.token_type,
           updated_at = excluded.updated_at`
      )
      .run({ ...token, updatedAt: Date.now() });
  }

  getOAuthToken(): StoredOAuthToken | undefined {
    const row = this.db.prepare("SELECT * FROM google_oauth_tokens WHERE id = 1").get() as OAuthTokenRow | undefined;
    if (!row) {
      return undefined;
    }
    return {
      accountEmail: row.account_email ?? undefined,
      refreshToken: row.refresh_token,
      accessToken: row.access_token ?? undefined,
      expiryDate: row.expiry_date ?? undefined,
      scope: row.scope ?? undefined,
      tokenType: row.token_type ?? undefined,
      updatedAt: row.updated_at
    };
  }

  saveOAuthClientCredentials(credentials: Omit<StoredOAuthClientCredentials, "updatedAt">): void {
    this.db
      .prepare(
        `INSERT INTO google_oauth_client_credentials (id, client_id, client_secret, updated_at)
         VALUES (1, @clientId, @clientSecret, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           client_id = excluded.client_id,
           client_secret = excluded.client_secret,
           updated_at = excluded.updated_at`
      )
      .run({ ...credentials, updatedAt: Date.now() });
  }

  getOAuthClientCredentials(): StoredOAuthClientCredentials | undefined {
    const row = this.db.prepare("SELECT * FROM google_oauth_client_credentials WHERE id = 1").get() as OAuthClientCredentialsRow | undefined;
    if (!row) {
      return undefined;
    }
    return {
      clientId: row.client_id,
      clientSecret: row.client_secret,
      updatedAt: row.updated_at
    };
  }

  upsertCalendar(calendar: calendar_v3.Schema$CalendarListEntry): void {
    if (!calendar.id) {
      return;
    }
    this.db
      .prepare(
        `INSERT INTO calendars (
           id, summary, description, primary_calendar, access_role, time_zone, background_color,
           foreground_color, hidden, selected, etag, raw_json, updated_at
         ) VALUES (
           @id, @summary, @description, @primaryCalendar, @accessRole, @timeZone, @backgroundColor,
           @foregroundColor, @hidden, @selected, @etag, @rawJson, @updatedAt
         ) ON CONFLICT(id) DO UPDATE SET
           summary = excluded.summary,
           description = excluded.description,
           primary_calendar = excluded.primary_calendar,
           access_role = excluded.access_role,
           time_zone = excluded.time_zone,
           background_color = excluded.background_color,
           foreground_color = excluded.foreground_color,
           hidden = excluded.hidden,
           selected = excluded.selected,
           etag = excluded.etag,
           raw_json = excluded.raw_json,
           updated_at = excluded.updated_at`
      )
      .run({
        id: calendar.id,
        summary: calendar.summary ?? null,
        description: calendar.description ?? null,
        primaryCalendar: calendar.primary ? 1 : 0,
        accessRole: calendar.accessRole ?? null,
        timeZone: calendar.timeZone ?? null,
        backgroundColor: calendar.backgroundColor ?? null,
        foregroundColor: calendar.foregroundColor ?? null,
        hidden: calendar.hidden ? 1 : 0,
        selected: calendar.selected === false ? 0 : 1,
        etag: calendar.etag ?? null,
        rawJson: JSON.stringify(calendar),
        updatedAt: Date.now()
      });
  }

  listCalendars(): CalendarRecord[] {
    const rows = this.db.prepare("SELECT * FROM calendars ORDER BY primary_calendar DESC, summary COLLATE NOCASE, id").all() as CalendarRow[];
    return rows.map(toCalendarRecord);
  }

  hasCalendar(calendarId: string): boolean {
    const row = this.db.prepare("SELECT 1 AS present FROM calendars WHERE id = ? LIMIT 1").get(calendarId) as { present: number } | undefined;
    return Boolean(row);
  }

  getPrimaryCalendarId(): string | undefined {
    const row = this.db.prepare("SELECT id FROM calendars WHERE primary_calendar = 1 LIMIT 1").get() as { id: string } | undefined;
    return row?.id;
  }

  getDefaultTimeZone(): string {
    const row = this.db
      .prepare("SELECT time_zone FROM calendars WHERE primary_calendar = 1 AND time_zone IS NOT NULL LIMIT 1")
      .get() as { time_zone?: string } | undefined;
    return row?.time_zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  }

  getSyncState(calendarId: string): CalendarSyncStateRecord | undefined {
    const row = this.db.prepare("SELECT * FROM calendar_sync_state WHERE calendar_id = ?").get(calendarId) as SyncStateRow | undefined;
    return row ? toSyncStateRecord(row) : undefined;
  }

  listSyncStates(): CalendarSyncStateRecord[] {
    const rows = this.db.prepare("SELECT * FROM calendar_sync_state ORDER BY calendar_id").all() as SyncStateRow[];
    return rows.map(toSyncStateRecord);
  }

  markSyncAttempt(calendarId: string, config: GoogleCalendarConfig): void {
    this.db
      .prepare(
        `INSERT INTO calendar_sync_state (calendar_id, sync_past_days, sync_future_days, last_attempt_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(calendar_id) DO UPDATE SET
           sync_past_days = excluded.sync_past_days,
           sync_future_days = excluded.sync_future_days,
           last_attempt_at = excluded.last_attempt_at`
      )
      .run(calendarId, config.syncPastDays, config.syncFutureDays, Date.now());
  }

  markSyncSuccess(calendarId: string, syncToken: string | undefined, fullSync: boolean, config: GoogleCalendarConfig): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO calendar_sync_state (
           calendar_id, sync_token, sync_past_days, sync_future_days, last_full_sync_at,
           last_incremental_sync_at, last_success_at, last_error, last_attempt_at
         ) VALUES (
           @calendarId, @syncToken, @syncPastDays, @syncFutureDays, @lastFullSyncAt,
           @lastIncrementalSyncAt, @lastSuccessAt, NULL, @lastAttemptAt
         ) ON CONFLICT(calendar_id) DO UPDATE SET
           sync_token = excluded.sync_token,
           sync_past_days = excluded.sync_past_days,
           sync_future_days = excluded.sync_future_days,
           last_full_sync_at = COALESCE(excluded.last_full_sync_at, calendar_sync_state.last_full_sync_at),
           last_incremental_sync_at = COALESCE(excluded.last_incremental_sync_at, calendar_sync_state.last_incremental_sync_at),
           last_success_at = excluded.last_success_at,
           last_error = NULL,
           last_attempt_at = excluded.last_attempt_at`
      )
      .run({
        calendarId,
        syncToken: syncToken ?? null,
        syncPastDays: config.syncPastDays,
        syncFutureDays: config.syncFutureDays,
        lastFullSyncAt: fullSync ? now : null,
        lastIncrementalSyncAt: fullSync ? null : now,
        lastSuccessAt: now,
        lastAttemptAt: now
      });
  }

  markSyncError(calendarId: string, error: string, config: GoogleCalendarConfig): void {
    this.db
      .prepare(
        `INSERT INTO calendar_sync_state (calendar_id, sync_past_days, sync_future_days, last_error, last_attempt_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(calendar_id) DO UPDATE SET
           sync_past_days = excluded.sync_past_days,
           sync_future_days = excluded.sync_future_days,
           last_error = excluded.last_error,
           last_attempt_at = excluded.last_attempt_at`
      )
      .run(calendarId, config.syncPastDays, config.syncFutureDays, error, Date.now());
  }

  clearCalendarCache(calendarId: string): void {
    const transaction = this.db.transaction(() => {
      this.db.prepare("DELETE FROM events WHERE calendar_id = ?").run(calendarId);
      this.db.prepare("DELETE FROM calendar_sync_state WHERE calendar_id = ?").run(calendarId);
    });
    transaction();
  }

  upsertEvent(calendarId: string, event: calendar_v3.Schema$Event): void {
    if (!event.id) {
      return;
    }
    const normalized = normalizeEvent(calendarId, event);
    this.db
      .prepare(
        `INSERT INTO events (
           calendar_id, event_id, status, summary, description, location, html_link, start_date_time,
           end_date_time, start_time_zone, end_time_zone, start_utc_ms, end_utc_ms, all_day,
           start_date, end_date, recurring_event_id, original_start_time_json, organizer_json,
           creator_json, attendees_json, etag, updated, updated_at, deleted, raw_json
         ) VALUES (
           @calendarId, @eventId, @status, @summary, @description, @location, @htmlLink, @startDateTime,
           @endDateTime, @startTimeZone, @endTimeZone, @startUtcMs, @endUtcMs, @allDay,
           @startDate, @endDate, @recurringEventId, @originalStartTimeJson, @organizerJson,
           @creatorJson, @attendeesJson, @etag, @updated, @updatedAt, @deleted, @rawJson
         ) ON CONFLICT(calendar_id, event_id) DO UPDATE SET
           status = excluded.status,
           summary = excluded.summary,
           description = excluded.description,
           location = excluded.location,
           html_link = excluded.html_link,
           start_date_time = excluded.start_date_time,
           end_date_time = excluded.end_date_time,
           start_time_zone = excluded.start_time_zone,
           end_time_zone = excluded.end_time_zone,
           start_utc_ms = excluded.start_utc_ms,
           end_utc_ms = excluded.end_utc_ms,
           all_day = excluded.all_day,
           start_date = excluded.start_date,
           end_date = excluded.end_date,
           recurring_event_id = excluded.recurring_event_id,
           original_start_time_json = excluded.original_start_time_json,
           organizer_json = excluded.organizer_json,
           creator_json = excluded.creator_json,
           attendees_json = excluded.attendees_json,
           etag = excluded.etag,
           updated = excluded.updated,
           updated_at = excluded.updated_at,
           deleted = excluded.deleted,
           raw_json = excluded.raw_json`
      )
      .run({ ...normalized, allDay: normalized.allDay ? 1 : 0, deleted: normalized.deleted ? 1 : 0 });
  }

  viewDay(date: string, timeZone?: string, calendarIds?: string[]): CalendarEventRecord[] {
    assertDateString(date, "date");
    return this.viewRange(date, addDays(date, 1), timeZone, calendarIds);
  }

  viewRange(startDate: string, endDate: string, timeZone?: string, calendarIds?: string[]): CalendarEventRecord[] {
    assertDateString(startDate, "startDate");
    assertDateString(endDate, "endDate");
    const zone = timeZone ?? this.getDefaultTimeZone();
    const startMs = utcMsForLocalDateStart(startDate, zone);
    const endMs = utcMsForLocalDateStart(endDate, zone);
    const { clause, params } = calendarFilter(calendarIds);
    const rows = this.db
      .prepare(
        `SELECT * FROM events
         WHERE deleted = 0
           ${clause}
           AND (
             (all_day = 0 AND start_utc_ms < ? AND end_utc_ms > ?)
             OR (all_day = 1 AND start_date < ? AND end_date > ?)
           )
         ORDER BY all_day DESC, COALESCE(start_utc_ms, 0), COALESCE(start_date, ''), summary COLLATE NOCASE`
      )
      .all(...params, endMs, startMs, endDate, startDate) as EventRow[];
    return rows.map(toEventRecord);
  }

  searchEvents(query: string, options: { startDate?: string; endDate?: string; timeZone?: string; calendarIds?: string[]; limit: number }): CalendarEventRecord[] {
    if (options.startDate) {
      assertDateString(options.startDate, "startDate");
    }
    if (options.endDate) {
      assertDateString(options.endDate, "endDate");
    }
    const { clause, params } = calendarFilter(options.calendarIds);
    const where: string[] = ["deleted = 0", clause, "(summary LIKE ? OR description LIKE ? OR location LIKE ?)"];
    const values: unknown[] = [...params, `%${query}%`, `%${query}%`, `%${query}%`];
    if (options.startDate && options.endDate) {
      const zone = options.timeZone ?? this.getDefaultTimeZone();
      where.push("((all_day = 0 AND start_utc_ms < ? AND end_utc_ms > ?) OR (all_day = 1 AND start_date < ? AND end_date > ?))");
      values.push(utcMsForLocalDateStart(options.endDate, zone), utcMsForLocalDateStart(options.startDate, zone), options.endDate, options.startDate);
    }
    values.push(options.limit);
    const rows = this.db
      .prepare(
        `SELECT * FROM events
         WHERE ${where.filter(Boolean).join(" AND ")}
         ORDER BY all_day DESC, COALESCE(start_utc_ms, 0), COALESCE(start_date, ''), summary COLLATE NOCASE
         LIMIT ?`
      )
      .all(...values) as EventRow[];
    return rows.map(toEventRecord);
  }

  nextEvents(options: { timeZone?: string; calendarIds?: string[]; limit: number }): CalendarEventRecord[] {
    const zone = options.timeZone ?? this.getDefaultTimeZone();
    const today = dateStringInTimeZone(new Date(), zone);
    const now = Date.now();
    const { clause, params } = calendarFilter(options.calendarIds);
    const rows = this.db
      .prepare(
        `SELECT * FROM events
         WHERE deleted = 0
           ${clause}
           AND ((all_day = 0 AND end_utc_ms >= ?) OR (all_day = 1 AND end_date > ?))
         ORDER BY all_day ASC, COALESCE(start_utc_ms, 9223372036854775807), COALESCE(start_date, '9999-12-31'), summary COLLATE NOCASE
         LIMIT ?`
      )
      .all(...params, now, today, options.limit) as EventRow[];
    return rows.map(toEventRecord);
  }

  getStatus(config: GoogleCalendarConfig): CalendarStatus {
    const token = this.getOAuthToken();
    const calendarCount = (this.db.prepare("SELECT COUNT(*) AS count FROM calendars").get() as { count: number }).count;
    const eventCount = (this.db.prepare("SELECT COUNT(*) AS count FROM events").get() as { count: number }).count;
    return {
      runtimeDirectory: config.runtimeDirectory,
      currentDirectory: process.cwd(),
      dbPath: this.dbPath,
      credentials: {
        configured: Boolean(config.clientId && config.clientSecret),
        credentialsPath: config.credentialsPath
      },
      token: { present: Boolean(token), accountEmail: token?.accountEmail, updatedAt: token?.updatedAt },
      syncWindow: {
        pastDays: config.syncPastDays,
        futureDays: config.syncFutureDays,
        intervalSeconds: config.syncIntervalSeconds
      },
      calendarCount,
      eventCount,
      states: this.listSyncStates()
    };
  }
}

function normalizeEvent(calendarId: string, event: calendar_v3.Schema$Event): CalendarEventRecord {
  const start = event.start;
  const end = event.end;
  const allDay = Boolean(start?.date);
  return {
    calendarId,
    eventId: event.id ?? "",
    status: event.status ?? undefined,
    summary: event.summary ?? undefined,
    description: event.description ?? undefined,
    location: event.location ?? undefined,
    htmlLink: event.htmlLink ?? undefined,
    startDateTime: start?.dateTime ?? undefined,
    endDateTime: end?.dateTime ?? undefined,
    startTimeZone: start?.timeZone ?? undefined,
    endTimeZone: end?.timeZone ?? undefined,
    startUtcMs: start?.dateTime ? Date.parse(start.dateTime) : undefined,
    endUtcMs: end?.dateTime ? Date.parse(end.dateTime) : undefined,
    allDay,
    startDate: start?.date ?? undefined,
    endDate: end?.date ?? undefined,
    recurringEventId: event.recurringEventId ?? undefined,
    originalStartTimeJson: event.originalStartTime ? JSON.stringify(event.originalStartTime) : undefined,
    organizerJson: event.organizer ? JSON.stringify(event.organizer) : undefined,
    creatorJson: event.creator ? JSON.stringify(event.creator) : undefined,
    attendeesJson: event.attendees ? JSON.stringify(event.attendees) : undefined,
    etag: event.etag ?? undefined,
    updated: event.updated ?? undefined,
    updatedAt: Date.now(),
    deleted: event.status === "cancelled",
    rawJson: JSON.stringify(event)
  };
}

function calendarFilter(calendarIds: string[] | undefined): { clause: string; params: string[] } {
  if (!calendarIds?.length) {
    return { clause: "", params: [] };
  }
  return { clause: `AND calendar_id IN (${calendarIds.map(() => "?").join(", ")})`, params: calendarIds };
}

function toCalendarRecord(row: CalendarRow): CalendarRecord {
  return {
    id: row.id,
    summary: row.summary ?? undefined,
    description: row.description ?? undefined,
    primary: Boolean(row.primary_calendar),
    accessRole: row.access_role ?? undefined,
    timeZone: row.time_zone ?? undefined,
    backgroundColor: row.background_color ?? undefined,
    foregroundColor: row.foreground_color ?? undefined,
    hidden: Boolean(row.hidden),
    selected: Boolean(row.selected),
    etag: row.etag ?? undefined,
    rawJson: row.raw_json,
    updatedAt: row.updated_at
  };
}

function toSyncStateRecord(row: SyncStateRow): CalendarSyncStateRecord {
  return {
    calendarId: row.calendar_id,
    syncToken: row.sync_token ?? undefined,
    syncPastDays: row.sync_past_days ?? undefined,
    syncFutureDays: row.sync_future_days ?? undefined,
    lastFullSyncAt: row.last_full_sync_at ?? undefined,
    lastIncrementalSyncAt: row.last_incremental_sync_at ?? undefined,
    lastSuccessAt: row.last_success_at ?? undefined,
    lastError: row.last_error ?? undefined,
    lastAttemptAt: row.last_attempt_at ?? undefined
  };
}

function toEventRecord(row: EventRow): CalendarEventRecord {
  return {
    calendarId: row.calendar_id,
    eventId: row.event_id,
    status: row.status ?? undefined,
    summary: row.summary ?? undefined,
    description: row.description ?? undefined,
    location: row.location ?? undefined,
    htmlLink: row.html_link ?? undefined,
    startDateTime: row.start_date_time ?? undefined,
    endDateTime: row.end_date_time ?? undefined,
    startTimeZone: row.start_time_zone ?? undefined,
    endTimeZone: row.end_time_zone ?? undefined,
    startUtcMs: row.start_utc_ms ?? undefined,
    endUtcMs: row.end_utc_ms ?? undefined,
    allDay: Boolean(row.all_day),
    startDate: row.start_date ?? undefined,
    endDate: row.end_date ?? undefined,
    recurringEventId: row.recurring_event_id ?? undefined,
    originalStartTimeJson: row.original_start_time_json ?? undefined,
    organizerJson: row.organizer_json ?? undefined,
    creatorJson: row.creator_json ?? undefined,
    attendeesJson: row.attendees_json ?? undefined,
    etag: row.etag ?? undefined,
    updated: row.updated ?? undefined,
    updatedAt: row.updated_at,
    deleted: Boolean(row.deleted),
    rawJson: row.raw_json
  };
}

type OAuthTokenRow = {
  account_email: string | null;
  refresh_token: string;
  access_token: string | null;
  expiry_date: number | null;
  scope: string | null;
  token_type: string | null;
  updated_at: number;
};

type OAuthClientCredentialsRow = {
  client_id: string;
  client_secret: string;
  updated_at: number;
};

type CalendarRow = {
  id: string;
  summary: string | null;
  description: string | null;
  primary_calendar: number;
  access_role: string | null;
  time_zone: string | null;
  background_color: string | null;
  foreground_color: string | null;
  hidden: number;
  selected: number;
  etag: string | null;
  raw_json: string;
  updated_at: number;
};

type SyncStateRow = {
  calendar_id: string;
  sync_token: string | null;
  sync_past_days: number | null;
  sync_future_days: number | null;
  last_full_sync_at: number | null;
  last_incremental_sync_at: number | null;
  last_success_at: number | null;
  last_error: string | null;
  last_attempt_at: number | null;
};

type EventRow = {
  calendar_id: string;
  event_id: string;
  status: string | null;
  summary: string | null;
  description: string | null;
  location: string | null;
  html_link: string | null;
  start_date_time: string | null;
  end_date_time: string | null;
  start_time_zone: string | null;
  end_time_zone: string | null;
  start_utc_ms: number | null;
  end_utc_ms: number | null;
  all_day: number;
  start_date: string | null;
  end_date: string | null;
  recurring_event_id: string | null;
  original_start_time_json: string | null;
  organizer_json: string | null;
  creator_json: string | null;
  attendees_json: string | null;
  etag: string | null;
  updated: string | null;
  updated_at: number;
  deleted: number;
  raw_json: string;
};
