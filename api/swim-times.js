// Pulls best times from Swim England Rankings (swimmingresults.org —
// public, no login) for the Time log on swim.html. Fetches BOTH the
// open (non-Masters) and the Masters "individual best times" pages and
// returns 50/100 Back + 50 Free per course, tagged open|masters.
//
// Unofficial HTML scrape of a stable ~15-year-old server-rendered site.
// If the page layout changes, parsePage() needs updating.
//
//   GET /api/swim-times            → uses the default tiref below
//   GET /api/swim-times?tiref=1234 → overrides it

const DEFAULT_TIREF = '806857';

const EVENTS = {
  '50 Backstroke': '50 Back',
  '100 Backstroke': '100 Back',
  '50 Freestyle': '50 Free',
};

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

function parsePage(htmlText, category) {
  const out = [];
  const tableRe = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let tm;
  while ((tm = tableRe.exec(htmlText))) {
    const body = tm[1];
    const course = /LC\s*Time/i.test(body) ? 'LC' : /SC\s*Time/i.test(body) ? 'SC' : null;
    if (!course) continue;
    const rows = body.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
    for (const row of rows) {
      const cells = (row.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || [])
        .map((c) => stripTags(c));
      if (cells.length < 5) continue;
      const label = EVENTS[cells[0]];
      if (!label) continue;
      const time = cells[1];
      if (!/^\d{1,2}(:\d{2})?\.\d{2}$/.test(time)) continue;
      let di = -1;
      for (let i = 2; i < cells.length; i++) {
        if (/^\d{2}\/\d{2}\/\d{2}$/.test(cells[i])) { di = i; break; }
      }
      out.push({
        event: label,
        course,
        category,
        time,
        date: di >= 0 ? toISO(cells[di]) : null,
        meet: di >= 0 ? (cells[di + 1] || '') : '',
        venue: di >= 0 ? (cells[di + 2] || '') : '',
        level: cells[cells.length - 1] || '',
      });
    }
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const tiref = ((req.query && String(req.query.tiref || '')).replace(/\D/g, '')) || DEFAULT_TIREF;
  // Racing history only wants recent times — default: after 2024.
  const sinceYear = ((req.query && String(req.query.since || '')).replace(/\D/g, '')) || '2025';
  const minDate = sinceYear + '-01-01';
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    'Accept': 'text/html',
  };
  const openURL = 'https://www.swimmingresults.org/individualbest/personal_best.php?mode=A&tiref=' + tiref + '&back=individualbest';
  const mastersURL = 'https://www.swimmingresults.org/mastersindividualbest/personal_best.php?mode=M&tiref=' + tiref;

  try {
    const [oRes, mRes] = await Promise.all([
      fetch(openURL, { headers }),
      fetch(mastersURL, { headers }),
    ]);
    let times = [];
    if (oRes.ok) times.push(...parsePage(await oRes.text(), 'open'));
    if (mRes.ok) times.push(...parsePage(await mRes.text(), 'masters'));
    times = times.filter((t) => t.date && t.date >= minDate);

    const evOrder = { '50 Back': 0, '100 Back': 1, '50 Free': 2 };
    times.sort((a, b) =>
      (evOrder[a.event] - evOrder[b.event]) ||
      a.course.localeCompare(b.course) ||
      (a.category === b.category ? 0 : a.category === 'masters' ? -1 : 1));

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json({ tiref, since: sinceYear, count: times.length, times });
  } catch (e) {
    return res.status(502).json({ error: 'swimmingresults.org fetch failed: ' + (e.message || String(e)) });
  }
}
