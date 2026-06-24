import { writeSnapshotResilient, type Trigger } from "../portfolio/store.ts";
import { detectAllFlows } from "../portfolio/detect.ts";
import { runDbMaintenance } from "../lib/maintenance.ts";
import { resetUsdRubCache } from "../lib/usdRub.ts";
import { clearCoinGeckoCache } from "../lib/coingecko.ts";

const MAINTENANCE_MS = 6 * 60 * 60 * 1000; // 6h
const MAX_TIMER_MS = 2_147_483_647; // setTimeout upper bound (~24.8 days)

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name] ?? String(fallback));
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

function snapshotTime(): { hour: number; minute: number } {
  return {
    hour: envInt("CRON_SNAPSHOT_HOUR_UTC", 0),
    minute: envInt("CRON_SNAPSHOT_MINUTE_UTC", 10),
  };
}

function detectTime(): { hour: number; minute: number } {
  return {
    hour: envInt("CRON_DETECT_HOUR_UTC", 1),
    minute: envInt("CRON_DETECT_MINUTE_UTC", 0),
  };
}

function detectDays(): number {
  const d = envInt("CRON_DETECT_DAYS", 90);
  return Math.min(365, Math.max(1, d));
}

function utcAt(y: number, mo: number, d: number, h: number, mi: number): Date {
  return new Date(Date.UTC(y, mo, d, h, mi, 0, 0));
}

function lastDayOfMonth(y: number, mo: number): number {
  return new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
}

function nextDaily(now: Date, h: number, mi: number): Date {
  let next = utcAt(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, mi);
  if (next <= now) next = utcAt(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, h, mi);
  return next;
}

function nextMonthStart(now: Date, h: number, mi: number): Date {
  const y = now.getUTCFullYear();
  const mo = now.getUTCMonth();
  let candidate = utcAt(y, mo, 1, h, mi);
  if (candidate <= now) candidate = utcAt(y, mo + 1, 1, h, mi);
  return candidate;
}

function nextMonthEnd(now: Date, h: number, mi: number): Date {
  const y = now.getUTCFullYear();
  const mo = now.getUTCMonth();
  const last = lastDayOfMonth(y, mo);
  let candidate = utcAt(y, mo, last, h, mi);
  if (candidate <= now) {
    const ny = mo === 11 ? y + 1 : y;
    const nm = (mo + 1) % 12;
    candidate = utcAt(ny, nm, lastDayOfMonth(ny, nm), h, mi);
  }
  return candidate;
}

interface Job {
  name: string;
  next: (now: Date) => Date;
  run: () => Promise<void>;
}

/** Release large per-job caches so long-lived cron does not retain portfolio fetch data. */
function releaseJobCaches(): void {
  resetUsdRubCache();
  clearCoinGeckoCache();
}

async function runSnapshot(trigger: Trigger): Promise<void> {
  try {
    const result = await writeSnapshotResilient(trigger);
    console.error(`[cron] snapshot ${trigger}:`, JSON.stringify(result));
  } finally {
    releaseJobCaches();
    runDbMaintenance({ truncateWal: trigger !== "on_chat" });
  }
}

async function runDetect(): Promise<void> {
  try {
    const result = await detectAllFlows(detectDays());
    console.error("[cron] detect_flows:", JSON.stringify(result));
  } finally {
    releaseJobCaches();
    runDbMaintenance();
  }
}

function buildJobs(): Job[] {
  const snap = snapshotTime();
  const det = detectTime();
  // The scheduler runs one job at a time; if month boundaries shared daily's exact
  // minute, daily would win and the month job's slot would already be in the past.
  // Offset the month jobs by a minute so both fire (Date.UTC normalizes any overflow).
  const monthMinute = snap.minute + 1;

  return [
    {
      name: "daily",
      next: (now) => nextDaily(now, snap.hour, snap.minute),
      run: () => runSnapshot("daily"),
    },
    {
      name: "month_start",
      next: (now) => nextMonthStart(now, snap.hour, monthMinute),
      run: () => runSnapshot("month_start"),
    },
    {
      name: "month_end",
      next: (now) => nextMonthEnd(now, snap.hour, monthMinute),
      run: () => runSnapshot("month_end"),
    },
    {
      name: "detect_flows",
      next: (now) => nextDaily(now, det.hour, det.minute),
      run: runDetect,
    },
  ];
}

/** Self-scheduling UTC cron loop (stderr logging only). One timer, one job at a time. */
export function startScheduler(): void {
  const jobs = buildJobs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let maintenanceTimer: ReturnType<typeof setInterval> | undefined;
  let jobRunning = false;
  let stopped = false;

  console.error(
    `[cron] scheduler started; snapshot ${snapshotTime().hour}:${String(snapshotTime().minute).padStart(2, "0")} UTC, ` +
      `detect ${detectTime().hour}:${String(detectTime().minute).padStart(2, "0")} UTC`,
  );

  runDbMaintenance();

  maintenanceTimer = setInterval(() => {
    if (stopped) return;
    runDbMaintenance();
  }, MAINTENANCE_MS);

  const stop = (): void => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    if (maintenanceTimer !== undefined) clearInterval(maintenanceTimer);
    timer = undefined;
    maintenanceTimer = undefined;
    console.error("[cron] scheduler stopped");
  };

  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);

  const scheduleNext = (): void => {
    if (stopped) return;

    const now = new Date();
    let nearest = jobs[0]!;
    let nearestAt = nearest.next(now);
    for (const job of jobs.slice(1)) {
      const at = job.next(now);
      if (at < nearestAt) {
        nearest = job;
        nearestAt = at;
      }
    }

    let delay = Math.max(0, nearestAt.getTime() - now.getTime());
    if (delay > MAX_TIMER_MS) delay = MAX_TIMER_MS;

    console.error(`[cron] next job "${nearest.name}" at ${nearestAt.toISOString()} (in ${Math.round(delay / 1000)}s)`);

    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(async () => {
      if (stopped || jobRunning) {
        scheduleNext();
        return;
      }
      jobRunning = true;
      try {
        await nearest.run();
      } catch (err) {
        console.error(`[cron] job "${nearest.name}" failed:`, err);
      } finally {
        jobRunning = false;
      }
      scheduleNext();
    }, delay);
  };

  scheduleNext();
}
