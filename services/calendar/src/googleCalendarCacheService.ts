import type { GoogleCalendarConfig } from "./google/config.js";
import { resolveStoredGoogleOAuthCredentials } from "./google/credentials.js";
import { GoogleCalendarRepository } from "./google/repository.js";
import { GoogleCalendarSync } from "./google/sync.js";
import { calendarReauthorizationMessage, isInvalidGrantError, safeCalendarErrorMessage } from "./google/calendarError.js";
import type { AppService } from "../../../shared/service/appService.js";

export class GoogleCalendarCacheService implements AppService {
  readonly name = "GoogleCalendarCacheService";
  private interval?: NodeJS.Timeout;
  private activeSync?: Promise<void>;
  private running = false;
  private stopping = false;
  private authorizationInvalid = false;
  private readonly repository: GoogleCalendarRepository;

  constructor(private readonly config: GoogleCalendarConfig) {
    this.repository = new GoogleCalendarRepository(config.dbPath);
  }

  async start(): Promise<void> {
    this.stopping = false;
    this.authorizationInvalid = false;
    this.repository.initialize();
    this.interval = setInterval(() => {
      this.runSync("background");
    }, this.config.syncIntervalSeconds * 1000);
    this.runSync("initial");
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    if (this.activeSync) {
      await this.activeSync;
    }
    this.repository.close();
  }

  private runSync(kind: "initial" | "background"): void {
    if (this.activeSync) {
      return;
    }

    const activeSync = this.sync()
      .catch((error) => {
        if (!this.stopping) {
          if (isInvalidGrantError(error)) {
            this.authorizationInvalid = true;
            if (this.interval) {
              clearInterval(this.interval);
              this.interval = undefined;
            }
            console.error(calendarReauthorizationMessage(this.config.runtimeDirectory));
          } else {
            console.error(`Google Calendar ${kind} sync failed: ${safeCalendarErrorMessage(error)}`);
          }
        }
      })
      .finally(() => {
        if (this.activeSync === activeSync) {
          this.activeSync = undefined;
        }
      });
    this.activeSync = activeSync;
    void activeSync;
  }

  private async sync(): Promise<void> {
    if (this.running || this.authorizationInvalid) {
      return;
    }
    this.running = true;
    try {
      const config = resolveStoredGoogleOAuthCredentials(this.config, this.repository);
      const sync = new GoogleCalendarSync(config, this.repository);
      const result = await sync.runOnce();
      if (result.calendarErrors.length > 0) {
        console.error("Google Calendar sync completed with calendar errors:", result.calendarErrors.map((entry) => ({ ...entry, error: safeCalendarErrorMessage(entry.error) })));
      }
    } finally {
      this.running = false;
    }
  }
}
