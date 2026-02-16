const NodeHelper = require("node_helper");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const { DateTime } = require("luxon");
const cronParser = require("cron-parser");
const { scrapeToIcs } = require("./scraper");

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

      // Schedule using refreshCron if provided
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

    let nextDate;
    try {
      const interval = cronParser.parseExpression(cronExpr, {
        tz: timezone,
        currentDate: new Date(),
      });
      nextDate = interval.next().toDate();
    } catch (e) {
      this.sendSocketNotification("WEEK_ERROR", {
        reason: "cron-parse",
        error: "Invalid refreshCron: " + String(e && e.message ? e.message : e),
      });
      return;
    }

    const ms = Math.max(1000, nextDate.getTime() - Date.now());

    this.timer = setTimeout(async () => {
      await this.runScrape("cron").catch(() => null);
      this.scheduleFromCron(); // schedule the next one
    }, ms);
  },

  async runScrape(reason) {
    const timezone = process.env.TIMEZONE || (this.config && this.config.timezone) || "America/Toronto";

    try {
      const data = await scrapeToIcs({
        username: process.env.QS_USERNAME,
        password: process.env.QS_PASSWORD,
        loginUrl: process.env.QS_LOGIN_URL,
        techName: process.env.TECH_NAME,
        outIcs: process.env.OUT_ICS,
        timezone,
        headless: true,
      });

      // Stamp successful update time (ISO string) and freshness flag
      data.updatedAt = DateTime.now().setZone(timezone).toISO();
      data.fresh = true;

      this.lastGood = data;
      this.sendSocketNotification("WEEK_DATA", data);
    } catch (e) {
      // Keep showing last good data if we have it
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
