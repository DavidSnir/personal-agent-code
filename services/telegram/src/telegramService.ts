import { loadConfig } from "./config.js";
import type { AppService } from "../../../shared/service/appService.js";
import { OpencodeTelegramAgent } from "./telegram/opencodeTelegramAgent.js";
import { TelegramConnectionService } from "./telegram/telegramConnectionService.js";

type ShutdownReason = NodeJS.Signals | "fatal";

export type RunTelegramServiceOptions = {
  runtimeDirectory?: string;
};

export async function runTelegramService(options: RunTelegramServiceOptions = {}): Promise<void> {
  const config = loadConfig({ runtimeDirectory: options.runtimeDirectory, forceTelegramEnabled: true });
  if (!config.telegramBotToken || !config.telegramAllowedUserId) {
    throw new Error("Telegram credentials are not configured.");
  }

  let fatal!: (error: Error) => void;
  const fatalError = new Promise<never>((_, reject) => {
    fatal = reject;
  });

  const service = new TelegramConnectionService({
    token: config.telegramBotToken,
    allowedUserId: config.telegramAllowedUserId,
    agent: new OpencodeTelegramAgent(config),
    onFatal: fatal
  });

  await service.start();

  const signal = waitForShutdownSignal();
  try {
    const reason = await Promise.race([signal.promise, fatalError]);
    console.log(`Received ${reason}; shutting down.`);
  } catch (error) {
    console.error("Fatal Telegram service error:", error);
    process.exitCode = 1;
  } finally {
    signal.dispose();
    await stopService(service);
  }
}

async function stopService(service: AppService): Promise<void> {
  try {
    await service.stop();
  } catch (error) {
    console.error(`Failed to stop ${service.name}:`, error);
    process.exitCode = 1;
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
