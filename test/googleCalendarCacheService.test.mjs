import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as waitImmediate } from "node:timers/promises";
import test from "node:test";

import { GoogleCalendarSync } from "../dist/services/calendar/src/google/sync.js";
import {
  calendarReauthorizationMessage,
  isInvalidGrantError,
  safeCalendarErrorMessage
} from "../dist/services/calendar/src/google/calendarError.js";
import { GoogleCalendarCacheService } from "../dist/services/calendar/src/googleCalendarCacheService.js";

test("Google Calendar cache stop waits for in-flight initial sync before closing DB", async () => {
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "personal-agent-calendar-cache-"));
  const originalRunOnce = GoogleCalendarSync.prototype.runOnce;
  let resolveSyncStarted;
  let resolveSyncCanFinish;
  const syncStarted = new Promise((resolve) => {
    resolveSyncStarted = resolve;
  });
  const syncCanFinish = new Promise((resolve) => {
    resolveSyncCanFinish = resolve;
  });
  let repositoryWasOpenDuringStop = false;
  let stopped = false;

  GoogleCalendarSync.prototype.runOnce = async function runOnceTestDouble() {
    resolveSyncStarted();
    await syncCanFinish;
    this.repository.getOAuthClientCredentials();
    repositoryWasOpenDuringStop = true;
    return { calendarsSeen: 0, calendarsSynced: 0, calendarErrors: [] };
  };

  const service = new GoogleCalendarCacheService({
    enabled: true,
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    dbPath: join(runtimeDirectory, "data/google-calendar/google-calendar.sqlite"),
    syncPastDays: 30,
    syncFutureDays: 90,
    syncIntervalSeconds: 3600,
    authRedirectPort: 0,
    runtimeDirectory
  });

  try {
    await service.start();
    await syncStarted;

    const stopPromise = service.stop().then(() => {
      stopped = true;
    });
    await waitImmediate();
    assert.equal(stopped, false);

    resolveSyncCanFinish();
    await stopPromise;
    assert.equal(repositoryWasOpenDuringStop, true);
  } finally {
    GoogleCalendarSync.prototype.runOnce = originalRunOnce;
    if (!stopped) {
      resolveSyncCanFinish();
      await service.stop().catch(() => undefined);
    }
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

test("detects nested and causal invalid_grant errors without inspecting unrelated text", () => {
  assert.equal(isInvalidGrantError({ response: { data: { error: "invalid_grant" } } }), true);
  assert.equal(isInvalidGrantError(new Error("refresh failed", { cause: { code: "invalid_grant" } })), true);
  assert.equal(isInvalidGrantError(new Error("invalid_grant: token expired")), true);
  assert.equal(isInvalidGrantError(new Error("request failed with status 500")), false);
});

test("Calendar worker messages are actionable and redact credential values", () => {
  const runtimeDirectory = "/runtime/calendar folder";
  const message = calendarReauthorizationMessage(runtimeDirectory);
  assert.match(message, /authorization has expired or been revoked/);
  assert.match(message, /OAuth is never started by the worker/);
  assert.match(message, /dagent --runtime-directory "\/runtime\/calendar folder" services auth calendar/);

  const sanitized = safeCalendarErrorMessage(
    new Error('Bearer access-secret?client_secret=query-secret&client_id=query-id {"refresh_token":"refresh-secret"}')
  );
  assert.doesNotMatch(sanitized, /access-secret|query-secret|query-id|refresh-secret/);
  assert.match(sanitized, /\[redacted\]/);
});

test("invalid_grant suspends background sync without stopping the worker service", async () => {
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "personal-agent-calendar-invalid-grant-"));
  const originalRunOnce = GoogleCalendarSync.prototype.runOnce;
  const originalConsoleError = console.error;
  const logs = [];
  let attempts = 0;

  GoogleCalendarSync.prototype.runOnce = async function invalidGrantTestDouble() {
    attempts += 1;
    throw { response: { data: { error: "invalid_grant", refresh_token: "must-not-leak" } } };
  };
  console.error = (...values) => logs.push(values.join(" "));

  const service = new GoogleCalendarCacheService({
    enabled: true,
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    dbPath: join(runtimeDirectory, "data/google-calendar/google-calendar.sqlite"),
    syncPastDays: 30,
    syncFutureDays: 90,
    syncIntervalSeconds: 0.01,
    authRedirectPort: 0,
    runtimeDirectory
  });

  try {
    await service.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(attempts, 1);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /services auth calendar/);
    assert.doesNotMatch(logs[0], /must-not-leak|test-client/);
  } finally {
    await service.stop();
    GoogleCalendarSync.prototype.runOnce = originalRunOnce;
    console.error = originalConsoleError;
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});
