SJ's Disc Jockey Scheduler V3 — iCloud Calendar Fix + Diagnostics

This version:
- Uses a full iCalendar parser (ical.js), including TZID-aware events.
- Unfolds/handles Apple calendar event data more robustly.
- Shows a temporary diagnostic line under time slots:
  "Calendar check: X busy event(s) found across Y calendar(s)."
- Still DOES NOT create appointments or Zoom meetings. This is a safe availability test build.

Deploy to the existing sjscheduler Netlify project exactly like V2.
Then test the same iCloud event. If X is 1 or more, the occupied time should be removed.
v4 public deploy
