import { createServer } from "node:http";
import { AddressInfo } from "node:net";

import { google } from "googleapis";
import open from "open";

import type { GoogleCalendarConfig } from "./config.js";
import { requireGoogleOAuthConfig } from "./config.js";
import type { GoogleCalendarRepository } from "./repository.js";

const oauthScopes = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/userinfo.email"
];

export function createGoogleCalendarAuthUrl(config: GoogleCalendarConfig, redirectUri: string, state?: string): string {
  const { clientId, clientSecret } = requireGoogleOAuthConfig(config);
  const client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: oauthScopes,
    ...(state ? { state } : {})
  });
}

export async function exchangeGoogleCalendarAuthCode(config: GoogleCalendarConfig, repository: GoogleCalendarRepository, code: string, redirectUri: string): Promise<void> {
  const { clientId, clientSecret } = requireGoogleOAuthConfig(config);
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  const tokenResponse = await oauth2Client.getToken(code);
  const tokens = tokenResponse.tokens;
  if (!tokens.refresh_token) {
    throw new Error("Google did not return a refresh token. Revoke the app grant and run auth again with prompt=consent.");
  }

  oauth2Client.setCredentials(tokens);
  const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
  const userInfo = await oauth2.userinfo.get();

  repository.saveOAuthToken({
    accountEmail: userInfo.data.email ?? undefined,
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token ?? undefined,
    expiryDate: tokens.expiry_date ?? undefined,
    scope: tokens.scope ?? undefined,
    tokenType: tokens.token_type ?? undefined
  });
  repository.saveOAuthClientCredentials({ clientId, clientSecret });
}

export async function runGoogleCalendarAuth(config: GoogleCalendarConfig, repository: GoogleCalendarRepository): Promise<void> {
  const { code, redirectUri } = await receiveOAuthCode(config.authRedirectPort, async (authUrl) => {
    await open(authUrl);
  }, (redirectUri) => {
    return createGoogleCalendarAuthUrl(config, redirectUri);
  });
  await exchangeGoogleCalendarAuthCode(config, repository, code, redirectUri);
}

export async function createOAuthClientFromStoredToken(config: GoogleCalendarConfig, repository: GoogleCalendarRepository): Promise<InstanceType<typeof google.auth.OAuth2>> {
  const { clientId, clientSecret } = requireGoogleOAuthConfig(config);
  const token = repository.getOAuthToken();
  if (!token?.refreshToken) {
    throw new Error("No Google Calendar refresh token found. Run `dagent services auth calendar` first.");
  }

  const client = new google.auth.OAuth2(clientId, clientSecret);
  client.setCredentials({
    refresh_token: token.refreshToken,
    access_token: token.accessToken,
    expiry_date: token.expiryDate,
    scope: token.scope,
    token_type: token.tokenType
  });
  return client;
}

async function receiveOAuthCode(
  requestedPort: number,
  openBrowser: (authUrl: string) => Promise<void>,
  createAuthUrl: (redirectUri: string) => string
): Promise<{ code: string; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let redirectUri = "";
    const server = createServer((request, response) => {
      const host = request.headers.host;
      if (!host || !request.url) {
        response.writeHead(400).end("Bad request");
        return;
      }
      const url = new URL(request.url, `http://${host}`);
      if (url.pathname !== "/oauth2callback") {
        response.writeHead(404).end("Not found");
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      if (error || !code) {
        settled = true;
        response.writeHead(400, { "Content-Type": "text/plain" }).end(error ?? "Missing authorization code");
        server.close();
        reject(new Error(error ?? "Missing authorization code"));
        return;
      }
      settled = true;
      response.writeHead(200, { "Content-Type": "text/plain" }).end("Google Calendar authorization complete. You can close this tab.");
      server.close();
      resolve({ code, redirectUri });
    });

    server.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });

    server.listen(requestedPort, "127.0.0.1", async () => {
      const address = server.address() as AddressInfo;
      redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`;
      try {
        await openBrowser(createAuthUrl(redirectUri));
      } catch (error) {
        settled = true;
        server.close();
        reject(error);
      }
    });
  });
}
