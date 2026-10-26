import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { installCalendarMcpInRuntimeOpencodeConfig, installComposeMcpInRuntimeOpencodeConfig, installDefaultMcpInRuntimeOpencodeConfig, installWhatsappMcpInRuntimeOpencodeConfig } from "../dist/services/agent/src/opencode/runtimeConfig.js";

test("Calendar MCP can be installed as remote opencode entry", () => {
  const runtime = mkdtempSync(join(tmpdir(), "dagent-opencode-config-"));
  try {
    const result = installCalendarMcpInRuntimeOpencodeConfig(runtime, { transport: "remote", remoteUrl: "http://calendar-mcp:7332/mcp" });
    assert.equal(result.configPath, join(runtime, "opencode.json"));
    assert.deepEqual(result.calendarMcp, { type: "remote", url: "http://calendar-mcp:7332/mcp", enabled: true });

    const config = JSON.parse(readFileSync(result.configPath, "utf8"));
    assert.equal(config.$schema, "https://opencode.ai/config.json");
    assert.deepEqual(config.mcp.calendar, { type: "remote", url: "http://calendar-mcp:7332/mcp", enabled: true });
  } finally {
    rmSync(runtime, { recursive: true, force: true });
  }
});

test("standard compose uses internal pinned WAHA and a loopback control API with separate WhatsApp SQLite", () => {
  const compose = readFileSync(join(process.cwd(), "docker-compose.yml"), "utf8");
  const telegramBlock = compose.slice(compose.indexOf("  telegram:"), compose.indexOf("  control-api:"));
  assert.match(telegramBlock, /dagent\/data\/telegram\/\.env/);
  assert.match(telegramBlock, /DAGENT_RUNTIME_DIRECTORY: \/runtime/);
  assert.match(telegramBlock, /dagent\/data\/telegram\n\s+target: \/runtime\/data\/telegram/);
  assert.doesNotMatch(telegramBlock, /runtime\/agent\/\.env/);
  assert.doesNotMatch(compose, /\$\{HOME\}\/\.local\/share\/dagent\/telegram/);
  assert.match(compose, /OPENCODE_CONFIG: \/runtime\/opencode\.json/);
  assert.match(compose, /DAGENT_AGENT_RUNTIME_DIRECTORY: \/agent-runtime/);
  assert.match(compose, /DAGENT_AGENT_OPENCODE_CONFIG_PATH: \/agent-runtime\/opencode\.json/);
  assert.match(compose, /DAGENT_CALENDAR_MCP_TRANSPORT: remote/);
  assert.match(compose, /DAGENT_CALENDAR_MCP_REMOTE_URL: http:\/\/calendar-mcp:7332\/mcp/);
  assert.match(compose, /dagent\/data\/google-calendar\n\s+target: \/runtime\/data\/google-calendar/);
  assert.match(compose, /dagent\/opencode\.json\n\s+target: \/agent-runtime\/opencode\.json/);
  assert.match(compose, /dagent\/agent\/workspace\n\s+target: \/workspace/);
  assert.match(compose, /dagent\/data\/opencode\n\s+target: \/root\/\.local\/share\/opencode/);
  assert.match(compose, /127\.0\.0\.1:4096:4096/);
  assert.match(compose, /create_host_path: false/);
  assert.match(compose, /\$\{HOME:\?HOME must be set to use the canonical DAgent runtime\}/);
  assert.doesNotMatch(compose, /\$\{HOME\}\//);
  assert.match(compose, /command: \["node", "dist\/services\/calendar\/src\/mcp\/httpIndex\.js"\]/);
  assert.match(compose, /control-api:/);
  assert.match(compose, /DAGENT_API_PORT: 8000/);
  assert.match(compose, /127\.0\.0\.1:8000:8000/);
  assert.match(compose, /DAGENT_WHATSAPP_RUNTIME_DIRECTORY: \/whatsapp-runtime/);
  assert.match(compose, /dagent\/data\/whatsapp\n\s+target: \/whatsapp-runtime\/data\/whatsapp/);
  assert.match(compose, /DAGENT_WHATSAPP_MCP_TRANSPORT: remote/);
  assert.match(compose, /DAGENT_WHATSAPP_MCP_REMOTE_URL: http:\/\/whatsapp-mcp:7333\/mcp/);
  assert.match(compose, /image: devlikeapro\/waha:gows-2026\.7\.1@sha256:8f3a7b11310594b973a588b2f7de061864c83532ae2cdff43280db0402bead29/);
  assert.match(compose, /platform: linux\/amd64/);
  assert.match(compose, /WHATSAPP_DEFAULT_ENGINE: GOWS/);
  assert.match(compose, /WHATSAPP_START_SESSION: default/);
  assert.match(compose, /WAHA_DASHBOARD_ENABLED: "false"/);
  assert.match(compose, /WHATSAPP_SWAGGER_ENABLED: "false"/);
  assert.match(compose, /WAHA_PRINT_QR: "false"/);
  assert.match(compose, /WHATSAPP_DOWNLOAD_MEDIA: "false"/);
  assert.match(compose, /WHATSAPP_HOOK_EVENTS: message,message\.ack,message\.edited,message\.revoked,session\.status/);
  assert.match(compose, /WHATSAPP_HOOK_HMAC_KEY: \$\{WAHA_WEBHOOK_SECRET:-local-development-waha-webhook-secret-change-me\}/);
  assert.match(compose, /WHATSAPP_HOOK_URL: http:\/\/control-api:8000\/internal\/whatsapp\/webhook/);
  assert.match(compose, /WAHA_API_KEY: \$\{WAHA_API_KEY:-local-development-waha-api-key-change-me\}/);
  assert.match(compose, /WAHA_WEBHOOK_SECRET: \$\{WAHA_WEBHOOK_SECRET:-local-development-waha-webhook-secret-change-me\}/);
  assert.match(compose, /dagent\/data\/whatsapp\/waha-sessions\n\s+target: \/app\/\.sessions/);
  assert.doesNotMatch(compose, /whatsapp-worker:/);
  assert.doesNotMatch(compose, /browser-profile/);
  const wahaBlock = compose.slice(compose.indexOf("  waha:"), compose.indexOf("  whatsapp-mcp:"));
  assert.doesNotMatch(wahaBlock, /^\s+ports:/m);
  const controlBlock = compose.slice(compose.indexOf("  control-api:"), compose.indexOf("  calendar-worker:"));
  assert.match(controlBlock, /DAGENT_TELEGRAM_RUNTIME_DIRECTORY: \/telegram-runtime/);
  assert.match(controlBlock, /dagent\/data\/telegram\n\s+target: \/telegram-runtime\/data\/telegram/);
  assert.match(controlBlock, /WAHA_BASE_URL: http:\/\/waha:3000/);
  assert.match(controlBlock, /WAHA_API_KEY: \$\{WAHA_API_KEY:-local-development-waha-api-key-change-me\}/);
  assert.match(controlBlock, /WAHA_WEBHOOK_SECRET: \$\{WAHA_WEBHOOK_SECRET:-local-development-waha-webhook-secret-change-me\}/);
  assert.match(compose, /whatsapp-mcp:/);
  assert.match(compose, /dagent\/data\/whatsapp\n\s+target: \/runtime\/data\/whatsapp/);
  assert.match(compose, /command: \["node", "dist\/services\/whatsapp\/src\/mcp\/httpIndex\.js"\]/);
});

test("Compose MCP install preserves unrelated config and installs both exact remote entries", () => {
  const runtime = mkdtempSync(join(tmpdir(), "dagent-compose-config-"));
  try {
    const configPath = join(runtime, "opencode.json");
    writeFileSync(configPath, JSON.stringify({ theme: "custom", mcp: { private: { type: "remote", url: "http://private/mcp", enabled: false } } }));
    const result = installComposeMcpInRuntimeOpencodeConfig(runtime);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(result.configPath, configPath);
    assert.equal(config.theme, "custom");
    assert.deepEqual(config.mcp.private, { type: "remote", url: "http://private/mcp", enabled: false });
    assert.deepEqual(config.mcp.calendar, { type: "remote", url: "http://calendar-mcp:7332/mcp", enabled: true });
    assert.deepEqual(config.mcp.whatsapp, { type: "remote", url: "http://whatsapp-mcp:7333/mcp", enabled: true });
  } finally {
    rmSync(runtime, { recursive: true, force: true });
  }
});

test("Compose MCP install rejects an invalid existing MCP shape without replacing config", () => {
  const runtime = mkdtempSync(join(tmpdir(), "dagent-compose-invalid-config-"));
  try {
    const configPath = join(runtime, "opencode.json");
    const original = '{"custom":true,"mcp":[]}\n';
    writeFileSync(configPath, original);
    assert.throws(() => installComposeMcpInRuntimeOpencodeConfig(runtime), /field mcp must be a JSON object/);
    assert.equal(readFileSync(configPath, "utf8"), original);
  } finally {
    rmSync(runtime, { recursive: true, force: true });
  }
});

test("package locks contain no WhatsApp Web or Puppeteer browser packages", () => {
  for (const path of ["package-lock.json", "cli/package-lock.json", "services/cli-api/package-lock.json", "services/whatsapp/package-lock.json"]) {
    const lock = readFileSync(join(process.cwd(), path), "utf8");
    assert.doesNotMatch(lock, /whatsapp-web\.js|puppeteer-core|@puppeteer\/browsers|node_modules\/puppeteer/);
  }
});

test("WhatsApp MCP can be installed as remote opencode entry", () => {
  const runtime = mkdtempSync(join(tmpdir(), "dagent-opencode-config-"));
  try {
    const result = installWhatsappMcpInRuntimeOpencodeConfig(runtime, { transport: "remote", remoteUrl: "http://whatsapp-mcp:7333/mcp" });
    assert.equal(result.configPath, join(runtime, "opencode.json"));
    assert.deepEqual(result.whatsappMcp, { type: "remote", url: "http://whatsapp-mcp:7333/mcp", enabled: true });

    const config = JSON.parse(readFileSync(result.configPath, "utf8"));
    assert.equal(config.$schema, "https://opencode.ai/config.json");
    assert.deepEqual(config.mcp.whatsapp, { type: "remote", url: "http://whatsapp-mcp:7333/mcp", enabled: true });
  } finally {
    rmSync(runtime, { recursive: true, force: true });
  }
});

test("default MCP install uses remote Calendar transport from environment without changing WhatsApp local transport", () => {
  const runtime = mkdtempSync(join(tmpdir(), "dagent-opencode-config-"));
  const previousTransport = process.env.DAGENT_CALENDAR_MCP_TRANSPORT;
  const previousUrl = process.env.DAGENT_CALENDAR_MCP_REMOTE_URL;
  try {
    process.env.DAGENT_CALENDAR_MCP_TRANSPORT = "remote";
    process.env.DAGENT_CALENDAR_MCP_REMOTE_URL = "http://calendar-mcp:7332/mcp";
    const result = installDefaultMcpInRuntimeOpencodeConfig(runtime);
    assert.deepEqual(result.mcp.calendar, { type: "remote", url: "http://calendar-mcp:7332/mcp", enabled: true });
    assert.equal(result.mcp.whatsapp.type, "local");
    assert.deepEqual(result.mcp.whatsapp.command, ["dagent", "services", "mcp", "whatsapp"]);
    assert.equal(result.mcp.whatsapp.environment.DAGENT_RUNTIME_DIRECTORY, runtime);
  } finally {
    if (previousTransport === undefined) delete process.env.DAGENT_CALENDAR_MCP_TRANSPORT;
    else process.env.DAGENT_CALENDAR_MCP_TRANSPORT = previousTransport;
    if (previousUrl === undefined) delete process.env.DAGENT_CALENDAR_MCP_REMOTE_URL;
    else process.env.DAGENT_CALENDAR_MCP_REMOTE_URL = previousUrl;
    rmSync(runtime, { recursive: true, force: true });
  }
});

test("default MCP install uses remote WhatsApp transport from environment", () => {
  const runtime = mkdtempSync(join(tmpdir(), "dagent-opencode-config-"));
  const previousTransport = process.env.DAGENT_WHATSAPP_MCP_TRANSPORT;
  const previousUrl = process.env.DAGENT_WHATSAPP_MCP_REMOTE_URL;
  try {
    process.env.DAGENT_WHATSAPP_MCP_TRANSPORT = "remote";
    process.env.DAGENT_WHATSAPP_MCP_REMOTE_URL = "http://whatsapp-mcp:7333/mcp";
    const result = installDefaultMcpInRuntimeOpencodeConfig(runtime);
    assert.deepEqual(result.mcp.whatsapp, { type: "remote", url: "http://whatsapp-mcp:7333/mcp", enabled: true });
  } finally {
    if (previousTransport === undefined) delete process.env.DAGENT_WHATSAPP_MCP_TRANSPORT;
    else process.env.DAGENT_WHATSAPP_MCP_TRANSPORT = previousTransport;
    if (previousUrl === undefined) delete process.env.DAGENT_WHATSAPP_MCP_REMOTE_URL;
    else process.env.DAGENT_WHATSAPP_MCP_REMOTE_URL = previousUrl;
    rmSync(runtime, { recursive: true, force: true });
  }
});
