// Which Split tabs fit in the header row, and which go into the More menu. Pure: the header measures, this decides.

/**
 * How many tabs fit in `room` pixels, in order, given each tab's width and the gap between them. When they don't all
 * fit, the More button (`more` wide, after a gap) needs room too.
 */
export function tabsThatFit(widths: ReadonlyArray<number>, room: number, more: number, gap: number): number {
  const total = widths.reduce((sum, w, i) => sum + w + (i ? gap : 0), 0);
  if (total <= room) {
    return widths.length;
  }
  let used = more;
  let n = 0;
  for (const w of widths) {
    if (used + gap + w > room) {
      break;
    }
    used += gap + w;
    n++;
  }
  return n;
}

/**
 * The tabs to show and the ones for More. The open Split always shows: when it would be in More, it takes the last
 * place that fits, so the row still says where you are.
 */
export function splitTabs<T extends { id: string }>(splits: ReadonlyArray<T>, fit: number, openId: string) {
  const shown = splits.slice(0, Math.max(1, fit));
  const open = splits.find((s) => s.id === openId);
  if (open && !shown.includes(open)) {
    shown.splice(shown.length - 1, 1, open);
  }
  return { shown, more: splits.filter((s) => !shown.includes(s)) };
}
