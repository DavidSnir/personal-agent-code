import type { GoogleCalendarConfig } from "./config.js";
import type { GoogleCalendarRepository } from "./repository.js";

export function resolveStoredGoogleOAuthCredentials(config: GoogleCalendarConfig, repository: GoogleCalendarRepository): GoogleCalendarConfig {
  if (config.clientId && config.clientSecret) {
    return config;
  }

  const credentials = repository.getOAuthClientCredentials();
  if (!credentials) {
    return config;
  }

  return { ...config, clientId: credentials.clientId, clientSecret: credentials.clientSecret };
}
