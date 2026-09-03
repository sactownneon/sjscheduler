
const { createDAVClient } = require("tsdav");
const ICAL = require("ical.js");

const TZ = "America/Los_Angeles";
const BUFFER_MIN = 15;

function json(status, body) {
  return {
    statusCode: status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    },
    body: JSON.stringify(body)
  };
}

function zonedParts(date, timeZone = TZ) {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date);

  return Object.fromEntries(
    p.filter(x => x.type !== "literal").map(x => [x.type, x.value])
  );
}

function zonedToUTC(dateStr, hh, mm, ss = 0, timeZone = TZ) {
  const [y, m, d] = dateStr.split("-").map(Number);
  let guess = new Date(Date.UTC(y, m - 1, d, hh, mm, ss));

  for (let i = 0; i < 4; i++) {
    const p = zonedParts(guess, timeZone);
    const shown = Date.UTC(
      +p.year,
      +p.month - 1,
      +p.day,
      +p.hour,
      +p.minute,
      +p.second
    );
    const desired = Date.UTC(y, m - 1, d, hh, mm, ss);
    guess = new Date(guess.getTime() + (desired - shown));
  }

  return guess;
}

function icalTimeToDate(t) {
  if (!t) return null;

  if (t.isDate) {
    return zonedToUTC(
      `${String(t.year).padStart(4, "0")}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`,
      0,
      0,
      0,
      TZ
    );
  }

  if (t.zone && t.zone.tzid === "UTC") {
    return new Date(
      Date.UTC(
        t.year,
        t.month - 1,
        t.day,
        t.hour,
        t.minute,
        t.second || 0
      )
    );
  }

  const tzid =
    t.zone && t.zone.tzid && t.zone.tzid !== "floating"
      ? t.zone.tzid
      : TZ;

  let useTz = tzid;

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: useTz }).format(new Date());
  } catch {
    useTz = TZ;
  }

  return zonedToUTC(
    `${String(t.year).padStart(4, "0")}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`,
    t.hour || 0,
    t.minute || 0,
    t.second || 0,
    useTz
  );
}

function extractBusy(data, rangeStart, rangeEnd) {
  const out = [];

  try {
    const jcal = ICAL.parse(data);
    const comp = new ICAL.Component(jcal);
    const vevents = comp.getAllSubcomponents("vevent");

    for (const ve of vevents) {
      const status = (ve.getFirstPropertyValue("status") || "")
        .toString()
        .toUpperCase();

      const transp = (ve.getFirstPropertyValue("transp") || "")
        .toString()
        .toUpperCase();

      if (status === "CANCELLED" || transp === "TRANSPARENT") continue;

      const ev = new ICAL.Event(ve);
      const s = icalTimeToDate(ev.startDate);
      const e = icalTimeToDate(ev.endDate);

      if (s && e && s < rangeEnd && e > rangeStart) {
        out.push([s, e]);
      }
    }
  } catch (err) {
    const norm = data.replace(/\r\n[ \t]/g, "");
    const sm = norm.match(/^DTSTART(?:;[^:]*)?:(.+)$/m);
    const em = norm.match(/^DTEND(?:;[^:]*)?:(.+)$/m);

    const parse = v => {
      if (!v) return null;
      v = v.trim();

      if (/^\d{8}T\d{6}Z$/.test(v)) {
        const q = v.match(
          /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/
        );

        return new Date(
          Date.UTC(
            +q[1],
            +q[2] - 1,
            +q[3],
            +q[4],
            +q[5],
            +q[6]
          )
        );
      }

      if (/^\d{8}T\d{6}$/.test(v)) {
        const q = v.match(
          /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/
        );

        return zonedToUTC(
          `${q[1]}-${q[2]}-${q[3]}`,
          +q[4],
          +q[5],
          +q[6],
          TZ
        );
      }

      return null;
    };

    const s = parse(sm?.[1]);
    const e = parse(em?.[1]);

    if (s && e && s < rangeEnd && e > rangeStart) {
      out.push([s, e]);
    }
  }

  return out;
}

exports.handler = async event => {
  try {
    const username = process.env.APPLE_ID;
    const password = process.env.APPLE_APP_PASSWORD;

    if (!username || !password) {
      return json(500, {
        error: "APPLE_ID or APPLE_APP_PASSWORD is missing."
      });
    }

    const date = event.queryStringParameters?.date;
    const duration = Number(
      event.queryStringParameters?.duration || 30
    );

    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date || "") ||
      ![30, 60].includes(duration)
    ) {
      return json(400, {
        error: "Invalid date or duration."
      });
    }

    const noon = zonedToUTC(date, 12, 0);

    const wd = [
      "Sun",
      "Mon",
      "Tue",
      "Wed",
      "Thu",
      "Fri",
      "Sat"
    ].indexOf(
      new Intl.DateTimeFormat("en-US", {
        timeZone: TZ,
        weekday: "short"
      }).format(noon)
    );

    if (wd === 0 || wd >= 5) {
      return json(200, {
        slots: [],
        busyCount: 0,
        calendarCount: 0
      });
    }

    const openHour = wd === 1 ? 12 : 9;
    const closeHour = 21;

    const rangeStart = zonedToUTC(date, openHour, 0);
    const rangeEnd = zonedToUTC(date, closeHour, 0);

    const client = await createDAVClient({
      serverUrl: "https://caldav.icloud.com",
      credentials: {
        username,
        password
      },
      authMethod: "Basic",
      defaultAccountType: "caldav"
    });

    const calendars = await client.fetchCalendars();

    if (!calendars?.length) {
      return json(502, {
        error: "Connected to iCloud, but no calendars were returned."
      });
    }

    let busy = [];
    let busyDebug = [];
    let objectCount = 0;
    let queriedCalendars = 0;

    const calendarNames = [];

    for (const calendar of calendars) {
      try {
        const objects = await client.fetchCalendarObjects({
          calendar,
          timeRange: {
            start: rangeStart.toISOString(),
            end: rangeEnd.toISOString()
          }
        });

        queriedCalendars++;

        calendarNames.push(
          calendar.displayName ||
            calendar.url?.split("/").filter(Boolean).pop() ||
            "Calendar"
        );

        objectCount += (objects || []).length;

        for (const obj of objects || []) {
          if (typeof obj.data === "string") {
            const found = extractBusy(
              obj.data,
              rangeStart,
              rangeEnd
            );

            busy.push(...found);

            for (const [s, e] of found) {
              busyDebug.push({
                calendar: calendar.displayName || "Calendar",
                startUTC: s.toISOString(),
                endUTC: e.toISOString(),
                startLocal: new Intl.DateTimeFormat("en-US", {
                  timeZone: TZ,
                  dateStyle: "short",
                  timeStyle: "short"
                }).format(s),
                endLocal: new Intl.DateTimeFormat("en-US", {
                  timeZone: TZ,
                  dateStyle: "short",
                  timeStyle: "short"
                }).format(e)
              });
            }
          }
        }
      } catch (err) {
        // Continue if one calendar cannot be queried.
      }
    }

    const now = new Date();
    const slots = [];

    for (
      let mins = openHour * 60;
      mins + duration <= closeHour * 60;
      mins += 30
    ) {
      const s = zonedToUTC(
        date,
        Math.floor(mins / 60),
        mins % 60
      );

      const e = new Date(
        s.getTime() + duration * 60000
      );

      if (s <= now) continue;

      const blocked = busy.some(([bs, be]) => {
        const bufferedStart = new Date(
          bs.getTime() - BUFFER_MIN * 60000
        );

        const bufferedEnd = new Date(
          be.getTime() + BUFFER_MIN * 60000
        );

        return s < bufferedEnd && e > bufferedStart;
      });

      if (!blocked) {
        slots.push({
          start: s.toISOString(),
          end: e.toISOString(),
          label: new Intl.DateTimeFormat("en-US", {
            timeZone: TZ,
            hour: "numeric",
            minute: "2-digit"
          }).format(s)
        });
      }
    }

    return json(200, {
      slots,
      busyCount: busy.length,
      calendarCount: calendars.length,
      queriedCalendars,
      objectCount,
      calendarNames,
      busyIntervals: busyDebug
    });
  } catch (e) {
    console.error(e);

    return json(502, {
      error:
        "Could not read the iCloud calendar. " +
        (e.message || String(e))
    });
  }
};
