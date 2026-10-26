import { request } from "node:http";
import { pathToFileURL } from "node:url";

const DEFAULT_DOCKER_SOCKET_PATH = "/var/run/docker.sock";

async function main(): Promise<void> {
  const containerName = process.argv[2]?.trim();
  if (!containerName) throw new Error("Usage: restartDockerContainer <container-name>");
  await restartDockerContainer(containerName);
}

export async function restartDockerContainer(containerName: string, socketPath = DEFAULT_DOCKER_SOCKET_PATH): Promise<void> {
  const name = encodeURIComponent(containerName);
  await dockerRequest({ socketPath, path: `/containers/${name}/restart`, method: "POST" });
}

function dockerRequest(options: { socketPath: string; path: string; method: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: options.socketPath,
        path: options.path,
        method: options.method
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
            return;
          }
          reject(new Error(`Docker API returned ${res.statusCode ?? "unknown status"}${body ? `: ${body}` : ""}`));
        });
      }
    );
    req.once("error", reject);
    req.end();
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
