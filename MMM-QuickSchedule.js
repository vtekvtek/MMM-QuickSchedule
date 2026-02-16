Module.register("MMM-QuickSchedule", {
  defaults: {
    title: "My Week",
    refreshMinutes: 30,
    timezone: "America/Toronto",
    showOff: true,
    offRegex: "\\bOFF\\b",
    maxText: 26
  },

  start() {
    this.week = null;
    this.error = null;
    this.sendSocketNotification("CONFIG", this.config);
  },

  getStyles() {
    return [ "MMM-QuickSchedule.css" ];
  },

  socketNotificationReceived(notification, payload) {
    if (notification === "WEEK_DATA") {
      this.week = payload;
      this.error = null;
      this.updateDom();
      return;
    }
    if (notification === "WEEK_ERROR") {
      this.error = payload;
      this.updateDom();
      return;
    }
  },

  getDom() {
    const wrapper = document.createElement("div");
    wrapper.className = "qs-week";

    const title = document.createElement("div");
    title.className = "qs-title";
    title.textContent = this.config.title;
    wrapper.appendChild(title);

    if (this.error && !this.week && this.error.lastGood) {
      this.week = this.error.lastGood;
    }

    if (this.error && !this.week) {
      const err = document.createElement("div");
      err.className = "qs-error";
      err.textContent = this.error.error || "Error loading schedule";
      wrapper.appendChild(err);
      return wrapper;
    }

    if (!this.week) {
      const loading = document.createElement("div");
      loading.className = "qs-loading";
      loading.textContent = "Loading…";
      wrapper.appendChild(loading);
      return wrapper;
    }

    const row = document.createElement("div");
    row.className = "qs-row";

    // Build 7-day frame from the scraper output
    // If scraper returns fewer than 7 rows, we still show placeholders
    const byDate = new Map();
    if (Array.isArray(this.week.days)) {
      for (const d of this.week.days) byDate.set(d.date, d);
    }

    const start = this.week.weekStart ? moment(this.week.weekStart) : moment().startOf("isoWeek");

    for (let i = 0; i < 7; i++) {
      const m = start.clone().add(i, "days");
      const dateKey = m.format("YYYY-MM-DD");
      const dow = m.format("ddd");

      const item = byDate.get(dateKey);
      const descRaw = item ? item.desc : "—";
      const isOff = item ? item.isOff : new RegExp(this.config.offRegex, "i").test(descRaw);

      if (!this.config.showOff && isOff) continue;

      const cell = document.createElement("div");
      cell.className = "qs-cell";

      const dowEl = document.createElement("div");
      dowEl.className = "qs-dow";
      dowEl.textContent = dow;
      cell.appendChild(dowEl);

      const desc = document.createElement("div");
      desc.className = "qs-desc";
      desc.textContent = String(descRaw).slice(0, this.config.maxText);
      cell.appendChild(desc);

      row.appendChild(cell);
    }

    wrapper.appendChild(row);

    if (this.error) {
      const warn = document.createElement("div");
      warn.className = "qs-warn";
      warn.textContent = "Using last saved schedule.";
      wrapper.appendChild(warn);
    }

    return wrapper;
  }
});
