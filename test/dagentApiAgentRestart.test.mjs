import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { installCalendarMcpForCliApi, installWhatsappMcpForCliApi, restartAgentAfterCalendarMcpInstall } from "../dist/services/cli-api/src/dagentApiService.js";
import { getDefaultAgentRestartCommand } from "../dist/services/cli-api/src/index.js";

test("Calendar MCP install restart skips when no restart command is configured", async () => {
  const runtime = mkdtempSync(join(tmpdir(), "dagent-agent-restart-"));
  const result = await restartAgentAfterCalendarMcpInstall({
    installedConfigPath: join(runtime, "opencode.json"),
    agentRuntimeDirectory: runtime
  });

  assert.equal(result.status, "skipped");
  assert.match(result.message, /not configured/);
});

test("CLI API default restart command is disabled without Docker socket access", () => {
  assert.equal(getDefaultAgentRestartCommand(join(tmpdir(), "missing-docker.sock")), undefined);
});

test("Calendar MCP install restart skips when agent runtime is not configured", async () => {
  const runtime = mkdtempSync(join(tmpdir(), "dagent-agent-restart-"));
  const result = await restartAgentAfterCalendarMcpInstall({
    installedConfigPath: join(runtime, "opencode.json"),
    agentRestartCommand: "true"
  });

  assert.equal(result.status, "skipped");
  assert.match(result.message, /opencode config path is not configured/);
});

test("Calendar MCP install restart skips when installed config is not agent-visible", async () => {
  const cliApiRuntime = mkdtempSync(join(tmpdir(), "dagent-cli-api-runtime-"));
  const agentRuntime = mkdtempSync(join(tmpdir(), "dagent-agent-runtime-"));
  const result = await restartAgentAfterCalendarMcpInstall({
    installedConfigPath: join(cliApiRuntime, "opencode.json"),
    agentRuntimeDirectory: agentRuntime,
    agentRestartCommand: "true"
  });

  assert.equal(result.status, "skipped");
  assert.match(result.message, /is not the configured agent opencode config/);
});

test("Calendar MCP install restart checks explicit agent opencode config path", async () => {
  const runtime = mkdtempSync(join(tmpdir(), "dagent-agent-restart-"));
  const result = await restartAgentAfterCalendarMcpInstall({
    installedConfigPath: join(runtime, "workspace", "opencode.json"),
    agentRuntimeDirectory: runtime,
    agentOpencodeConfigPath: join(runtime, "workspace", "opencode.json"),
    agentRestartCommand: "true"
  });

  assert.equal(result.status, "restarted");
});

test("Calendar MCP install restart runs configured command when config is agent-visible", async () => {
  const runtime = mkdtempSync(join(tmpdir(), "dagent-agent-restart-"));
  const result = await restartAgentAfterCalendarMcpInstall({
    installedConfigPath: join(runtime, "opencode.json"),
    agentRuntimeDirectory: runtime,
    agentRestartCommand: "true"
  });

  assert.equal(result.status, "restarted");
});

test("Calendar MCP install restart reports restart command failure", async () => {
  const runtime = mkdtempSync(join(tmpdir(), "dagent-agent-restart-"));
  const result = await restartAgentAfterCalendarMcpInstall({
    installedConfigPath: join(runtime, "opencode.json"),
    agentRuntimeDirectory: runtime,
    agentRestartCommand: "false"
  });

  assert.equal(result.status, "failed");
  assert.match(result.message, /failed/);
});

test("CLI API Calendar install writes remote MCP config to agent workspace config, not calendar or agent runtime root", () => {
  const calendarRuntime = mkdtempSync(join(tmpdir(), "dagent-calendar-runtime-"));
  const agentRuntime = mkdtempSync(join(tmpdir(), "dagent-agent-runtime-"));
  const agentOpencodeConfigPath = join(agentRuntime, "workspace", "opencode.json");
  const previousTransport = process.env.DAGENT_CALENDAR_MCP_TRANSPORT;
  const previousUrl = process.env.DAGENT_CALENDAR_MCP_REMOTE_URL;
  try {
    process.env.DAGENT_CALENDAR_MCP_TRANSPORT = "remote";
    process.env.DAGENT_CALENDAR_MCP_REMOTE_URL = "http://calendar-mcp:7332/mcp";

    const result = installCalendarMcpForCliApi({ runtimeDirectory: calendarRuntime, agentRuntimeDirectory: agentRuntime, agentOpencodeConfigPath });

    assert.equal(result.configPath, agentOpencodeConfigPath);
    assert.equal(existsSync(join(calendarRuntime, "opencode.json")), false);
    assert.equal(existsSync(join(agentRuntime, "opencode.json")), false);
    const config = JSON.parse(readFileSync(result.configPath, "utf8"));
    assert.deepEqual(config.mcp.calendar, { type: "remote", url: "http://calendar-mcp:7332/mcp", enabled: true });
  } finally {
    if (previousTransport === undefined) delete process.env.DAGENT_CALENDAR_MCP_TRANSPORT;
    else process.env.DAGENT_CALENDAR_MCP_TRANSPORT = previousTransport;
    if (previousUrl === undefined) delete process.env.DAGENT_CALENDAR_MCP_REMOTE_URL;
    else process.env.DAGENT_CALENDAR_MCP_REMOTE_URL = previousUrl;
    rmSync(calendarRuntime, { recursive: true, force: true });
    rmSync(agentRuntime, { recursive: true, force: true });
  }
});

test("CLI API WhatsApp install writes remote MCP config to agent workspace config", () => {
  const whatsappRuntime = mkdtempSync(join(tmpdir(), "dagent-whatsapp-runtime-"));
  const agentRuntime = mkdtempSync(join(tmpdir(), "dagent-agent-runtime-"));
  const agentOpencodeConfigPath = join(agentRuntime, "workspace", "opencode.json");
  const previousTransport = process.env.DAGENT_WHATSAPP_MCP_TRANSPORT;
  const previousUrl = process.env.DAGENT_WHATSAPP_MCP_REMOTE_URL;
  try {
    process.env.DAGENT_WHATSAPP_MCP_TRANSPORT = "remote";
    process.env.DAGENT_WHATSAPP_MCP_REMOTE_URL = "http://whatsapp-mcp:7333/mcp";

    const result = installWhatsappMcpForCliApi({ runtimeDirectory: whatsappRuntime, agentRuntimeDirectory: agentRuntime, agentOpencodeConfigPath });

    assert.equal(result.configPath, agentOpencodeConfigPath);
    assert.equal(existsSync(join(whatsappRuntime, "opencode.json")), false);
    assert.equal(existsSync(join(agentRuntime, "opencode.json")), false);
    const config = JSON.parse(readFileSync(result.configPath, "utf8"));
    assert.deepEqual(config.mcp.whatsapp, { type: "remote", url: "http://whatsapp-mcp:7333/mcp", enabled: true });
  } finally {
    if (previousTransport === undefined) delete process.env.DAGENT_WHATSAPP_MCP_TRANSPORT;
    else process.env.DAGENT_WHATSAPP_MCP_TRANSPORT = previousTransport;
    if (previousUrl === undefined) delete process.env.DAGENT_WHATSAPP_MCP_REMOTE_URL;
    else process.env.DAGENT_WHATSAPP_MCP_REMOTE_URL = previousUrl;
    rmSync(whatsappRuntime, { recursive: true, force: true });
    rmSync(agentRuntime, { recursive: true, force: true });
  }
});
