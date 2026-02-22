Module.register("MMM-QuickSchedule", {
  defaults: {
    title: "My Week",
    timezone: "America/Toronto",
    showOff: true,
    offRegex: "\\bOFF\\b",
    maxLines: 3,
    compact: false
  },

  start() {
    this.week = null;
    this.error = null;
    this.sendSocketNotification("CONFIG", this.config);
  },

  getStyles() {
    return ["MMM-QuickSchedule.css"];
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
    if (this.config.compact) wrapper.classList.add("qs-compact");

    const title = document.createElement("div");
    title.className = "qs-title";
    title.textContent = this.config.title;
    wrapper.appendChild(title);

    // Last updated (timezone-safe)
    if (this.week && this.week.updatedAt) {
      const updated = document.createElement("div");
      const when = moment.tz(this.week.updatedAt, this.config.timezone).format("MMM D, h:mm A");
      const status = (this.week.fresh === false) ? "cached" : "live";

      updated.className = "qs-updated" + (status === "cached" ? " qs-updated-cached" : "");
      updated.textContent = "Last updated: " + when + " (" + status + ")";
      wrapper.appendChild(updated);
    }

    if (this.error && !this.week && this.error.lastGood) {
      this.week = this.error.lastGood;
    }

    if (this.error && !this.week) {
      const err = document.createElement("div");
      err.className = "qs-error";
      err.textContent = (this.error && this.error.error) ? this.error.error : "Error loading schedule";
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

    const byDate = new Map();
    if (Array.isArray(this.week.days)) {
      for (const d of this.week.days) {
        if (d && d.date) byDate.set(d.date, d);
      }
    }

    // Weekend logic: Sat/Sun show NEXT ISO week (Mon-Sun), otherwise THIS ISO week
    const now = moment().tz(this.config.timezone);
    const isoDowNow = now.isoWeekday(); // 1=Mon ... 7=Sun
    const isWeekendNow = (isoDowNow === 6 || isoDowNow === 7);

    let start;
    if (isWeekendNow) {
      start = now.clone().add(1, "week").startOf("isoWeek");
    } else {
      start = now.clone().startOf("isoWeek");
    }

    const todayKey = now.format("YYYY-MM-DD");
    const highlightToday = !isWeekendNow; // on weekends we're viewing next week

    for (let i = 0; i < 7; i++) {
      const m = start.clone().add(i, "days");
      const dateKey = m.format("YYYY-MM-DD");
      const dow = m.format("ddd");

      const item = byDate.get(dateKey);

      // TBD logic: missing future entries show TBD, missing past/today show —
      const isMissing = !item || !item.desc;
      const isFuture = m.isAfter(now, "day");
      const descRaw = isMissing ? (isFuture ? "TBD" : "—") : item.desc;

      const isOff = item
        ? item.isOff
        : new RegExp(this.config.offRegex, "i").test(String(descRaw || ""));

      if (!this.config.showOff && isOff) continue;

      const cell = document.createElement("div");
      cell.className = "qs-cell";

      // classify shift type
      const descText = String(descRaw || "").trim();

      if (isOff) {
        cell.classList.add("qs-off");
      } else if (/\b(vacation|vac|pto)\b/i.test(descText)) {
        cell.classList.add("qs-vacation");
      } else if (/\bSICK\s*DAY\b/i.test(descText)) {
        cell.classList.add("qs-sick");
      } else if (/\b(helpdesk|service)\b/i.test(descText)) {
        cell.classList.add("qs-home");
      } else if (/\binstall\b/i.test(descText)) {
        cell.classList.add("qs-install");
      } else {
        cell.classList.add("qs-other");
      }

      // Weekend coloring (based on tile date)
      const isoDow = m.isoWeekday();
      if (isoDow === 6) cell.classList.add("qs-sat");
      if (isoDow === 7) cell.classList.add("qs-sun");

      // Highlight today only when viewing the current week
      if (highlightToday && dateKey === todayKey) {
        cell.classList.add("qs-today");
      }

      const dowEl = document.createElement("div");
      dowEl.className = "qs-dow";
      dowEl.textContent = dow;
      cell.appendChild(dowEl);

      const dateEl = document.createElement("div");
      dateEl.className = "qs-date";
      dateEl.textContent = m.format("MMM D");
      cell.appendChild(dateEl);

      const desc = document.createElement("div");
      desc.className = "qs-desc";
      desc.style.webkitLineClamp = String(this.config.maxLines);
      desc.textContent = String(descRaw);
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
