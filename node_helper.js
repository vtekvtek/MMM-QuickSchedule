const NodeHelper = require("node_helper");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const { DateTime } = require("luxon");
const { scrapeToIcs } = require("./scraper");

// Minimal 5-field cron scheduler (minute hour dom mon dow)
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
  if (parts.length !== 5) throw new Error("Cron must have 5 fields: min hour dom mon dow");

  const [minP, hourP, domP, monP, dowP] = parts;

  const minutes = parsePart(minP, 0, 59);
  const hours = parsePart(hourP, 0, 23);
  const dom = parsePart(domP, 1, 31);
  const mon = parsePart(monP, 1, 12);

  // DOW: allow 7 as Sunday, convert to 0
  let dowNorm = String(dowP).replace(/\b7\b/g, "0");
  const dow = parsePart(dowNorm, 0, 6);

  if (!minutes || !hours || !dom || !mon || !dow) throw new Error("Cron fields could not be parsed");
  return { minutes, hours, dom, mon, dow };
}

function nextRunFromCron(expr, zone, fromDt) {
  const cron = parseCron5(expr);
  let dt = fromDt.setZone(zone).startOf("minute").plus({ minutes: 1 });

  const maxSteps = 60 * 24 * 60; // 60 days
  for (let i = 0; i < maxSteps; i++) {
    const m = dt.minute;
    const h = dt.hour;
    const day = dt.day;
    const month = dt.month;

    // Luxon weekday: 1=Mon..7=Sun, convert to 0=Sun..6=Sat
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

  throw new Error("No next run found within 60 days, cron may be too restrictive");
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

  return Array.from(map.values()).sort((x, y) => String(x.date).localeCompare(String(y.date)));
}

module.exports = NodeHelper.create({
  start() {
    this.config = null;
    this.lastGood = null;
    this.timer = null;
  },

  socketNotificationReceived(notification, payload) {
    if (notification === "CONFIG") {
      this.config = payload;

      // Run once on startup
      this.runScrape("startup").catch(() => null);

      // Schedule from refreshCron (if provided)
      this.scheduleFromCron();
      return;
    }

    if (notification === "FORCE_REFRESH") {
      this.runScrape("manual").catch(() => null);
    }
  },

  scheduleFromCron() {
    if (this.timer) clearTimeout(this.timer);

    const cronExpr = this.config && this.config.refreshCron;
    if (!cronExpr) return;

    const timezone = process.env.TIMEZONE || (this.config && this.config.timezone) || "America/Toronto";

    let next;
    try {
      next = nextRunFromCron(cronExpr, timezone, DateTime.now().setZone(timezone));
    } catch (e) {
      this.sendSocketNotification("WEEK_ERROR", {
        reason: "cron-parse",
        error: "Invalid refreshCron: " + String(e && e.message ? e.message : e),
      });
      return;
    }

    const ms = Math.max(1000, next.toMillis() - DateTime.now().toMillis());

    this.timer = setTimeout(async () => {
      await this.runScrape("cron").catch(() => null);
      this.scheduleFromCron();
    }, ms);
  },

  async runScrape(reason) {
    const timezone = process.env.TIMEZONE || (this.config && this.config.timezone) || "America/Toronto";

    const now = DateTime.now().setZone(timezone);

    const thisMonthBaseISO = now.toISODate();
    const nextMonthBaseISO = now.plus({ months: 1 }).startOf("month").toISODate();

    try {
      const [cur, nxt] = await Promise.all([
        scrapeToIcs({
          username: process.env.QS_USERNAME,
          password: process.env.QS_PASSWORD,
          loginUrl: process.env.QS_LOGIN_URL,
          techName: process.env.TECH_NAME,
          outIcs: process.env.OUT_ICS,
          timezone,
          headless: true,
          baseDateISO: thisMonthBaseISO,
          writeIcs: true,
        }),
        scrapeToIcs({
          username: process.env.QS_USERNAME,
          password: process.env.QS_PASSWORD,
          loginUrl: process.env.QS_LOGIN_URL,
          techName: process.env.TECH_NAME,
          outIcs: process.env.OUT_ICS,
          timezone,
          headless: true,
          baseDateISO: nextMonthBaseISO,
          writeIcs: false,
        }),
      ]);

      const mergedDays = mergeDaysByDate(cur.days, nxt.days);

      const data = {
        scheduleUrl: cur.scheduleUrl,
        outIcs: cur.outIcs,
        days: mergedDays,
        monthRowCount: (cur.monthRowCount || 0) + (nxt.monthRowCount || 0),
        curMonthRowCount: cur.monthRowCount,
        nextMonthRowCount: nxt.monthRowCount,
        baseDateISO: thisMonthBaseISO,
        nextMonthBaseISO,
        updatedAt: DateTime.now().setZone(timezone).toISO(),
        fresh: true,
      };

      this.lastGood = data;
      this.sendSocketNotification("WEEK_DATA", data);
    } catch (e) {
      if (this.lastGood) {
        const cached = { ...this.lastGood, fresh: false };
        this.sendSocketNotification("WEEK_DATA", cached);
      }

      this.sendSocketNotification("WEEK_ERROR", {
        reason,
        error: String(e && e.message ? e.message : e),
      });
    }
  },
});
