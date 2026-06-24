import { startScheduler } from "./scheduler.ts";

console.error("[cron] portfolio-mcp scheduler (standalone, no HTTP)");
startScheduler();
