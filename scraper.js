const puppeteer = require("puppeteer");
const ical = require("ical-generator");
const { DateTime } = require("luxon");
const fs = require("fs");
const path = require("path");

function mondayStart(dt) {
  return dt.startOf("day").minus({ days: dt.weekday - 1 });
}

function parseMdyDate(mdy, zone) {
  const d = DateTime.fromFormat(String(mdy).trim(), "M/d/yyyy", { zone });
  return d.isValid ? d : null;
}

function buildScheduleUrl(techName, zone) {
  const today = DateTime.now().setZone(zone);
  const dateValue = encodeURIComponent(today.toFormat("M/d/yyyy"));
  const nameSelected = encodeURIComponent(techName);
  return `https://schedule.quickservice.com/SingleTechScheduleList.aspx?NameSelected=${nameSelected}&DateValue=${dateValue}`;
}

function escIdForCss(id) {
  // Escape CSS selector special chars for ids
  return String(id).replace(/([ #;?%&,.+*~\':"!^$[\]()=>|\/@])/g, "\\$1");
}

async function findLoginFields(page) {
  // Broad detection of visible login fields.
  // If this fails, we can hardcode based on your login form HTML.
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
      arr.find((x) => (x.id || "").toLowerCase().includes(h) || (x.name || "").toLowerCase().includes(h) || (x.placeholder || "").toLowerCase().includes(h)) ||
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

async function scrapeToIcs(config) {
  const {
    username,
    password,
    loginUrl,
    techName,
    outIcs,
    timezone,
    headless = true,
  } = config;

  if (!username || !password || !loginUrl || !techName || !outIcs || !timezone) {
    throw new Error("Missing required config for scraper");
  }

  const browser = await puppeteer.launch({
    headless: headless ? "new" : false,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(60000);

  await page.setUserAgent(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
  );

  // 1) Login
  await page.goto(loginUrl, { waitUntil: "networkidle2" });

  const { user, pass, submit } = await findLoginFields(page);
  const userSel = selectorFor(user);
  const passSel = selectorFor(pass);
  const submitSel = selectorFor(submit);

  if (!userSel || !passSel || !submitSel) {
    await browser.close();
    throw new Error("Could not identify login fields. Hardcode selectors in scraper.js using the login form HTML.");
  }

  await page.focus(userSel);
  await page.keyboard.type(username, { delay: 10 });
  await page.focus(passSel);
  await page.keyboard.type(password, { delay: 10 });

  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2" }).catch(() => null),
    page.click(submitSel),
  ]);

  // 2) Go to schedule page with today's DateValue
  const scheduleUrl = buildScheduleUrl(techName, timezone);
  await page.goto(scheduleUrl, { waitUntil: "networkidle2" });

  // 3) Scrape the schedule rows
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

  if (!rows.length) {
    await browser.close();
    throw new Error("No schedule rows found. Login may have failed or GridView ID changed.");
  }

  // 4) Filter to current week
  const now = DateTime.now().setZone(timezone);
  const weekStart = mondayStart(now);
  const weekEnd = weekStart.plus({ days: 7 });

  const weekRows = rows
    .map((r) => {
      const dt = parseMdyDate(r.date, timezone);
      return dt ? { ...r, dt } : null;
    })
    .filter(Boolean)
    .filter((r) => r.dt >= weekStart && r.dt < weekEnd);

  // 5) Write ICS as all-day events
  const cal = ical({ name: "Work Schedule", timezone });

  for (const r of weekRows) {
    const isOff = /\bOFF\b/i.test(r.desc);
    cal.createEvent({
      start: r.dt.toJSDate(),
      end: r.dt.plus({ days: 1 }).toJSDate(),
      allDay: true,
      summary: isOff ? "OFF" : "Work",
      description: r.desc,
    });
  }

  fs.mkdirSync(path.dirname(outIcs), { recursive: true });
  fs.writeFileSync(outIcs, cal.toString(), "utf8");

  await browser.close();

  return {
    scheduleUrl,
    monthRowCount: rows.length,
    weekRowCount: weekRows.length,
    weekStart: weekStart.toISODate(),
    outIcs,
    days: weekRows.map((r) => ({
      dow: r.dt.toFormat("ccc"),
      date: r.dt.toISODate(),
      desc: r.desc,
      isOff: /\bOFF\b/i.test(r.desc),
    })),
  };
}

module.exports = {
  scrapeToIcs,
};
