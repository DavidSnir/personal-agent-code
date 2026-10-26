import { runTelegramService } from "./telegramService.js";

runTelegramService().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
