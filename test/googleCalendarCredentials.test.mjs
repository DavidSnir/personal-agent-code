import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveStoredGoogleOAuthCredentials } from "../dist/services/calendar/src/google/credentials.js";
import { loadGoogleCalendarHttpMcpConfig } from "../dist/services/calendar/src/mcp/httpIndex.js";
import { GoogleCalendarRepository } from "../dist/services/calendar/src/google/repository.js";

test("background sync credential resolution can use SQLite-persisted OAuth client credentials", () => {
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "personal-agent-calendar-credentials-"));
  const repository = new GoogleCalendarRepository(join(runtimeDirectory, "data/google-calendar/google-calendar.sqlite"));
  try {
    repository.initialize();
    repository.saveOAuthClientCredentials({ clientId: "sqlite-client-id", clientSecret: "sqlite-client-secret" });

    const config = {
      enabled: true,
      dbPath: repository.dbPath,
      syncPastDays: 30,
      syncFutureDays: 90,
      syncIntervalSeconds: 60,
      authRedirectPort: 0,
      runtimeDirectory
    };

    const resolved = resolveStoredGoogleOAuthCredentials(config, repository);

    assert.equal(resolved.clientId, "sqlite-client-id");
    assert.equal(resolved.clientSecret, "sqlite-client-secret");
  } finally {
    repository.close();
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

test("explicit configured Google Calendar OAuth credentials take precedence over SQLite", () => {
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "personal-agent-calendar-credentials-"));
  const repository = new GoogleCalendarRepository(join(runtimeDirectory, "data/google-calendar/google-calendar.sqlite"));
  try {
    repository.initialize();
    repository.saveOAuthClientCredentials({ clientId: "sqlite-client-id", clientSecret: "sqlite-client-secret" });

    const config = {
      enabled: true,
      clientId: "configured-client-id",
      clientSecret: "configured-client-secret",
      dbPath: repository.dbPath,
      syncPastDays: 30,
      syncFutureDays: 90,
      syncIntervalSeconds: 60,
      authRedirectPort: 0,
      runtimeDirectory
    };

    const resolved = resolveStoredGoogleOAuthCredentials(config, repository);

    assert.equal(resolved.clientId, "configured-client-id");
    assert.equal(resolved.clientSecret, "configured-client-secret");
  } finally {
    repository.close();
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

test("HTTP MCP credential resolution can use SQLite-persisted OAuth client credentials", () => {
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "personal-agent-calendar-http-mcp-credentials-"));
  const repository = new GoogleCalendarRepository(join(runtimeDirectory, "data/google-calendar/google-calendar.sqlite"));
  try {
    try {
      repository.initialize();
      repository.saveOAuthClientCredentials({ clientId: "sqlite-http-mcp-client-id", clientSecret: "sqlite-http-mcp-client-secret" });
    } finally {
      repository.close();
    }

    const resolved = loadGoogleCalendarHttpMcpConfig(runtimeDirectory);

    assert.equal(resolved.clientId, "sqlite-http-mcp-client-id");
    assert.equal(resolved.clientSecret, "sqlite-http-mcp-client-secret");
  } finally {
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});
