import { OpencodeAgent } from "../../agent/src/agents/opencodeAgent.js";
import { DagentApiService } from "../../cli-api/src/dagentApiService.js";
import { loadConfig } from "./config.js";
import { loadGoogleCalendarConfig } from "../../calendar/src/google/config.js";
import { OpencodeClient } from "../../agent/src/opencode/opencodeClient.js";
import type { AppService } from "../../../shared/service/appService.js";
import { GoogleCalendarCacheService } from "../../calendar/src/googleCalendarCacheService.js";
import { OpencodeServerService } from "./telegram/opencodeServerService.js";
import { TelegramConnectionService } from "./telegram/telegramConnectionService.js";

type ShutdownReason = NodeJS.Signals | "fatal";

export type RunAppOptions = {
  runtimeDirectory?: string;
};

export async function runApp(options: RunAppOptions = {}): Promise<void> {
  const runtimeDirectory = options.runtimeDirectory;
  const config = loadConfig({ runtimeDirectory });
  const googleCalendarConfig = loadGoogleCalendarConfig({ runtimeDirectory });
  const started: AppService[] = [];
  let fatal!: (error: Error) => void;
  const fatalError = new Promise<never>((_, reject) => {
    fatal = reject;
  });

  const services: AppService[] = [];
  if (config.opencodeServerAutoStart) {
    services.push(new OpencodeServerService(config, fatal));
  } else {
    console.log("Opencode server auto-start disabled; expecting an existing server.");
  }
  if (googleCalendarConfig.enabled) {
    services.push(new GoogleCalendarCacheService(googleCalendarConfig));
  }
  if (config.telegramEnabled) {
    if (!config.telegramBotToken || !config.telegramAllowedUserId) {
      throw new Error("Telegram is enabled but credentials are not configured.");
    }
    const opencodeAgent = new OpencodeAgent(new OpencodeClient(config));
    services.push(
      new TelegramConnectionService({
        token: config.telegramBotToken,
        allowedUserId: config.telegramAllowedUserId,
        agent: opencodeAgent,
        onFatal: fatal
      })
    );
  } else {
    console.log("Telegram service disabled; long polling will not start.");
  }
  if (config.dagentApiEnabled) {
    services.push(new DagentApiService({ runtimeDirectory: googleCalendarConfig.runtimeDirectory, hostname: config.dagentApiHostname, port: config.dagentApiPort, token: config.dagentApiToken }));
  } else {
    console.log("DAgent API disabled; HTTP control API will not start.");
  }

  try {
    for (const service of services) {
      await service.start();
      started.push(service);
    }
  } catch (error) {
    await stopStartedServices(started);
    throw error;
  }

  const signal = waitForShutdownSignal();
  try {
    const reason = await Promise.race([signal.promise, fatalError]);
    console.log(`Received ${reason}; shutting down.`);
  } catch (error) {
    console.error("Fatal service error:", error);
    process.exitCode = 1;
  } finally {
    signal.dispose();
    await stopStartedServices(started);
  }
}

async function stopStartedServices(started: AppService[]): Promise<void> {
  for (const service of [...started].reverse()) {
    try {
      await service.stop();
    } catch (error) {
      console.error(`Failed to stop ${service.name}:`, error);
      process.exitCode = 1;
    }
  }
}

function waitForShutdownSignal(): { promise: Promise<ShutdownReason>; dispose(): void } {
  let settle!: (signal: ShutdownReason) => void;
  const promise = new Promise<ShutdownReason>((resolve) => {
    settle = resolve;
  });

  const onSigint = (): void => settle("SIGINT");
  const onSigterm = (): void => settle("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  return {
    promise,
    dispose(): void {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    }
  };
}
