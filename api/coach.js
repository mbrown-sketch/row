// Training-coach chat. The browser POSTs { messages, context }; this
// function adds a coach system prompt, enriches with the last few full
// Hevy workouts (server-side — HEVY_API_KEY never leaves here), calls
// Claude, and splits any `coach-proposal` block out of the reply so the
// UI can show it as a review-before-apply diff.
//
// Needs ANTHROPIC_API_KEY in Vercel → Settings → Environment Variables.
// Optional: HEVY_API_KEY (same one the gym page already uses) for richer
// "how did my last session go" context.

import { PROGRAM } from './_program.js';

const MODEL = 'claude-sonnet-5';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'server not configured (missing ANTHROPIC_API_KEY)' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const msgs = Array.isArray(body && body.messages) ? body.messages.slice(-20) : [];
  const context = (body && body.context) || {};
  if (!msgs.length) return res.status(400).json({ error: 'messages required' });

  // Enrich with the last few full Hevy workouts (sets, RPE, the user's notes).
  let hevyRecent = null;
  if (process.env.HEVY_API_KEY) {
    try {
      const hr = await fetch('https://api.hevyapp.com/v1/workouts?page=1&pageSize=3', {
        headers: { 'api-key': process.env.HEVY_API_KEY, 'Accept': 'application/json' },
      });
      if (hr.ok) {
        const hj = await hr.json();
        hevyRecent = (hj.workouts || []).map((w) => ({
          title: w.title,
          start: w.start_time,
          exercises: (w.exercises || []).map((ex) => ({
            name: ex.title,
            notes: ex.notes || undefined,
            sets: (ex.sets || [])
              .filter((s) => s && s.type !== 'warmup')
              .map((s) => ({ kg: s.weight_kg, reps: s.reps, rpe: s.rpe })),
          })),
        }));
      }
    } catch (e) { /* optional */ }
  }

  const unitWord = context.units === 'lb' ? 'pounds (lb)' : 'kilograms (kg)';

  // Stable block — persona + the athlete's periodised master plan. Cached so
  // the plan isn't re-billed on every chat turn.
  const persona = [
    "You are the strength & conditioning coach for the athlete whose periodised MASTER PLAN follows.",
    "They are peaking for the World Aquatics Masters Championships 50m backstroke (Budapest, late June 2027). Give advice, session feedback, and program tweaks IN THE CONTEXT OF THAT PLAN: the current block and its intensities, the taper, the swimming-specific priorities (start power, the 15m underwater, dolphin-kick drivers) and the injury constraints (patellar tendinopathy, ankle mobility).",
    "The dashboard's per-exercise `computedNext` is a simple weekly autoregulation helper. When it and the master plan's block prescription disagree, the master plan wins — say so.",
    "Be concise and specific. Cite actual numbers from the data. A few sharp points, not generic filler.",
    "All weights are in " + unitWord + " — always answer in that unit.",
    "",
    "When (and only when) the user wants the dashboard's exercise tracker changed, or a change is clearly warranted, append EXACTLY ONE fenced block as the last thing in your message:",
    "```coach-proposal",
    '{ "summary": "<one short line>", "changes": [ <change objects> ] }',
    "```",
    "Change objects (use exact exercise names from APP STATE):",
    '  {"op":"set_target","exercise":"<name>","weight":<number>,"reps":<int>,"note":"<short why>"}',
    '  {"op":"set_reps","exercise":"<name>","repMin":<int>,"repMax":<int>}',
    '  {"op":"set_step","exercise":"<name>","step":<number>}',
    '  {"op":"add_exercise","name":"<name>","day":"<split name>","repMin":<int>,"repMax":<int>,"step":<number>,"startWeight":<number>,"bodyweight":<true|false>}',
    '  {"op":"rename_exercise","exercise":"<name>","name":"<new name>"}',
    '  {"op":"remove_exercise","exercise":"<name>"}',
    "The user reviews and confirms every proposal before it takes effect — never say a change is done. For pure advice or session feedback, omit the block entirely.",
    "",
    "=== MASTER PLAN ===",
    PROGRAM,
  ].join("\n");

  // Volatile block — this request's dashboard state and recent Hevy detail.
  const perRequest = [
    "APP STATE — the dashboard's exercise tracker (JSON):",
    safeJson(context),
    hevyRecent && hevyRecent.length ? ("LAST HEVY WORKOUTS (JSON):\n" + safeJson(hevyRecent)) : "",
  ].join("\n");

  const anthReq = {
    model: MODEL,
    max_tokens: 1800,
    system: [
      { type: 'text', text: persona, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: perRequest },
    ],
    output_config: { effort: 'medium' },
    messages: msgs.map((m) => ({
      role: m && m.role === 'assistant' ? 'assistant' : 'user',
      content: String((m && m.content) || ''),
    })),
  };

  try {
    const ar = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(anthReq),
    });
    const text = await ar.text();
    if (!ar.ok) return res.status(502).json({ error: 'Claude API ' + ar.status + ': ' + text.slice(0, 600) });
    const data = JSON.parse(text);
    const raw = (data.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    let reply = raw;
    let proposal = null;
    const m = raw.match(/```coach-proposal\s*([\s\S]*?)```/);
    if (m) {
      reply = raw.slice(0, m.index).trim();
      try {
        const p = JSON.parse(m[1].trim());
        if (p && Array.isArray(p.changes) && p.changes.length) proposal = p;
      } catch (e) { /* malformed block → ignore, keep prose */ }
    }

    return res.status(200).json({
      reply: reply || raw,
      raw,
      proposal,
      usage: data.usage
        ? {
            input_tokens: data.usage.input_tokens,
            output_tokens: data.usage.output_tokens,
            cache_read_input_tokens: data.usage.cache_read_input_tokens || 0,
            cache_creation_input_tokens: data.usage.cache_creation_input_tokens || 0,
          }
        : null,
    });
  } catch (e) {
    return res.status(500).json({ error: 'coach failed: ' + (e.message || String(e)) });
  }
}

function safeJson(v) {
  try { return JSON.stringify(v); } catch (e) { return '{}'; }
}
