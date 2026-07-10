/**
 * Storefront AI — Free Instant Scan (Netlify Function)
 * ----------------------------------------------------
 * Runs ONE real AI query server-side and reports whether the business
 * is named when someone asks AI for the best [trade] in [city], plus
 * who AI names instead. This is the free/freemium tier — deliberately
 * shallow. The paid Report Card runs the full multi-question scan.
 *
 * Endpoint (via netlify.toml redirect):  POST /api/scan
 * Body: { "business": "...", "trade": "...", "city": "Ladner, BC" }
 *
 * SECURITY / COST CONTROLS:
 *  - API key read from process.env.ANTHROPIC_API_KEY (never sent to browser)
 *  - Per-IP + global daily caps via Netlify Blobs (graceful if unavailable)
 *  - ALSO set a hard monthly spend limit in the Anthropic Console — that's
 *    your real safety net against a surprise bill. See kit/freemium-setup.md
 */

'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.SCAN_MODEL || 'claude-sonnet-4-6';
const GLOBAL_DAILY_CAP = parseInt(process.env.GLOBAL_DAILY_CAP || '120', 10); // scans/day site-wide
const IP_DAILY_CAP = parseInt(process.env.IP_DAILY_CAP || '4', 10);          // scans/day per visitor

const json = (statusCode, obj) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(obj),
});

const clean = (s, max = 80) => String(s || '').replace(/[<>{}]/g, '').trim().slice(0, max);

// ---- daily counters (best-effort; never blocks the scan if Blobs is off) ----
async function checkAndBump(event) {
  try {
    const { connectLambda, getStore } = require('@netlify/blobs');
    connectLambda(event);
    const store = getStore('scan-limits');
    const day = new Date().toISOString().slice(0, 10);
    const ip = (event.headers['x-nf-client-connection-ip'] ||
                event.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();

    const gKey = `global:${day}`;
    const iKey = `ip:${day}:${ip}`;
    const g = parseInt((await store.get(gKey)) || '0', 10);
    const i = parseInt((await store.get(iKey)) || '0', 10);

    if (g >= GLOBAL_DAILY_CAP) return { ok: false, reason: 'busy' };
    if (i >= IP_DAILY_CAP) return { ok: false, reason: 'ip' };

    await store.set(gKey, String(g + 1));
    await store.set(iKey, String(i + 1));
    return { ok: true };
  } catch (e) {
    console.warn('Blobs limiter unavailable, proceeding without cap:', e.message);
    return { ok: true, capless: true };
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Use POST.' });
  if (!process.env.ANTHROPIC_API_KEY) return json(500, { error: 'Server not configured.' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad request.' }); }

  const business = clean(body.business);
  const trade = clean(body.trade, 50);
  const city = clean(body.city || 'Ladner, BC', 60);
  if (!business || !trade) return json(400, { error: 'Tell me your business name and what you do.' });

  const gate = await checkAndBump(event);
  if (!gate.ok) {
    return json(429, gate.reason === 'ip'
      ? { error: "You've used your free scans for today. Book a full Report Card to go deeper." }
      : { error: "We're at today's free-scan limit. Try again tomorrow, or book a full Report Card." });
  }

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const prompt =
    `A customer asks: "best ${trade} in ${city}". Use web search to find the businesses an AI ` +
    `assistant would actually recommend right now. Then decide whether "${business}" is among them.\n\n` +
    `Reply with ONLY a JSON object, no prose, no code fences:\n` +
    `{"recommended":["Business One","Business Two","Business Three"],` +
    `"includes_target":true|false,"target_rank":number-or-null}\n` +
    `"recommended" = up to 4 real business names in the order AI would list them. ` +
    `"includes_target" = whether "${business}" is clearly among them. ` +
    `"target_rank" = its position (1-based) or null.`;

  let resp;
  try {
    resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
      tools: [{
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 2,
        user_location: { type: 'approximate', city: city.split(',')[0], region: 'British Columbia', country: 'CA', timezone: 'America/Vancouver' },
      }],
    });
  } catch (e) {
    console.error('Anthropic error:', e.message);
    return json(502, { error: 'The scan service is busy right now. Please try again in a moment.' });
  }

  // Collect final text and parse the JSON object out of it.
  let text = '';
  for (const block of resp.content || []) if (block.type === 'text') text += block.text;
  const match = text.match(/\{[\s\S]*\}/);
  let parsed = null;
  if (match) { try { parsed = JSON.parse(match[0]); } catch { /* fall through */ } }

  if (!parsed || !Array.isArray(parsed.recommended)) {
    return json(200, {
      business, trade, city,
      named: false, competitors: [], position: null,
      note: 'partial', // frontend will show a soft fallback
    });
  }

  const competitors = parsed.recommended
    .map((n) => clean(n, 60))
    .filter((n) => n && n.toLowerCase() !== business.toLowerCase())
    .slice(0, 3);

  return json(200, {
    business, trade, city,
    named: !!parsed.includes_target,
    position: parsed.includes_target ? (parsed.target_rank || null) : null,
    competitors,
    capless: !!gate.capless,
  });
};
