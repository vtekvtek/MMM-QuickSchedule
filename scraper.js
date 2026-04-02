const puppeteer = require("puppeteer");
const ical = require("ical-generator").default;
const { DateTime } = require("luxon");
const fs = require("fs");
const path = require("path");

const LOGFILE = "/home/magicmirror/qs-scraper.log";
const DEBUG_HTML = "/tmp/qs-error.html";
const DEBUG_PNG = "/tmp/qs-error.png";

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
    console.error("Failed writing log:", e);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mondayStart(dt) {
  return dt.startOf("day").minus({ days: dt.weekday - 1 });
}

function parseMdyDate(mdy, zone) {
  const d = DateTime.fromFormat(String(mdy).trim(), "M/d/yyyy", { zone });
  return d.isValid ? d : null;
}

function buildScheduleUrl(techName, zone, baseDate) {
  const dt = baseDate ? baseDate.setZone(zone) : DateTime.now().setZone(zone);
  const dateValue = encodeURIComponent(dt.toFormat("M/d/yyyy"));
  const nameSelected = encodeURIComponent(techName);
  return `https://schedule.quickservice.com/SingleTechScheduleList.aspx?NameSelected=${nameSelected}&DateValue=${dateValue}`;
}

function escIdForCss(id) {
  return String(id).replace(/([ #;?%&,.+*~\':"!^$[\]()=>|\/@])/g, "\\$1");
}

async function findLoginFields(page) {
  const candidates = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll("input"));
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };

    const user = inputs
      .filter((i) => i.type === "text" && visible(i))
      .map((i) => ({ id: i.id, name: i.name, placeholder: i.placeholder || "" }))
      .filter((x) => x.id || x.name);

    const pass = inputs
      .filter((i) => i.type === "password" && visible(i))
      .map((i) => ({ id: i.id, name: i.name, placeholder: i.placeholder || "" }))
      .filter((x) => x.id || x.name);

    const submit = inputs
      .filter((i) => (i.type === "submit" || i.type === "button") && visible(i))
      .map((i) => ({ id: i.id, name: i.name, value: i.value || "" }))
      .filter((x) => x.id || x.name);

    return { user, pass, submit };
  });

  const pick = (arr, hint) => {
    const h = hint.toLowerCase();
    return (
      arr.find(
        (x) =>
          (x.id || "").toLowerCase().includes(h) ||
          (x.name || "").toLowerCase().includes(h) ||
          (x.placeholder || "").toLowerCase().includes(h)
      ) ||
      arr[0] ||
      null
    );
  };

  const user = pick(candidates.user, "user") || pick(candidates.user, "name");
  const pass = pick(candidates.pass, "pass") || candidates.pass[0] || null;
  const submit =
    pick(candidates.submit, "login") ||
    pick(candidates.submit, "sign") ||
    candidates.submit[0] ||
    null;

  return { user, pass, submit };
}

function selectorFor(field) {
  if (!field) return null;
  if (field.id) return `#${escIdForCss(field.id)}`;
  return `input[name="${field.name}"]`;
}

async function writeDebugArtifacts(page, reason) {
  try {
    const html = await page.content();
    fs.writeFileSync(DEBUG_HTML, html, "utf8");
    await page.screenshot({ path: DEBUG_PNG, fullPage: true });
    log("Saved debug artifacts:", reason, DEBUG_HTML, DEBUG_PNG, "URL:", page.url());
  } catch (e) {
    log("Failed saving debug artifacts:", e);
  }
}

async function scrapeToIcs(config) {
  const {
    username,
    password,
    loginUrl,
    techName,
    outIcs,
    timezone,
    headless = true,
    baseDateISO = null,
    writeIcs = true,
  } = config;

  if (!username || !password || !loginUrl || !techName || !timezone) {
    throw new Error("Missing required config for scraper");
  }
  if (writeIcs && !outIcs) {
    throw new Error("Missing outIcs while writeIcs=true");
  }

  const baseDate = baseDateISO
    ? DateTime.fromISO(baseDateISO, { zone: timezone })
    : DateTime.now().setZone(timezone);

  log("scrapeToIcs starting", {
    techName,
    timezone,
    baseDateISO: baseDate.toISODate(),
    headless,
    writeIcs,
  });

  let browser;
  let page;

  try {
    browser = await puppeteer.launch({
      headless: headless ? "new" : false,
      protocolTimeout: 180000,
      slowMo: 25,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });

    page = await browser.newPage();
    page.setDefaultTimeout(180000);
    page.setDefaultNavigationTimeout(180000);

    await page.setViewport({ width: 1280, height: 720 });

    await page.setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
    );

    log("Opening login page:", loginUrl);
    await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 120000 });

    const { user, pass, submit } = await findLoginFields(page);
    const userSel = selectorFor(user);
    const passSel = selectorFor(pass);
    const submitSel = selectorFor(submit);

    log("Detected login selectors:", {
      userSel,
      passSel,
      submitSel,
    });

    if (!userSel || !passSel || !submitSel) {
      await writeDebugArtifacts(page, "login-fields-not-found");
      throw new Error("Could not identify login fields. Hardcode selectors in scraper.js.");
    }

    await page.focus(userSel);
    await page.keyboard.type(username, { delay: 10 });
    await page.focus(passSel);
    await page.keyboard.type(password, { delay: 10 });

    log("Submitting login");
    await Promise.allSettled([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }),
      page.click(submitSel),
    ]);

    await sleep(2000);
    log("After login URL:", page.url());

    const scheduleUrl = buildScheduleUrl(techName, timezone, baseDate);
    log("Navigating to schedule:", scheduleUrl);

    await page.goto(scheduleUrl, { waitUntil: "networkidle2", timeout: 120000 });
    await sleep(3000);
    log("Schedule page URL:", page.url());

    log("Waiting for schedule table");
    try {
      await page.waitForSelector("#ctl00_ContentPlaceHolder1_GridView1", { timeout: 60000 });
      log("Schedule table found");
    } catch (e) {
      log("Schedule table not found within timeout");
      await writeDebugArtifacts(page, "schedule-grid-missing");
      throw new Error(
        `Waiting for selector #ctl00_ContentPlaceHolder1_GridView1 failed on URL ${page.url()}`
      );
    }

    const rows = await page.$$eval("#ctl00_ContentPlaceHolder1_GridView1 tr", (trs) => {
      const out = [];
      for (let i = 1; i < trs.length; i++) {
        const tds = trs[i].querySelectorAll("td");
        if (tds.length < 3) continue;
        out.push({
          day: tds[0].innerText.trim(),
          date: tds[1].innerText.trim(),
          desc: tds[2].innerText.replace(/\s+/g, " ").trim(),
        });
      }
      return out;
    });

    log("Rows scraped:", rows.length);

    if (!rows.length) {
      await writeDebugArtifacts(page, "no-schedule-rows");
      throw new Error("No schedule rows found. Login may have failed.");
    }

    const monthDays = new Map();
    for (const r of rows) {
      const dt = parseMdyDate(r.date, timezone);
      if (!dt) {
        log("Skipping invalid date row:", r.date, r.desc);
        continue;
      }
      const iso = dt.toISODate();
      monthDays.set(iso, {
        date: iso,
        dow: dt.toFormat("ccc"),
        desc: r.desc,
        isOff: /\bOFF\b/i.test(r.desc),
      });
    }

    const monthDaysArr = Array.from(monthDays.values()).sort((a, b) =>
      String(a.date).localeCompare(String(b.date))
    );

    const weekStart = mondayStart(baseDate);

    const weekDays = [];
    for (let i = 0; i < 7; i++) {
      const dt = weekStart.plus({ days: i });
      const iso = dt.toISODate();
      const item = monthDays.get(iso);

      weekDays.push(
        item || {
          date: iso,
          dow: dt.toFormat("ccc"),
          desc: "—",
          isOff: false,
        }
      );
    }

    log("Computed ranges:", {
      weekStart: weekStart.toISODate(),
      monthDayCount: monthDaysArr.length,
      weekDayCount: weekDays.length,
    });

    if (writeIcs) {
      const cal = ical({ name: "Work Schedule", timezone });

      for (const d of weekDays) {
        const dt = DateTime.fromISO(d.date, { zone: timezone });
        cal.createEvent({
          start: dt.toJSDate(),
          end: dt.plus({ days: 1 }).toJSDate(),
          allDay: true,
          summary: d.isOff ? "OFF" : "Work",
          description: d.desc,
        });
      }

      fs.mkdirSync(path.dirname(outIcs), { recursive: true });
      fs.writeFileSync(outIcs, cal.toString(), "utf8");
      log("ICS written:", outIcs);
    }

    log("scrapeToIcs success");

    return {
      scheduleUrl,
      monthRowCount: rows.length,
      weekRowCount: weekDays.length,
      weekStart: weekStart.toISODate(),
      outIcs: writeIcs ? outIcs : null,
      days: monthDaysArr,
      weekDays,
    };
  } catch (e) {
    log("scrapeToIcs ERROR:", e);
    throw e;
  } finally {
    try {
      if (page) await page.close();
    } catch (e) {
      log("Error closing page:", e);
    }

    try {
      if (browser) await browser.close();
    } catch (e) {
      log("Error closing browser:", e);
    }
  }
}

module.exports = { scrapeToIcs };
