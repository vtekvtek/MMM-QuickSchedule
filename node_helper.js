const NodeHelper = require("node_helper");
require("dotenv").config();
const { DateTime } = require("luxon");
const { scrapeToIcs } = require("./scraper");

module.exports = NodeHelper.create({
  start() {
    this.config = null;
    this.lastData = null;
    this.running = false;
  },

  socketNotificationReceived(notification, payload) {
    if (notification === "CONFIG") {
      this.config = payload;
      this.kick();
      return;
    }

    if (notification === "FORCE_REFRESH") {
      this.kick(true);
      return;
    }
  },

  async kick(force = false) {
    if (!this.config) return;
    if (this.running) return;

    const intervalMin = Number(this.config.refreshMinutes || 30);
    const now = DateTime.now().setZone(this.config.timezone || "America/Toronto");

    const shouldRun =
      force ||
      !this.lastData ||
      !this.lastRunAt ||
      now.diff(this.lastRunAt, "minutes").minutes >= intervalMin;

    if (!shouldRun && this.lastData) {
      this.sendSocketNotification("WEEK_DATA", this.lastData);
      return;
    }

    this.running = true;

    try {
      const data = await scrapeToIcs({
        username: process.env.QS_USERNAME,
        password: process.env.QS_PASSWORD,
        loginUrl: process.env.QS_LOGIN_URL,
        techName: process.env.TECH_NAME,
        outIcs: process.env.OUT_ICS,
        timezone: process.env.TIMEZONE || this.config.timezone || "America/Toronto",
        headless: true,
      });

      this.lastRunAt = now;
      this.lastData = data;

      this.sendSocketNotification("WEEK_DATA", data);
    } catch (e) {
      const err = {
        error: String(e && e.message ? e.message : e),
        lastGood: this.lastData || null,
      };
      this.sendSocketNotification("WEEK_ERROR", err);
    } finally {
      this.running = false;
    }
  },
});
