// Pulls times from Swim England Rankings (swimmingresults.org — public,
// no login) for the Time log on swim.html.
//
//   • Masters best times   — /mastersindividualbest/personal_best.php?mode=M
//   • Open best times       — /individualbest/personal_best.php?mode=A
//   • Open per-event swims  — /individualbest/personal_best_time_date.php
//                             (every race for an event/course, not just the PB)
//
// Returns 50/100 Back + 50 Free rows, each tagged open|masters, filtered
// to after 2024 by default (?since=YYYY to change).
//
// Unofficial HTML scrape of a stable ~15-year-old server-rendered site.
// If the page layout changes, the parsers below need updating.

const DEFAULT_TIREF = '806857';

// Best-times pages label events like "50 Backstroke"; progression pages
// are keyed by tstroke code in the URL.
const EVENTS = { '50 Backstroke': '50 Back', '100 Backstroke': '100 Back', '50 Freestyle': '50 Free' };
const TSTROKE = { '50 Back': 13, '100 Back': 14, '50 Free': 1 };

function stripTags(s) {
  return String(s)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;|&rsquo;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function toISO(ddmmyy) {
  const m = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(ddmmyy || '');
  return m ? '20' + m[3] + '-' + m[2] + '-' + m[1] : null;
}
const isTime = (t) => /^\d{1,2}(:\d{2})?\.\d{2}$/.test(t);
function rowCells(row) {
  return (row.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || []).map(stripTags);
}
function findDateIdx(cells, from) {
  for (let i = from; i < cells.length; i++) if (/^\d{2}\/\d{2}\/\d{2}$/.test(cells[i])) return i;
  return -1;
}

// Best-times page: two tables (LC then SC); row = Stroke | Time | Converted | [Pts] | Date | Meet | Venue | Licence | Level
function parseBest(htmlText, category) {
  const out = [];
  const tableRe = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let tm;
  while ((tm = tableRe.exec(htmlText))) {
    const body = tm[1];
    const course = /LC\s*Time/i.test(body) ? 'LC' : /SC\s*Time/i.test(body) ? 'SC' : null;
    if (!course) continue;
    for (const row of body.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || []) {
      const cells = rowCells(row);
      const label = EVENTS[cells[0]];
      if (!label || !isTime(cells[1])) continue;
      const di = findDateIdx(cells, 2);
      out.push({
        event: label, course, category,
        time: cells[1],
        date: di >= 0 ? toISO(cells[di]) : null,
        round: 'H',
        meet: di >= 0 ? (cells[di + 1] || '') : '',
        venue: di >= 0 ? (cells[di + 2] || '') : '',
        level: cells[cells.length - 1] || '',
      });
    }
  }
  return out;
}

// Progression page: one table, every swim; row = Time | WA Pts | Round | Date | Meet | Venue | Club | Level
function parseProgression(htmlText, event, course) {
  const out = [];
  for (const row of htmlText.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || []) {
    const cells = rowCells(row);
    if (cells.length < 5 || !isTime(cells[0])) continue;
    const di = findDateIdx(cells, 1);
    if (di < 0) continue;
    out.push({
      event, course, category: 'open',
      time: cells[0],
      date: toISO(cells[di]),
      round: cells[di - 1] || 'H',
      meet: cells[di + 1] || '',
      venue: cells[di + 2] || '',
      level: cells[cells.length - 1] || '',
    });
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const tiref = ((req.query && String(req.query.tiref || '')).replace(/\D/g, '')) || DEFAULT_TIREF;
  const sinceYear = ((req.query && String(req.query.since || '')).replace(/\D/g, '')) || '2025';
  const minDate = sinceYear + '-01-01';
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    'Accept': 'text/html',
  };
  const base = 'https://www.swimmingresults.org';
  const get = (url) => fetch(url, { headers }).then((r) => (r.ok ? r.text() : '')).catch(() => '');

  const jobs = [
    get(base + '/mastersindividualbest/personal_best.php?mode=M&tiref=' + tiref).then((h) => parseBest(h, 'masters')),
    get(base + '/individualbest/personal_best.php?mode=A&tiref=' + tiref + '&back=individualbest').then((h) => parseBest(h, 'open')),
  ];
  Object.keys(TSTROKE).forEach((ev) => {
    ['L', 'S'].forEach((tc) => {
      jobs.push(
        get(base + '/individualbest/personal_best_time_date.php?back=individualbest&tiref=' + tiref + '&mode=A&tstroke=' + TSTROKE[ev] + '&tcourse=' + tc)
          .then((h) => parseProgression(h, ev, tc === 'L' ? 'LC' : 'SC'))
      );
    });
  });

  try {
    const parsed = await Promise.all(jobs);
    let times = [].concat.apply([], parsed).filter((t) => t.date && t.date >= minDate);

    // dedupe on event + course + date + time + round
    const seen = new Set();
    times = times.filter((t) => {
      const k = t.event + '|' + t.course + '|' + t.date + '|' + t.time + '|' + (t.round || 'H');
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    const evOrder = { '50 Back': 0, '100 Back': 1, '50 Free': 2 };
    times.sort((a, b) =>
      (evOrder[a.event] - evOrder[b.event]) ||
      a.course.localeCompare(b.course) ||
      (b.date < a.date ? -1 : b.date > a.date ? 1 : 0) ||
      (parseFloat(a.time) - parseFloat(b.time)));

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json({
      tiref, since: sinceYear, count: times.length,
      byCategory: {
        open: times.filter((t) => t.category === 'open').length,
        masters: times.filter((t) => t.category === 'masters').length,
      },
      times,
    });
  } catch (e) {
    return res.status(502).json({ error: 'swimmingresults.org fetch failed: ' + (e.message || String(e)) });
  }
}
