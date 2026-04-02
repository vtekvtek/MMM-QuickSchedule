const NodeHelper = require("node_helper");
const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const { DateTime } = require("luxon");
const { scrapeToIcs } = require("./scraper");

const LOGFILE = "/home/magicmirror/qs-nodehelper.log";

function log(...args) {
  const msg =
    `[${new Date().toISOString()}] ` +
    args
      .map((a) => {
        if (a instanceof Error) return a.stack || a.message;
        if (typeof a === "object") {
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        }
        return String(a);
      })
      .join(" ");

  console.log(msg);
  try {
    fs.appendFileSync(LOGFILE, msg + "\n", "utf8");
  } catch (e) {
    console.error("Failed writing qs-nodehelper log:", e);
  }
}

function missingScraperConfig() {
  const required = [
    "QS_USERNAME",
    "QS_PASSWORD",
    "QS_LOGIN_URL",
    "TECH_NAME",
    "OUT_ICS",
  ];
  return required.filter((k) => !process.env[k] || !String(process.env[k]).trim());
}

function parsePart(part, min, max) {
  const out = new Set();

  const addNum = (n) => {
    if (Number.isInteger(n) && n >= min && n <= max) out.add(n);
  };

  const addRange = (a, b, step = 1) => {
    for (let i = a; i <= b; i += step) addNum(i);
  };

  const parseToken = (tok) => {
    const stepMatch = tok.match(/^\*\/(\d+)$/);
    if (stepMatch) {
      const step = parseInt(stepMatch[1], 10);
      if (!step || step < 1) return;
      for (let i = min; i <= max; i += step) addNum(i);
      return;
    }

    const rangeStepMatch = tok.match(/^(\d+)-(\d+)(?:\/(\d+))?$/);
    if (rangeStepMatch) {
      const a = parseInt(rangeStepMatch[1], 10);
      const b = parseInt(rangeStepMatch[2], 10);
      const step = rangeStepMatch[3] ? parseInt(rangeStepMatch[3], 10) : 1;
      if (!step || step < 1) return;
      addRange(a, b, step);
      return;
    }

    if (tok === "*") {
      addRange(min, max, 1);
      return;
    }

    if (/^\d+$/.test(tok)) {
      addNum(parseInt(tok, 10));
    }
  };

  const tokens = String(part).split(",");
  for (const t of tokens) parseToken(t.trim());

  const arr = Array.from(out).sort((a, b) => a - b);
  return arr.length ? arr : null;
}

function parseCron5(expr) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error("Cron must have 5 fields: min hour dom mon dow");
  }

  const [minP, hourP, domP, monP, dowP] = parts;

  const minutes = parsePart(minP, 0, 59);
  const hours = parsePart(hourP, 0, 23);
  const dom = parsePart(domP, 1, 31);
  const mon = parsePart(monP, 1, 12);

  let dowNorm = String(dowP).replace(/\b7\b/g, "0");
  const dow = parsePart(dowNorm, 0, 6);

  if (!minutes || !hours || !dom || !mon || !dow) {
    throw new Error("Cron fields could not be parsed");
  }

  return { minutes, hours, dom, mon, dow };
}

function nextRunFromCron(expr, zone, fromDt) {
  const cron = parseCron5(expr);

  let dt = fromDt.setZone(zone).startOf("minute");

  const maxSteps = 60 * 24 * 60;

  for (let i = 0; i < maxSteps; i++) {
    const m = dt.minute;
    const h = dt.hour;
    const day = dt.day;
    const month = dt.month;

    const wd = dt.weekday === 7 ? 0 : dt.weekday;

    if (
      cron.minutes.includes(m) &&
      cron.hours.includes(h) &&
      cron.dom.includes(day) &&
      cron.mon.includes(month) &&
      cron.dow.includes(wd)
    ) {
      return dt;
    }

    dt = dt.plus({ minutes: 1 });
  }

  throw new Error("No next run found within 60 days");
}

function mergeDaysByDate(daysA, daysB) {
  const map = new Map();

  const addAll = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const d of arr) {
      if (!d || !d.date) continue;
      map.set(String(d.date), d);
    }
  };

  addAll(daysA);
  addAll(daysB);

  return Array.from(map.values()).sort((x, y) =>
    String(x.date).localeCompare(String(y.date))
  );
}

module.exports = NodeHelper.create({
  start() {
    this.config = null;
    this.lastGood = null;
    this.timer = null;
    this.isScraping = false;
    this.pendingReason = null;
    log("NodeHelper started");
  },

  socketNotificationReceived(notification, payload) {
    log("socketNotificationReceived:", notification);

    if (notification === "CONFIG") {
      const sameConfig =
        this.config &&
        JSON.stringify(this.config) === JSON.stringify(payload);

      this.config = payload;

      log("CONFIG received", {
        timezone: this.config && this.config.timezone,
        refreshCron: this.config && this.config.refreshCron,
        duplicate: !!sameConfig,
      });

      if (!sameConfig) {
        this.runScrape("startup").catch((e) => {
          log("Startup scrape error:", e);
        });
        this.scheduleFromCron();
      }

      return;
    }

    if (notification === "FORCE_REFRESH") {
      log("FORCE_REFRESH received");
      this.runScrape("manual").catch((e) => {
        log("Manual scrape error:", e);
      });
    }
  },

  scheduleFromCron() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const cronExpr = this.config && this.config.refreshCron;
    if (!cronExpr) {
      log("No refreshCron configured, skipping scheduler");
      return;
    }

    const timezone =
      process.env.TIMEZONE ||
      (this.config && this.config.timezone) ||
      "America/Toronto";

    let next;
    try {
      next = nextRunFromCron(cronExpr, timezone, DateTime.now().setZone(timezone));
    } catch (e) {
      log("Invalid refreshCron:", cronExpr, e);
      this.sendSocketNotification("WEEK_ERROR", {
        reason: "cron-parse",
        error: "Invalid refreshCron: " + String(e && e.message ? e.message : e),
      });
      return;
    }

    const now = DateTime.now().setZone(timezone);
    const ms = Math.max(1000, next.toMillis() - now.toMillis());

    log("Next cron run scheduled", {
      cronExpr,
      timezone,
      now: now.toISO(),
      next: next.toISO(),
      delayMs: ms,
    });

    this.timer = setTimeout(async () => {
      log("Cron timer fired");
      await this.runScrape("cron").catch((e) => {
        log("Cron scrape error:", e);
      });
      this.scheduleFromCron();
    }, ms);
  },

  async runScrape(reason) {
    const timezone =
      process.env.TIMEZONE ||
      (this.config && this.config.timezone) ||
      "America/Toronto";

    if (this.isScraping) {
      log("runScrape skipped, already running", { reason });
      this.pendingReason = reason;
      return;
    }

    this.isScraping = true;
    log("runScrape starting", { reason, timezone });

    try {
      const missing = missingScraperConfig();
      if (missing.length) {
        log("Missing scraper config:", missing);
        this.sendSocketNotification("WEEK_ERROR", {
          reason: "config",
          error: "Missing required scraper config: " + missing.join(", "),
        });
        return;
      }

      const now = DateTime.now().setZone(timezone);
      const thisMonthBaseISO = now.toISODate();
      const nextMonthBaseISO = now.plus({ months: 1 }).startOf("month").toISODate();

      log("Scrape date window", {
        thisMonthBaseISO,
        nextMonthBaseISO,
      });

      log("Starting current month scrape");
      const cur = await scrapeToIcs({
        username: process.env.QS_USERNAME,
        password: process.env.QS_PASSWORD,
        loginUrl: process.env.QS_LOGIN_URL,
        techName: process.env.TECH_NAME,
        outIcs: process.env.OUT_ICS,
        timezone,
        headless: true,
        baseDateISO: thisMonthBaseISO,
        writeIcs: true,
      });

      log("Starting next month scrape");
      const nxt = await scrapeToIcs({
        username: process.env.QS_USERNAME,
        password: process.env.QS_PASSWORD,
        loginUrl: process.env.QS_LOGIN_URL,
        techName: process.env.TECH_NAME,
        outIcs: process.env.OUT_ICS,
        timezone,
        headless: true,
        baseDateISO: nextMonthBaseISO,
        writeIcs: false,
      });

      log("Both scrapes returned", {
        curDays: Array.isArray(cur.days) ? cur.days.length : -1,
        nxtDays: Array.isArray(nxt.days) ? nxt.days.length : -1,
      });

      const mergedDays = mergeDaysByDate(cur.days, nxt.days);

      log("Merged days built", { mergedDays: mergedDays.length });

      const data = {
        scheduleUrl: cur.scheduleUrl,
        outIcs: cur.outIcs,
        days: mergedDays,
        updatedAt: DateTime.now().setZone(timezone).toISO(),
        fresh: true,
      };

      this.lastGood = data;

      log("runScrape success", {
        reason,
        currentMonthDays: Array.isArray(cur.days) ? cur.days.length : 0,
        nextMonthDays: Array.isArray(nxt.days) ? nxt.days.length : 0,
        mergedDays: mergedDays.length,
        outIcs: cur.outIcs,
      });

      log("Sending WEEK_DATA");
      this.sendSocketNotification("WEEK_DATA", data);
    } catch (e) {
      log("runScrape failed", {
        reason,
        error: e instanceof Error ? e.message : String(e),
      });

      if (this.lastGood) {
        const cached = { ...this.lastGood, fresh: false };
        log("Sending cached WEEK_DATA after failure");
        this.sendSocketNotification("WEEK_DATA", cached);
      }

      this.sendSocketNotification("WEEK_ERROR", {
        reason,
        error: String(e && e.message ? e.message : e),
      });
    } finally {
      this.isScraping = false;

      if (this.pendingReason) {
        const pending = this.pendingReason;
        this.pendingReason = null;
        log("Running pending scrape", { reason: pending });
        this.runScrape(pending).catch((e) => {
          log("Pending scrape error:", e);
        });
      }
    }
  },
});
