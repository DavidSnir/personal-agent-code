import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";

const cliPath = join(process.cwd(), "dist/cli/src/cli.js");

function runCli(args, options = {}) {
  const env = { ...process.env, ...(options.env ?? {}) };
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete env[name];
  }
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: options.cwd ?? process.cwd(),
    env,
    encoding: "utf8"
  });
}

function runCliAsync(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: options.cwd ?? process.cwd(),
      env: { ...process.env, ...(options.env ?? {}) }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("help documents services command and not removed top-level service commands", () => {
  const result = runCli(["help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /dagent \[--runtime-directory <path>\] services list/);
  assert.match(result.stdout, /dagent \[--runtime-directory <path>\] cli-api config/);
  assert.doesNotMatch(result.stdout, /services start whatsapp|services stop whatsapp/);
  assert.doesNotMatch(result.stdout, /DAgent \[--runtime-directory <path>\] service /);
  assert.doesNotMatch(result.stdout, /DAgent \[--runtime-directory <path>\] whatsapp /);
  assert.doesNotMatch(result.stdout, /DAgent \[--runtime-directory <path>\] google-calendar /);
  assert.doesNotMatch(result.stdout, /DAgent \[--runtime-directory <path>\] telegram /);
});

test("zsh completion documents cli-api config command", () => {
  const result = runCli(["completion", "zsh"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /'cli-api:Configure native CLI API connection settings'/);
  assert.match(result.stdout, /cli_api_commands=\('config:Show or update cli-api connection settings'\)/);
  assert.match(result.stdout, /--url\[CLI API URL\]/);
  assert.match(result.stdout, /--token\[CLI API bearer token\]/);
  assert.match(result.stdout, /--clear-token\[Remove the stored token\]/);
  assert.match(result.stdout, /'config:Configure runtime-independent user defaults'/);
  assert.match(result.stdout, /--path\[Set absolute default runtime directory\]/);
  assert.match(result.stdout, /--clear\[Clear the configured default runtime directory\]/);
});

test("runtime-directory config shows, sets, normalizes, and clears an XDG user config", () => {
  const root = mkdtempSync(join(tmpdir(), "dagent-user-config-"));
  const xdgHome = join(root, "xdg");
  const runtimeDirectory = join(root, "runtime", "..");
  const env = { XDG_CONFIG_HOME: xdgHome, DAGENT_RUNTIME_DIRECTORY: undefined };
  try {
    const initial = runCli(["config", "runtime-directory"], { cwd: root, env });
    assert.equal(initial.status, 0, initial.stderr);
    assert.deepEqual(JSON.parse(initial.stdout), {
      configPath: join(xdgHome, "dagent", "config.json"),
      configuredPath: null,
      effectivePath: realpathSync(root),
      source: "cwd"
    });

    const set = runCli(["config", "runtime-directory", "--path", runtimeDirectory], { cwd: root, env });
    assert.equal(set.status, 0, set.stderr);
    assert.equal(JSON.parse(set.stdout).configuredPath, root);
    const configPath = join(xdgHome, "dagent", "config.json");
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), { runtimeDirectory: root });
    assert.equal(statSync(join(xdgHome, "dagent")).mode & 0o777, 0o700);
    assert.equal(statSync(configPath).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(join(xdgHome, "dagent")), ["config.json"]);

    const clear = runCli(["config", "runtime-directory", "--clear"], { cwd: root, env });
    assert.equal(clear.status, 0, clear.stderr);
    assert.equal(JSON.parse(clear.stdout).configuredPath, null);
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime selection precedence is flag, env, config, then cwd across working directories", () => {
  const root = mkdtempSync(join(tmpdir(), "dagent-runtime-precedence-"));
  const xdgHome = join(root, "xdg");
  const cwd = join(root, "cwd");
  const configured = join(root, "configured");
  const fromEnv = join(root, "env");
  const explicit = join(root, "explicit");
  mkdirSync(cwd);
  try {
    assert.equal(runCli(["config", "runtime-directory", "--path", configured], { env: { XDG_CONFIG_HOME: xdgHome, DAGENT_RUNTIME_DIRECTORY: undefined } }).status, 0);
    const configuredHelp = runCli(["help"], { cwd, env: { XDG_CONFIG_HOME: xdgHome, DAGENT_RUNTIME_DIRECTORY: undefined } });
    assert.match(configuredHelp.stdout, new RegExp(`runtimeDirectory: ${configured}`));
    const envHelp = runCli(["help"], { cwd, env: { XDG_CONFIG_HOME: xdgHome, DAGENT_RUNTIME_DIRECTORY: fromEnv } });
    assert.match(envHelp.stdout, new RegExp(`runtimeDirectory: ${fromEnv}`));
    const explicitHelp = runCli(["-r", explicit, "help"], { cwd, env: { XDG_CONFIG_HOME: xdgHome, DAGENT_RUNTIME_DIRECTORY: fromEnv } });
    assert.match(explicitHelp.stdout, new RegExp(`runtimeDirectory: ${explicit}`));

    runCli(["config", "runtime-directory", "--clear"], { env: { XDG_CONFIG_HOME: xdgHome, DAGENT_RUNTIME_DIRECTORY: undefined } });
    const cwdHelp = runCli(["help"], { cwd, env: { XDG_CONFIG_HOME: xdgHome, DAGENT_RUNTIME_DIRECTORY: undefined } });
    assert.match(cwdHelp.stdout, new RegExp(`runtimeDirectory: ${realpathSync(cwd)}`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime-directory config rejects relative paths and fails clearly on corrupt config", () => {
  const root = mkdtempSync(join(tmpdir(), "dagent-corrupt-config-"));
  const xdgHome = join(root, "xdg");
  const configDirectory = join(xdgHome, "dagent");
  mkdirSync(configDirectory, { recursive: true });
  try {
    const relative = runCli(["config", "runtime-directory", "--path", "relative"], { env: { XDG_CONFIG_HOME: xdgHome, DAGENT_RUNTIME_DIRECTORY: undefined } });
    assert.notEqual(relative.status, 0);
    assert.match(relative.stderr, /--path must be an absolute runtime directory path/);

    writeFileSync(join(configDirectory, "config.json"), "not json\n");
    const help = runCli(["help"], { env: { XDG_CONFIG_HOME: xdgHome, DAGENT_RUNTIME_DIRECTORY: undefined } });
    assert.notEqual(help.status, 0);
    assert.match(help.stderr, /Failed to read DAgent user config/);
    const show = runCli(["config", "runtime-directory"], { env: { XDG_CONFIG_HOME: xdgHome, DAGENT_RUNTIME_DIRECTORY: undefined } });
    assert.notEqual(show.status, 0);
    assert.match(show.stderr, /Failed to read DAgent user config/);
    const clear = runCli(["config", "runtime-directory", "--clear"], { env: { XDG_CONFIG_HOME: xdgHome, DAGENT_RUNTIME_DIRECTORY: undefined } });
    assert.equal(clear.status, 0, clear.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime-directory config stays local and does not create the configured runtime", () => {
  const root = mkdtempSync(join(tmpdir(), "dagent-config-local-"));
  const xdgHome = join(root, "xdg");
  const runtimeDirectory = join(root, "missing-runtime");
  try {
    const set = runCli(["config", "runtime-directory", "--path", runtimeDirectory], { env: { XDG_CONFIG_HOME: xdgHome, DAGENT_RUNTIME_DIRECTORY: undefined, DAGENT_CLI_API_URL: "http://127.0.0.1:1" } });
    assert.equal(set.status, 0, set.stderr);
    assert.equal(existsSync(runtimeDirectory), false);
    const show = runCli(["config", "runtime-directory"], { env: { XDG_CONFIG_HOME: xdgHome, DAGENT_RUNTIME_DIRECTORY: undefined, DAGENT_CLI_API_URL: "http://127.0.0.1:1" } });
    assert.equal(show.status, 0, show.stderr);
    assert.equal(JSON.parse(show.stdout).configuredPath, runtimeDirectory);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("services list does not expose a native WhatsApp worker toggle", () => {
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "personal-agent-cli-services-"));
  try {
    const result = runCli(["--runtime-directory", runtimeDirectory, "services", "list"]);
    assert.equal(result.status, 0, result.stderr);
    const services = JSON.parse(result.stdout);
    assert.equal(services.some((service) => service.name === "whatsapp"), false);
  } finally {
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

test("WhatsApp lifecycle commands require the remote control API and worker start/stop are removed", () => {
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "personal-agent-whatsapp-remote-only-"));
  try {
    for (const args of [["services", "init", "whatsapp"], ["services", "auth", "whatsapp"], ["services", "sync", "whatsapp"], ["services", "logout", "whatsapp"], ["services", "status", "whatsapp"]]) {
      const result = runCli(["--runtime-directory", runtimeDirectory, ...args], { env: { DAGENT_CLI_API_URL: "" } });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /DAGENT_CLI_API_URL is not configured/);
    }
    for (const action of ["start", "stop"]) {
      const result = runCli(["--runtime-directory", runtimeDirectory, "services", action, "whatsapp"]);
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(result.stdout, new RegExp(`services ${action} whatsapp`));
    }
  } finally {
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

test("stdio MCP commands remain local when a CLI API URL is configured", () => {
  const result = runCli(["services", "mcp", "unknown"], { env: { DAGENT_CLI_API_URL: "http://127.0.0.1:1" } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown service: unknown/);
  assert.doesNotMatch(result.stderr, /CLI API request/);
});

test("removed top-level command surfaces fail", () => {
  for (const args of [["service", "list"], ["telegram", "status"], ["google-calendar", "status"], ["whatsapp", "status"], ["agent", "start", "--help"]]) {
    const result = runCli(args);
    assert.notEqual(result.status, 0, `${args.join(" ")} should fail`);
    assert.match(result.stderr, /Unknown command:/);
  }
});

test("configured CLI API mode uses dedicated app-control endpoints", async () => {
  const requests = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body: body ? JSON.parse(body) : undefined });
      response.writeHead(200, { "content-type": "application/json", connection: "close" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  server.keepAliveTimeout = 1;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    const apiUrl = `http://127.0.0.1:${address.port}`;
    const env = { DAGENT_CLI_API_URL: apiUrl, DAGENT_CLI_API_TOKEN: "test-token" };

    for (const args of [["services", "list"], ["services", "status", "telegram"], ["services", "disable", "telegram"], ["services", "enable", "telegram"]]) {
      const result = await runCliAsync(args, { env });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { ok: true });
    }

    assert.deepEqual(requests, [
      { method: "GET", url: "/services", authorization: "Bearer test-token", body: undefined },
      { method: "GET", url: "/telegram/status", authorization: "Bearer test-token", body: undefined },
      { method: "POST", url: "/services/telegram/disable", authorization: "Bearer test-token", body: undefined },
      { method: "POST", url: "/services/telegram/enable", authorization: "Bearer test-token", body: undefined }
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("stored CLI API URL is used and blocks native supervisor operations", async () => {
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "personal-agent-stored-api-"));
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    response.writeHead(200, { "content-type": "application/json", connection: "close" });
    response.end('{"ok":true}\n');
  });
  server.keepAliveTimeout = 1;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    const configure = runCli(["--runtime-directory", runtimeDirectory, "cli-api", "config", "--url", `http://127.0.0.1:${address.port}`], { env: { DAGENT_CLI_API_URL: undefined } });
    assert.equal(configure.status, 0, configure.stderr);
    const status = await runCliAsync(["--runtime-directory", runtimeDirectory, "services", "list"], { env: { DAGENT_CLI_API_URL: "" } });
    assert.equal(status.status, 0, status.stderr);
    assert.deepEqual(requests, [{ method: "GET", url: "/services" }]);
    for (const command of ["start", "stop", "__run-detached-app"]) {
      const result = runCli(["--runtime-directory", runtimeDirectory, command], { env: { DAGENT_CLI_API_URL: "" } });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /native supervisor operation.*disabled while a CLI API URL is configured/);
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

test("CLI API requests time out with source and actionable configuration guidance", async () => {
  const sockets = new Set();
  const server = createServer((_request, _response) => {});
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    const result = await runCliAsync(["services", "list"], {
      env: { DAGENT_CLI_API_URL: `http://127.0.0.1:${address.port}`, DAGENT_CLI_API_TIMEOUT_MS: "20" }
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /request to \/services timed out after 20ms/);
    assert.match(result.stderr, /DAGENT_CLI_API_TIMEOUT_MS/);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("Compose init creates required private bind sources and exact root opencode config", () => {
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "personal-agent-compose-init-"));
  try {
    writeFileSync(join(runtimeDirectory, "opencode.json"), JSON.stringify({ custom: true, mcp: { other: { enabled: false } } }));
    const result = runCli(["--runtime-directory", runtimeDirectory, "services", "init", "compose"], {
      env: { GOOGLE_CALENDAR_DB_PATH: join(runtimeDirectory, "wrong-calendar.sqlite"), WHATSAPP_DB_PATH: join(runtimeDirectory, "wrong-whatsapp.sqlite") }
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.deploymentMode, "compose");
    assert.equal(output.opencodeConfig.configPath, join(runtimeDirectory, "opencode.json"));
    assert.equal(output.dbPath, join(runtimeDirectory, "data", "google-calendar", "google-calendar.sqlite"));
    assert.equal(output.whatsapp.dbPath, join(runtimeDirectory, "data", "whatsapp", "whatsapp.sqlite"));
    assert.equal(existsSync(join(runtimeDirectory, "wrong-calendar.sqlite")), false);
    assert.equal(existsSync(join(runtimeDirectory, "wrong-whatsapp.sqlite")), false);
    const config = JSON.parse(readFileSync(join(runtimeDirectory, "opencode.json"), "utf8"));
    assert.equal(config.custom, true);
    assert.deepEqual(config.mcp.calendar, { type: "remote", url: "http://calendar-mcp:7332/mcp", enabled: true });
    assert.deepEqual(config.mcp.whatsapp, { type: "remote", url: "http://whatsapp-mcp:7333/mcp", enabled: true });
    for (const path of ["agent/workspace", "data/opencode", "data/google-calendar", "data/whatsapp", "data/telegram", "data/whatsapp/waha-sessions"]) {
      assert.equal(statSync(join(runtimeDirectory, path)).isDirectory(), true, path);
    }
    assert.equal(statSync(join(runtimeDirectory, ".settings")).mode & 0o777, 0o600);
    assert.equal(statSync(join(runtimeDirectory, "opencode.json")).mode & 0o777, 0o600);
    for (const path of ["data/opencode", "data/google-calendar", "data/whatsapp", "data/telegram"]) {
      assert.equal(statSync(join(runtimeDirectory, path)).mode & 0o777, 0o700, path);
    }
  } finally {
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});

test("configured CLI API mode sends Telegram auth to the dedicated endpoint without printing the token", async () => {
  const requests = [];
  const botToken = "123456:fake-telegram-test-token";
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body: JSON.parse(body) });
      response.writeHead(200, { "content-type": "application/json", connection: "close" });
      response.end(JSON.stringify({ botTokenPresent: true, allowedUserId: 123456 }));
    });
  });
  server.keepAliveTimeout = 1;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    const result = await runCliAsync(["services", "auth", "telegram", "--bot-token", botToken, "--user-id", "123456"], {
      env: { DAGENT_CLI_API_URL: `http://127.0.0.1:${address.port}`, DAGENT_CLI_API_TOKEN: "test-token" }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, new RegExp(botToken));
    assert.doesNotMatch(result.stderr, new RegExp(botToken));
    assert.deepEqual(requests, [{
      method: "POST",
      url: "/telegram/auth",
      authorization: "Bearer test-token",
      body: { botToken, userId: "123456" }
    }]);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("cli-api config stores URL without printing token", () => {
  const runtimeDirectory = mkdtempSync(join(tmpdir(), "personal-agent-cli-api-config-"));
  try {
    const setResult = runCli(["--runtime-directory", runtimeDirectory, "cli-api", "config", "--url", "http://127.0.0.1:8000", "--token", "secret-token"]);
    assert.equal(setResult.status, 0, setResult.stderr);
    assert.doesNotMatch(setResult.stdout, /secret-token/);
    const config = JSON.parse(setResult.stdout);
    assert.equal(config.url, "http://127.0.0.1:8000");
    assert.equal(config.tokenConfigured, true);

    const showResult = runCli(["--runtime-directory", runtimeDirectory, "cli-api", "config"]);
    assert.equal(showResult.status, 0, showResult.stderr);
    assert.doesNotMatch(showResult.stdout, /secret-token/);
    assert.equal(JSON.parse(showResult.stdout).tokenConfigured, true);
  } finally {
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
});
