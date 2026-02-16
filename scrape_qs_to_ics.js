import "dotenv/config";
import puppeteer from "puppeteer";
import ical from "ical-generator";
import { DateTime } from "luxon";
import fs from "fs";
import path from "path";

const {
  QS_USERNAME,
  QS_PASSWORD,
  QS_LOGIN_URL,
  TECH_NAME,
  OUT_ICS,
  TIMEZONE = "America/Toronto",
} = process.env;

if (!QS_USERNAME || !QS_PASSWORD || !QS_LOGIN_URL || !TECH_NAME || !OUT_ICS) {
  console.error("Missing env vars. Need QS_USERNAME, QS_PASSWORD, QS_LOGIN_URL, TECH_NAME, OUT_ICS.");
  process.exit(1);
}

function mondayStart(dt) {
  return dt.startOf("day").minus({ days: dt.weekday - 1 }); // Monday
}

function parseMdyDate(mdy, zone) {
  const d = DateTime.fromFormat(mdy.trim(), "M/d/yyyy", { zone });
  return d.isValid ? d : null;
}

function buildScheduleUrl(techName, zone) {
  const today = DateTime.now().setZone(zone);
  const dateValue = encodeURIComponent(today.toFormat("M/d/yyyy"));
  const nameSelected = encodeURIComponent(techName);
  return `https://schedule.quickservice.com/SingleTechScheduleList.aspx?NameSelected=${nameSelected}&DateValue=${dateValue}`;
}

async function findLoginFields(page) {
  // Broad detection, we can hardcode later if needed
  const candidates = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll("input"));
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };

    const user = inputs
      .filter((i) => i.type === "text" && visible(i))
      .map((i) => ({ id: i.id, name: i.name }))
      .filter((x) => x.id || x.name);

    const pass = inputs
      .filter((i) => i.type === "password" && visible(i))
      .map((i) => ({ id: i.id, name: i.name }))
      .filter((x) => x.id || x.name);

    const submit = inputs
      .filter((i) => (i.type === "submit" || i.type === "button") && visible(i))
      .map((i) => ({ id: i.id, name: i.name, value: i.value }))
      .filter((x) => x.id || x.name);

    return { user, pass, submit };
  });

  const pick = (arr, hint) => {
    const h = hint.toLowerCase();
    return (
      arr.find((x) => (x.id || "").toLowerCase().includes(h) || (x.name || "").toLowerCase().includes(h)) ||
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
  if (field.id) return `#${CSS.escape(field.id)}`;
  return `input[name="${field.name}"]`;
}

async function main() {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(60000);

  await page.setUserAgent(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
  );

  // 1) Login page
  await page.goto(QS_LOGIN_URL, { waitUntil: "networkidle2" });

  // 2) Identify login fields
  const { user, pass, submit } = await findLoginFields(page);
  const userSel = selectorFor(user);
  const passSel = selectorFor(pass);
  const submitSel = selectorFor(submit);

  if (!userSel || !passSel || !submitSel) {
    console.error("Could not identify login inputs automatically. Paste the login form HTML snippet to hardcode selectors.");
    await browser.close();
    process.exit(2);
  }

  await page.focus(userSel);
  await page.keyboard.type(QS_USERNAME, { delay: 10 });
  await page.focus(passSel);
  await page.keyboard.type(QS_PASSWORD, { delay: 10 });

  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2" }).catch(() => null),
    page.click(submitSel),
  ]);

  // 3) Build schedule URL for today's date
  const scheduleUrl = buildScheduleUrl(TECH_NAME, TIMEZONE);
  await page.goto(scheduleUrl, { waitUntil: "networkidle2" });

  // 4) Scrape rows from GridView
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
    console.error("No schedule rows found. Login may have failed or the table ID changed.");
    await browser.close();
    process.exit(3);
  }

  // 5) Filter to current week (Mon-Sun)
  const now = DateTime.now().setZone(TIMEZONE);
  const weekStart = mondayStart(now);
  const weekEnd = weekStart.plus({ days: 7 }); // exclusive

  const weekRows = rows
    .map((r) => {
      const dt = parseMdyDate(r.date, TIMEZONE);
      return dt ? { ...r, dt } : null;
    })
    .filter(Boolean)
    .filter((r) => r.dt >= weekStart && r.dt < weekEnd);

  // 6) Build all-day ICS
  const cal = ical({ name: "Work Schedule", timezone: TIMEZONE });

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

  fs.mkdirSync(path.dirname(OUT_ICS), { recursive: true });
  fs.writeFileSync(OUT_ICS, cal.toString(), "utf8");

  console.log(`Loaded ${rows.length} rows for the month view, wrote ${weekRows.length} all-day events for this week.`);
  console.log(`ICS: ${OUT_ICS}`);

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
