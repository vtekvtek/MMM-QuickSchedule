const NodeHelper = require("node_helper");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const { DateTime } = require("luxon");
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

      // Schedule daily at 18:00
      this.scheduleDaily(18, 0);

      return;
    }

    if (notification === "FORCE_REFRESH") {
      this.runScrape("manual").catch(() => null);
    }
  },

  scheduleDaily(hour, minute) {
    if (this.timer) clearTimeout(this.timer);

    const zone = process.env.TIMEZONE || (this.config && this.config.timezone) || "America/Toronto";
    const now = DateTime.now().setZone(zone);

    let next = now.set({ hour, minute, second: 0, millisecond: 0 });
    if (next <= now) next = next.plus({ days: 1 });

    const ms = next.toMillis() - now.toMillis();

    this.timer = setTimeout(async () => {
      await this.runScrape("daily-18:00").catch(() => null);
      this.scheduleDaily(hour, minute); // reschedule next day
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
        // Mark that this is cached data, not a fresh scrape
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
