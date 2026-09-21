/**
 * routes/chat.js — POST /api/chat
 *
 * The API key never leaves this server. The browser posts the conversation,
 * the server runs the tool loop against real SPTIS data and streams the
 * answer back as Server-Sent Events:
 *
 *   event: token     { text }          text as it is written
 *   event: journeys  { journeys: [] }  full route objects for the cards
 *   event: done      { }
 *   event: error     { message }
 */
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { TOOL_SCHEMAS, runTool } = require('../services/chatTools');

const router = express.Router();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = process.env.CHAT_MODEL || 'claude-haiku-4-5-20251001';
const MAX_TURNS = 6;

const LANGUAGE_NAME = { en: 'English', te: 'Telugu', hi: 'Hindi' };

const systemPrompt = (lang) => `You are the SPTIS assistant for Hyderabad public transport, inside a journey planner website.

WHAT YOU KNOW
You only know what the tools return. Bus positions and crowding come from the live SPTIS fleet feed. Metro timetables and fares come from the official HMRL GTFS feed published by Open Data Telangana.

RULES
- Never invent a bus number, a departure time, a fare or a station. If a tool has not given it to you, say you do not have it.
- For any "how do I get from X to Y" question, call plan_journey before answering.
- If a place name is not found, call find_places and offer the closest matches instead of guessing.
- Bus running times in this system are simulated for the demo. If someone asks how accurate the bus times are, say so plainly. Metro times are the real published timetable.
- Metro crowding is an estimate from the time of day, not a live measurement. Bus crowding is live.

STYLE
- Reply in ${LANGUAGE_NAME[lang] || 'English'}. If the user writes in another language, follow the user.
- Short and practical. Two or three sentences, then the key numbers.
- The website draws the route cards, so do not repeat every step of a journey you just planned. Give the headline (how long, how much, which lines) and anything worth knowing, such as a long walk or a crowded bus.
- Rupees as ₹. Times as 24-hour clock.`;

// --------------------------------------------------- tiny rate limiter
const hits = new Map();
function rateLimited(ip, perMinute = 20) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60000);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > perMinute;
}

router.post('/chat', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip;
  if (rateLimited(ip)) {
    return res.status(429).json({ error: 'Too many messages. Wait a minute and try again.' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not set on the server.' });
  }

  const { messages = [], lang = 'en' } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: 'messages is required' });
  }

  // keep the prompt small and the cost predictable
  const history = messages.slice(-12).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: typeof m.content === 'string' ? m.content.slice(0, 2000) : m.content
  }));

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const collect = { journeys: [] };
  const convo = [...history];

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const stream = client.messages.stream({
        model: MODEL,
        max_tokens: 1024,
        system: systemPrompt(lang),
        tools: TOOL_SCHEMAS,
        messages: convo
      });

      stream.on('text', (text) => send('token', { text }));

      const message = await stream.finalMessage();
      convo.push({ role: 'assistant', content: message.content });

      const toolUses = message.content.filter((c) => c.type === 'tool_use');
      if (!toolUses.length) break;

      send('thinking', { tools: toolUses.map((t) => t.name) });

      const results = [];
      for (const use of toolUses) {
        const out = await runTool(use.name, use.input, collect);
        results.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(out) });
      }
      convo.push({ role: 'user', content: results });
    }

    if (collect.journeys.length) send('journeys', { journeys: collect.journeys.slice(0, 3) });
    send('done', {});
  } catch (err) {
    console.error('chat failed:', err);
    send('error', { message: 'The assistant is unavailable right now. Please try again.' });
  } finally {
    res.end();
  }
});

module.exports = router;
