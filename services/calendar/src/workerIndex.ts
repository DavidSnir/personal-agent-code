import { getDefaultRuntimeDirectory } from "../../../shared/utils/runtimeDirectory.js";
import { loadGoogleCalendarConfig } from "./google/config.js";
import { GoogleCalendarCacheService } from "./googleCalendarCacheService.js";
import { safeCalendarErrorMessage } from "./google/calendarError.js";

async function main(): Promise<void> {
  const runtimeDirectory = getDefaultRuntimeDirectory();
  // Container workers use direct env credentials or the canonical SQLite store;
  // host credentials-file paths are intentionally not dereferenced in-container.
  const config = loadGoogleCalendarConfig({ runtimeDirectory, loadCredentials: false });
  const service = new GoogleCalendarCacheService(config);
  await service.start();
  await waitForShutdownSignal();
  await service.stop();
}

function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolve) => {
    const onSignal = (): void => resolve();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
}

main().catch((error) => {
  console.error(`Google Calendar worker failed: ${safeCalendarErrorMessage(error)}`);
  process.exitCode = 1;
});
