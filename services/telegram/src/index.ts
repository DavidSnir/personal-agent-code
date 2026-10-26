import { runApp } from "./app.js";

try {
  await runApp();
} catch (error) {
  console.error("Startup failed:", error);
  process.exitCode = 1;
}
