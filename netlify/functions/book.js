const { createDAVClient } = require("tsdav");
const crypto = require("crypto");

const TZ = "America/Los_Angeles";
const BUFFER_MIN = 15;

function reply(statusCode, body) {
  return {
    statusCode,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify(body)
  };
}

function escICS(v="") {
  return String(v)
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function utcICS(d) {
  const pad=n=>String(n).padStart(2,"0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function parseICSDate(v) {
  if (!v) return null;
  v = v.trim();
  let q;
  if ((q=v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/))) {
    return new Date(Date.UTC(+q[1],+q[2]-1,+q[3],+q[4],+q[5],+q[6]));
  }
  return null;
}

function busyFromICS(data) {
  const norm = String(data||"").replace(/\r\n[ \t]/g,"");
  const status=(norm.match(/^STATUS:(.+)$/m)?.[1]||"").trim().toUpperCase();
  const transp=(norm.match(/^TRANSP:(.+)$/m)?.[1]||"").trim().toUpperCase();
  if(status==="CANCELLED" || transp==="TRANSPARENT") return [];
  const starts=[...norm.matchAll(/^DTSTART(?:;[^:]*)?:(.+)$/gm)].map(m=>parseICSDate(m[1]));
  const ends=[...norm.matchAll(/^DTEND(?:;[^:]*)?:(.+)$/gm)].map(m=>parseICSDate(m[1]));
  const out=[];
  for(let i=0;i<Math.min(starts.length,ends.length);i++) if(starts[i]&&ends[i]) out.push([starts[i],ends[i]]);
  return out;
}

exports.handler = async (event) => {
  try {
    if(event.httpMethod!=="POST") return reply(405,{error:"POST required."});

    const username=process.env.APPLE_ID;
    const password=process.env.APPLE_APP_PASSWORD;
    if(!username || !password) return reply(500,{error:"Apple calendar credentials are missing."});

    let body={};
    try { body=JSON.parse(event.body||"{}"); }
    catch { return reply(400,{error:"Invalid booking request."}); }

    const allowed = {
      phone:    {title:"Chat with Joe", duration:30, mode:"Phone Call"},
      hangout:  {title:"Zoom Hangout", duration:30, mode:"Zoom"},
      planning: {title:"Zoom Planning Session", duration:60, mode:"Zoom"}
    };
    const kind=allowed[body.appointmentType];
    if(!kind) return reply(400,{error:"Invalid appointment type."});

    const name=String(body.name||"").trim();
    const email=String(body.email||"").trim();
    const phone=String(body.phone||"").trim();
    const notes=String(body.notes||"").trim();
    const start=new Date(body.start);

    if(!name || !email || !phone || Number.isNaN(start.getTime()))
      return reply(400,{error:"Name, email, phone, and a valid appointment time are required."});

    const end=new Date(start.getTime()+kind.duration*60000);
    const now=new Date();
    if(start<=now) return reply(409,{error:"That time is no longer available."});

    // Safety check: only allow Mon-Thu, with Monday starting at noon, and never ending after 9 PM.
    const localParts = new Intl.DateTimeFormat("en-US",{
      timeZone:TZ, weekday:"short", hour:"2-digit", minute:"2-digit", hour12:false
    }).formatToParts(start);
    const mp=Object.fromEntries(localParts.filter(x=>x.type!=="literal").map(x=>[x.type,x.value]));
    const wd=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(mp.weekday);
    const startMinutes=(+mp.hour)*60+(+mp.minute);
    const endLocalParts=new Intl.DateTimeFormat("en-US",{
      timeZone:TZ,hour:"2-digit",minute:"2-digit",hour12:false
    }).formatToParts(end);
    const ep=Object.fromEntries(endLocalParts.filter(x=>x.type!=="literal").map(x=>[x.type,x.value]));
    const endMinutes=(+ep.hour)*60+(+ep.minute);
    const open=wd===1?12*60:9*60;
    if(wd<1 || wd>4 || startMinutes<open || endMinutes>21*60)
      return reply(409,{error:"That time is outside Joe’s booking hours."});

    const client=await createDAVClient({
      serverUrl:"https://caldav.icloud.com",
      credentials:{username,password},
      authMethod:"Basic",
      defaultAccountType:"caldav"
    });

    const calendars=await client.fetchCalendars();
    if(!calendars?.length) return reply(502,{error:"No iCloud calendars were found."});

    // Re-check every iCloud calendar for conflicts immediately before creating the booking.
    const queryStart=new Date(start.getTime()-BUFFER_MIN*60000);
    const queryEnd=new Date(end.getTime()+BUFFER_MIN*60000);
    let busy=[];
    for(const calendar of calendars){
      try{
        const objects=await client.fetchCalendarObjects({
          calendar,
          timeRange:{start:queryStart.toISOString(),end:queryEnd.toISOString()}
        });
        for(const obj of (objects||[])) busy.push(...busyFromICS(obj.data));
      }catch{}
    }
    const conflict=busy.some(([bs,be])=>{
      const b1=new Date(bs.getTime()-BUFFER_MIN*60000);
      const b2=new Date(be.getTime()+BUFFER_MIN*60000);
      return start<b2 && end>b1;
    });
    if(conflict) return reply(409,{error:"That time was just taken. Please choose another opening."});

    // Default to the first iCloud calendar named "Calendar".
    // If there are duplicate calendars, APPLE_TARGET_CALENDAR_NUMBER can be set to 2, 3, etc.
    const targetName=process.env.APPLE_TARGET_CALENDAR_NAME || "Calendar";
    const targetNumber=Math.max(1,Number(process.env.APPLE_TARGET_CALENDAR_NUMBER||1));
    const matches=calendars.filter(c=>(c.displayName||"")===targetName);
    const target=matches[targetNumber-1] || matches[0] || calendars[0];
    if(!target) return reply(502,{error:"Could not select an iCloud calendar for the booking."});

    const uid=crypto.randomUUID();
    const filename=`sjs-${uid}.ics`;
    const description=[
      `Appointment: ${kind.title}`,
      `Name: ${name}`,
      `Email: ${email}`,
      `Phone: ${phone}`,
      notes ? `Notes: ${notes}` : null,
      kind.mode==="Zoom" ? "Zoom link: pending (Zoom integration not connected yet)" : "Meeting type: phone call"
    ].filter(Boolean).join("\n");

    const ics=[
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//SJ's Disc Jockey//Scheduler//EN",
      "CALSCALE:GREGORIAN",
      "BEGIN:VEVENT",
      `UID:${uid}`,
      `DTSTAMP:${utcICS(new Date())}`,
      `DTSTART:${utcICS(start)}`,
      `DTEND:${utcICS(end)}`,
      `SUMMARY:${escICS(kind.title+" - "+name)}`,
      `DESCRIPTION:${escICS(description)}`,
      "STATUS:CONFIRMED",
      "TRANSP:OPAQUE",
      "END:VEVENT",
      "END:VCALENDAR",
      ""
    ].join("\r\n");

    if(typeof client.createCalendarObject!=="function")
      return reply(500,{error:"Calendar write support was not loaded."});

    const created=await client.createCalendarObject({
      calendar:target,
      filename,
      iCalString:ics
    });

    return reply(200,{
      ok:true,
      appointmentType:kind.title,
      start:start.toISOString(),
      end:end.toISOString(),
      calendarName:target.displayName||"Calendar"
    });
  } catch (e) {
    console.error(e);
    return reply(502,{error:"Could not create the iCloud appointment. "+(e.message||String(e))});
  }
};
