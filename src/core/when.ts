// Times in plain words, for Snooze, Send Later and Reminders: "tomorrow 9", "in 2 hours", "monday",
// "tonight", "next week", "dec 3 8am", "14:30". Pure; the clock is passed in. Results are always in the future.

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
/** A day with no time given means the start of the working day. */
const MORNING = 8;

const dayIndex = (w: string) => DAYS.findIndex((d) => d.startsWith(w) && w.length >= 3);
const monthIndex = (w: string) => MONTHS.findIndex((m) => m.startsWith(w) && w.length >= 3);

/** "9", "9am", "9:30", "21:15", "8 pm", "noon", "midnight" → [hours, minutes]. */
function parseTime(s: string): [number, number] | null {
  s = s.trim();
  if (s === 'noon') {
    return [12, 0];
  }
  if (s === 'midnight') {
    return [0, 0];
  }
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?$/.exec(s);
  if (!m) {
    return null;
  }
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ap = m[3]?.[0];
  if (min > 59 || h > 23) {
    return null;
  }
  if (ap) {
    if (h < 1 || h > 12) {
      return null;
    }
    if (ap === 'p' && h !== 12) {
      h += 12;
    }
    if (ap === 'a' && h === 12) {
      h = 0;
    }
  } else if (!m[2] && h >= 1 && h <= 6) {
    // A bare small number is afternoon ("at 3" means 3 pm); 7–12 stay as said.
    h += 12;
  }
  return [h, min];
}

const at = (base: Date, h: number, m: number) => {
  const d = new Date(base);
  d.setHours(h, m, 0, 0);
  return d;
};
const addDays = (base: Date, n: number) => {
  const d = new Date(base);
  d.setDate(d.getDate() + n);
  return d;
};

/** Split "tomorrow at 9am" into the day part and the time part. */
function splitTime(s: string) {
  const m = /^(.*?)(?:\s+(?:at\s+)?)(\d{1,2}(?::\d{2})?\s*(?:am|pm|a|p)?|noon|midnight)$/.exec(s);
  const [, dayText = '', timeText = ''] = m ?? [];
  const words = m ? dayText.split(/\s+/) : [];
  const lastWord = words.at(-1) ?? '';
  // "dec 3 8am": the number before the time is a day of a month, so the split is fine.
  const dayOfMonth = /^\d{1,2}(st|nd|rd|th)?$/.test(lastWord) && monthIndex(words.at(-2) ?? '') >= 0;
  // "dec 3" is a date, not December at 3: a bare number after a month is the day.
  const dateNumber = !!m && /^\d{1,2}$/.test(timeText) && monthIndex(lastWord) >= 0 && !/\bat\s+\d/.test(s);
  if (m && !dateNumber && (!/^\d+$/.test(lastWord) || dayOfMonth)) {
    const time = parseTime(timeText);
    return { day: dayText.trim(), time, bad: !time };
  }
  return { day: s, time: null, bad: false };
}

/** When the text says, as a time after `now`; null when it can't be read or is in the past. */
export function parseWhen(text: string, now: Date): Date | null {
  const s = text.trim().toLowerCase().replaceAll(/\s+/g, ' ').replaceAll(/[.,]/g, '');
  if (!s) {
    return null;
  }
  const result = (d: Date | null) => (d && d.getTime() > now.getTime() ? d : null);

  // "in 20 minutes", "in 2h", "3 days", "a week"
  const rel = /^(?:in\s+)?(an?|\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?)$/.exec(s);
  if (rel) {
    const [, amount = '', unitText = ''] = rel;
    const n = amount.startsWith('a') ? 1 : Number(amount);
    const unit = unitText[0];
    const ms = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : unit === 'd' ? 86_400_000 : 7 * 86_400_000;
    return result(new Date(now.getTime() + n * ms));
  }

  // ISO dates: 2026-12-03 [time]
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(.*))?$/.exec(s);
  if (iso) {
    const time = iso[4] ? parseTime(iso[4].replace(/^at\s+/, '')) : [MORNING, 0];
    if (!time) {
      return null;
    }
    const d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), time[0], time[1]);
    return d.getMonth() === Number(iso[2]) - 1 ? result(d) : null;
  }

  const split = splitTime(s);
  if (split.bad) {
    return null;
  }
  // A time on its own ("14:30", "9am").
  const alone = !split.time ? parseTime(split.day) : null;
  const day = alone ? '' : split.day;
  const time = alone ?? split.time;

  // Only a time: today if it's still ahead, else tomorrow.
  if (!day || day === 'today' || day === 'at') {
    const t = time ?? (day === 'today' ? null : parseTime(s));
    if (!t) {
      return null;
    }
    const d = at(now, t[0], t[1]);
    return day === 'today' ? result(d) : d > now ? d : at(addDays(now, 1), t[0], t[1]);
  }

  const named = new Map<string, () => Date>([
    ['tomorrow', () => at(addDays(now, 1), ...(time ?? [MORNING, 0]))],
    ['tonight', () => at(now, ...(time ?? [20, 0]))],
    ['this evening', () => at(now, ...(time ?? [18, 0]))],
    ['this afternoon', () => at(now, ...(time ?? [14, 0]))],
    ['later today', () => new Date(now.getTime() + 3 * 3_600_000)],
    ['later', () => new Date(now.getTime() + 3 * 3_600_000)],
    ['next week', () => at(addDays(now, (8 - now.getDay()) % 7 || 7), ...(time ?? [MORNING, 0]))],
    ['weekend', () => at(addDays(now, (6 - now.getDay() + 7) % 7 || 7), ...(time ?? [9, 0]))],
    ['this weekend', () => at(addDays(now, (6 - now.getDay() + 7) % 7 || 7), ...(time ?? [9, 0]))],
    [
      'next month',
      () => {
        const d = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        return at(d, ...(time ?? [MORNING, 0]));
      },
    ],
  ]);
  const makeNamed = named.get(day);
  if (makeNamed) {
    return result(makeNamed());
  }

  // Weekdays: "monday", "next fri" → the next one after today.
  const wd = /^(?:next\s+|on\s+)?([a-z]+)$/.exec(day);
  const weekday = dayIndex(wd?.[1] ?? '');
  if (wd && weekday >= 0) {
    const ahead = (weekday - now.getDay() + 7) % 7 || 7;
    return result(at(addDays(now, ahead), ...(time ?? [MORNING, 0])));
  }

  // Dates: "dec 3", "3 dec", "december 3rd", "12/3" (month/day). This year, or next if already past.
  let month = -1;
  let date = 0;
  const md = /^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?$/.exec(day) ?? null;
  const dm = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)$/.exec(day) ?? null;
  const slash = /^(\d{1,2})\/(\d{1,2})$/.exec(day) ?? null;
  if (md && monthIndex(md[1] ?? '') >= 0) {
    [month, date] = [monthIndex(md[1] ?? ''), Number(md[2])];
  } else if (dm && monthIndex(dm[2] ?? '') >= 0) {
    [month, date] = [monthIndex(dm[2] ?? ''), Number(dm[1])];
  } else if (slash) {
    [month, date] = [Number(slash[1]) - 1, Number(slash[2])];
  }
  if (month >= 0 && month < 12 && date >= 1) {
    const t = time ?? [MORNING, 0];
    let d = new Date(now.getFullYear(), month, date, t[0], t[1]);
    if (d.getMonth() !== month) {
      return null;
    }
    if (d <= now) {
      d = new Date(now.getFullYear() + 1, month, date, t[0], t[1]);
    }
    return d;
  }
  return null;
}

/** The usual choices, for the picker before anything is typed. */
export function suggestions(now: Date): Array<{ label: string; at: Date }> {
  const out: Array<{ label: string; at: Date }> = [];
  const add = (label: string, text: string) => {
    const d = parseWhen(text, now);
    if (d && !out.some((o) => o.at.getTime() === d.getTime())) {
      out.push({ label, at: d });
    }
  };
  if (now.getHours() < 17) {
    add('Later today', 'later today');
  }
  if (now.getHours() < 19) {
    add('This evening', 'tonight');
  }
  add('Tomorrow', 'tomorrow');
  if (now.getDay() >= 1 && now.getDay() <= 4) {
    add('This weekend', 'this weekend');
  }
  add('Next week', 'next week');
  return out;
}

/** "Tomorrow, 8:00 AM", "Fri, Dec 4, 9:00 AM" — how a chosen time reads back. */
export function describeWhen(d: Date, now: Date): string {
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const days = Math.round((at(d, 0, 0).getTime() - at(now, 0, 0).getTime()) / 86_400_000);
  if (days === 0) {
    return `Today, ${time}`;
  }
  if (days === 1) {
    return `Tomorrow, ${time}`;
  }
  const opts: Intl.DateTimeFormatOptions = days < 7 ? { weekday: 'long' } : { weekday: 'short', month: 'short', day: 'numeric' };
  if (days >= 7 && d.getFullYear() !== now.getFullYear()) {
    opts.year = 'numeric';
  }
  return `${d.toLocaleDateString(undefined, opts)}, ${time}`;
}
