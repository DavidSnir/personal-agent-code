import { google } from "googleapis";
import type { calendar_v3 } from "googleapis";

import type { GoogleCalendarConfig } from "./config.js";
import { safeCalendarErrorMessage } from "./calendarError.js";
import { createOAuthClientFromStoredToken } from "./oauth.js";
import type { GoogleCalendarRepository } from "./repository.js";

export type GoogleCalendarSyncResult = {
  calendarsSeen: number;
  calendarsSynced: number;
  calendarErrors: Array<{ calendarId: string; error: string }>;
};

export class GoogleCalendarSync {
  constructor(
    private readonly config: GoogleCalendarConfig,
    private readonly repository: GoogleCalendarRepository
  ) {}

  async runOnce(): Promise<GoogleCalendarSyncResult> {
    const auth = await createOAuthClientFromStoredToken(this.config, this.repository);
    const calendar = google.calendar({ version: "v3", auth });
    const calendars = await this.syncCalendarList(calendar);
    const result: GoogleCalendarSyncResult = { calendarsSeen: calendars.length, calendarsSynced: 0, calendarErrors: [] };

    for (const entry of calendars) {
      if (!entry.id) {
        continue;
      }
      try {
        await this.syncCalendar(calendar, entry.id);
        result.calendarsSynced += 1;
      } catch (error) {
        const message = errorMessage(error);
        this.repository.markSyncError(entry.id, message, this.config);
        result.calendarErrors.push({ calendarId: entry.id, error: message });
      }
    }

    return result;
  }

  private async syncCalendarList(calendar: calendar_v3.Calendar): Promise<calendar_v3.Schema$CalendarListEntry[]> {
    const calendars: calendar_v3.Schema$CalendarListEntry[] = [];
    let pageToken: string | undefined;
    do {
      const response = await calendar.calendarList.list({ pageToken, maxResults: 250 });
      for (const entry of response.data.items ?? []) {
        this.repository.upsertCalendar(entry);
        calendars.push(entry);
      }
      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);
    return calendars;
  }

  private async syncCalendar(calendar: calendar_v3.Calendar, calendarId: string): Promise<void> {
    const state = this.repository.getSyncState(calendarId);
    const windowChanged =
      state?.syncPastDays !== undefined &&
      state?.syncFutureDays !== undefined &&
      (state.syncPastDays !== this.config.syncPastDays || state.syncFutureDays !== this.config.syncFutureDays);

    if (!state?.syncToken || windowChanged) {
      if (windowChanged) {
        this.repository.clearCalendarCache(calendarId);
      }
      await this.fullSync(calendar, calendarId);
      return;
    }

    try {
      await this.incrementalSync(calendar, calendarId, state.syncToken);
    } catch (error) {
      if (isSyncTokenGone(error)) {
        this.repository.clearCalendarCache(calendarId);
        await this.fullSync(calendar, calendarId);
        return;
      }
      throw error;
    }
  }

  private async fullSync(calendar: calendar_v3.Calendar, calendarId: string): Promise<void> {
    this.repository.markSyncAttempt(calendarId, this.config);
    const now = Date.now();
    const timeMin = new Date(now - this.config.syncPastDays * 24 * 60 * 60 * 1000).toISOString();
    const timeMax = new Date(now + this.config.syncFutureDays * 24 * 60 * 60 * 1000).toISOString();
    const syncToken = await this.listAndStoreEvents(calendar, {
      calendarId,
      singleEvents: true,
      showDeleted: true,
      timeMin,
      timeMax,
      maxResults: 2500
    });
    this.repository.markSyncSuccess(calendarId, syncToken, true, this.config);
  }

  private async incrementalSync(calendar: calendar_v3.Calendar, calendarId: string, syncToken: string): Promise<void> {
    this.repository.markSyncAttempt(calendarId, this.config);
    const nextSyncToken = await this.listAndStoreEvents(calendar, {
      calendarId,
      singleEvents: true,
      showDeleted: true,
      syncToken,
      maxResults: 2500
    });
    this.repository.markSyncSuccess(calendarId, nextSyncToken, false, this.config);
  }

  private async listAndStoreEvents(calendar: calendar_v3.Calendar, request: calendar_v3.Params$Resource$Events$List): Promise<string | undefined> {
    if (!request.calendarId) {
      throw new Error("calendarId is required for event sync");
    }
    let pageToken: string | undefined;
    let nextSyncToken: string | undefined;
    do {
      const response = await calendar.events.list({ ...request, pageToken });
      for (const event of response.data.items ?? []) {
        this.repository.upsertEvent(request.calendarId, event);
      }
      pageToken = response.data.nextPageToken ?? undefined;
      nextSyncToken = response.data.nextSyncToken ?? nextSyncToken;
    } while (pageToken);
    return nextSyncToken;
  }
}

function isSyncTokenGone(error: unknown): boolean {
  const candidate = error as { code?: number; status?: number; response?: { status?: number } };
  return candidate.code === 410 || candidate.status === 410 || candidate.response?.status === 410;
}

function errorMessage(error: unknown): string {
  return safeCalendarErrorMessage(error);
}
