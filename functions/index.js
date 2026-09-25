/**
 * Balderlaugh Cloud Functions (deployed to the cottagerestocklist project).
 *
 *   - generateItem:   live round content (web-search grounded). The real
 *                     answer is written to balderlaugh_round_answers and only
 *                     the term goes back to the browser.
 *   - generateBluff:  Include Claude's own bluff.
 *   - checkAnswers:   "does this item's real answer still exist?" — yes/no
 *                     only, so a round never opens on a missing answer.
 *   - startReading:   moves a round from writing to reading AND attaches the
 *                     real answer in the same step. This is the only way an
 *                     answer ever reaches a browser, so the answer
 *                     collections can be fully locked (no client reads).
 *   - judgeCloseCalls (CCC) / judgeFunniest (CSF).
 *
 * Answer lengths (real answer and Claude's bluff) come from a shuffled
 * 3-card "deck" per game, rebuilt every 3 rounds from how long the table's
 * own bluffs have been (see LENGTH DECKS below). Decks live in
 * balderlaugh_length_state, which clients can't read.
 *
 * Deploy:  firebase deploy --only functions
 * API key: stored as the ANTHROPIC_API_KEY secret (already set).
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

initializeApp();
const db = getFirestore();

const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

const CATEGORY_BRIEF = {
  oddWords: `a genuinely real, obscure English dictionary word (not invented, not a proper noun) along with its real dictionary definition`,
  obscurePeople: `a real, historically documented but little-known person, along with an accurate account of what they're known for`,
  movies: `a real, obscure (but actually released) movie — title plus year — along with an accurate plot summary`
};

// ---- LENGTH DECKS -------------------------------------------------------------
// Left alone, Claude writes everything at about the same length, which
// players learn to spot. Instead each game deals a 3-card deck of word-count
// targets — one short, one middle, one long, shuffled — separately for the
// real answer and for Claude's bluff. When a deck runs out (every 3 rounds)
// it's re-dealt from the room: the last few rounds of HUMAN bluff lengths
// (the client records these in the game doc as `bluffLengths`) are split
// into short/middle/long thirds and one target is drawn from each, so the
// real answer ends up looking like just another player's entry.
// Before there's enough room data (<6 bluffs), the default spread is used;
// small samples are blended with it. Everything is clamped to 4-30 words
// (movies min 8, so a plot still makes sense).
const DEFAULT_BANDS = [[4, 9], [10, 18], [19, 30]];
const MIN_ROOM_SAMPLES = 6;
const ROOM_WINDOW = 24;      // most recent human bluffs considered
const MAX_WORDS = 30;

// Movies need a longer minimum, so their short/middle bands shift up to
// stay distinct: 8-11 / 12-19 / 20-30.
function bandsFor(category){
  const floor = category === "movies" ? 8 : 4;
  return floor === 4 ? DEFAULT_BANDS : [[floor, floor + 3], [floor + 4, 19], [20, MAX_WORDS]];
}
function randInt(lo, hi){ return lo + Math.floor(Math.random() * (hi - lo + 1)); }
function shuffle(arr){
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function wordCount(t){ return String(t || "").trim().split(/\s+/).filter(Boolean).length; }
function minWords(category){ return category === "movies" ? 8 : 4; }
// Below the minimum: land somewhere just above it (floor..floor+3) instead
// of piling every short card onto exactly the minimum, which would itself
// become a recognizable length.
function clampTarget(n, category){
  const floor = minWords(category);
  if (!Number.isFinite(n) || n < floor) return randInt(floor, floor + 3);
  return Math.min(MAX_WORDS, n);
}

function buildDeck(roomLengths, category){
  const floor = minWords(category);
  // Oddballs out: one-word jokes and runaway essays don't steer the deck.
  let L = (Array.isArray(roomLengths) ? roomLengths : [])
    .filter(n => Number.isFinite(n) && n >= 3 && n <= 60)
    .slice(-ROOM_WINDOW)
    .sort((x, y) => x - y);
  if (L.length >= 8) L = L.slice(1, -1); // drop the single shortest and longest
  const useRoom = L.length >= MIN_ROOM_SAMPLES;
  const w = useRoom ? L.length / (L.length + 4) : 0; // more data, more trust
  const cards = bandsFor(category).map(([lo, hi], i) => {
    const def = randInt(lo, hi);
    if (!useRoom) return def;
    const third = L.slice(Math.floor(i * L.length / 3), Math.max(Math.floor((i + 1) * L.length / 3), Math.floor(i * L.length / 3) + 1));
    const room = third[Math.floor(Math.random() * third.length)];
    return Math.round(w * room + (1 - w) * def);
  }).map(n => clampTarget(n, category));
  return shuffle(cards);
}

// kind: "real" | "bluff". Same round (e.g. a "Try again") reuses its target.
async function drawTarget(gameId, roundIndex, kind, category){
  const fallback = () => buildDeck([], category)[0];
  if (!gameId || roundIndex == null) return fallback();
  const roundKey = String(roundIndex).split("-")[0];
  try {
    const stateRef = db.collection("balderlaugh_length_state").doc(String(gameId));
    // Read the game outside the transaction so players' own writes to it
    // are never held up waiting on this.
    const g = await db.collection("balderlaugh_games").doc(String(gameId)).get();
    return await db.runTransaction(async tx => {
      const st = await tx.get(stateRef);
      const state = (st.exists && st.data()[kind]) || {};
      if (state.roundKey === roundKey && Number.isFinite(state.target)) return state.target;
      let deck = Array.isArray(state.deck) ? [...state.deck] : [];
      if (!deck.length) deck = buildDeck(g.exists ? g.data().bluffLengths : [], category);
      const target = clampTarget(deck.shift(), category);
      tx.set(stateRef, { [kind]: { deck, roundKey, target }, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      return target;
    });
  } catch (err) {
    console.error("drawTarget failed, using a default length:", err);
    return fallback();
  }
}

function lengthBand(target, category){
  const tol = Math.max(2, Math.round(target * 0.2));
  return { lo: Math.max(minWords(category), target - tol), hi: Math.min(MAX_WORDS, target + tol) };
}
function lengthInstruction(target, category){
  const { lo, hi } = lengthBand(target, category);
  const numbers = target < 12
    ? "No specific numbers or dates at all."
    : "Never state more than ONE specific number, date, or quantity in the whole thing (zero is fine).";
  return `LENGTH: between ${lo} and ${hi} words (aim for about ${target}). Count them. ${numbers} Never exceed ${MAX_WORDS} words.`;
}

async function callClaude(body){
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY.value(),
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  return { res, data };
}

// If the text missed its band badly, one cheap rewrite (no web search).
// `isReal` keeps the rewrite from inventing facts in the real answer.
async function fitLength(text, target, isReal, category){
  const { lo, hi } = lengthBand(target, category);
  const n = wordCount(text);
  // A little slack either side, but never below the category minimum.
  if (n >= Math.max(minWords(category), lo - 2) && n <= hi + 2) return text;
  const rule = isReal
    ? "Keep it TRUE: do not add any new facts, names, numbers or dates. To lengthen, only add general description of what is already there; to shorten, drop detail."
    : "Keep it the same joke and the same (false) content — don't make it more accurate.";
  try {
    const { res, data } = await callClaude({
      model: "claude-sonnet-5",
      max_tokens: 200,
      messages: [{ role: "user", content: `Rewrite this so it is between ${lo} and ${hi} words (about ${target}). ${rule} Keep the same casual tone.

"${text}"

Reply with ONLY a JSON object: {"text": "the rewritten version"}` }]
    });
    if (!res.ok) return text;
    const raw = (data.content || []).map(b => b.text || "").join("");
    const m = raw.match(/\{[\s\S]*\}/);
    const out = m ? JSON.parse(m[0]).text : null;
    if (!out) return text;
    // Only keep the rewrite if it actually landed closer.
    const dist = x => Math.abs(wordCount(x) - target);
    return dist(out) < dist(text) ? out : text;
  } catch (err) {
    console.error("fitLength rewrite failed, keeping original:", err);
    return text;
  }
}

// ---- Live item generation, grounded with web search ------------------------
exports.generateItem = onCall({ secrets: [ANTHROPIC_API_KEY] }, async (request) => {
  const { category, excludeTerms, gameId, roundIndex } = request.data;
  if (!category || !CATEGORY_BRIEF[category] || !gameId || roundIndex == null) {
    throw new Error("category, gameId, and roundIndex are all required.");
  }
  const avoid = Array.isArray(excludeTerms) && excludeTerms.length
    ? `\n\nAlready used this game, so pick something different: ${excludeTerms.join(", ")}.`
    : "";
  const target = await drawTarget(gameId, roundIndex, "real", category);

  const prompt = `You're generating content for a party game called Balderlaugh, a
Balderdash-style bluffing game. I need ${CATEGORY_BRIEF[category]}.

Use web search to verify the item and its answer are ACTUALLY real and
accurate before responding — this is important, the whole game depends on
the "real" answer being genuinely true, not something you recall
unverified from memory. Pick something obscure enough to not be
immediately obvious, but confirmable.${avoid}

For the "real" field: ${lengthInstruction(target, category)}

Once verified, respond with ONLY a JSON object (no other text):
{"term": "the word/person name/movie title", "real": "the real definition/bio/plot summary", "source": "brief note on where you verified this"}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY.value(),
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      // Web search queries, results, and any commentary all draw from this
      // same budget before the model gets to writing the final JSON — 1500
      // was too tight and was likely truncating the response mid-answer.
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
      tools: [{ type: "web_search_20250305", name: "web_search" }]
    })
  });
  const data = await res.json();
  if (!res.ok) {
    // The API itself rejected the request (bad model name, auth issue,
    // rate limit, etc.) — this is NOT the same as a parseable-but-wrong
    // response, and treating it as one was hiding the real error. Surface
    // it plainly.
    console.error("generateItem: Anthropic API returned an error — status:", res.status,
      "| body:", JSON.stringify(data).slice(0, 1500));
    throw new Error(`Anthropic API error (${res.status}): ${data?.error?.message || "unknown"}`);
  }
  // With web search enabled, the model often adds a sentence of commentary
  // before or after the JSON ("Based on my search, here's..."), and search
  // turns can produce multiple text blocks. Pull the JSON object out of the
  // LAST text block rather than requiring the whole response to be clean
  // JSON, which broke on any surrounding prose.
  const textBlocks = (data.content || []).filter(b => b.type === "text").map(b => b.text);
  const lastText = textBlocks.length ? textBlocks[textBlocks.length - 1] : "";
  const jsonMatch = lastText.match(/\{[\s\S]*\}/);
  let parsed;
  if (jsonMatch) {
    try { parsed = JSON.parse(jsonMatch[0]); } catch { /* falls through to the error below */ }
  }
  if (!parsed) {
    // Log what actually came back — without this, a parse failure is a
    // dead end in the logs with no way to tell truncation, a refusal, and
    // a genuine format miss apart.
    console.error("generateItem parse failure — stop_reason:", data.stop_reason,
      "| last text block:", lastText.slice(0, 500),
      "| full content:", JSON.stringify(data.content || []).slice(0, 1000));
    throw new Error("Could not parse a generated item from the model response.");
  }
  if (!parsed.term || !parsed.real) {
    throw new Error("Generated item was missing a term or real answer.");
  }
  parsed.real = await fitLength(parsed.real, target, true, category);

  // Store the real answer server-side, keyed to this exact game+round.
  // Clients can't read this collection at all — the answer only reaches a
  // browser through startReading.
  const answerId = `${gameId}_${roundIndex}`;
  await db.collection("balderlaugh_round_answers").doc(answerId).set({
    term: parsed.term,
    real: parsed.real,
    source: parsed.source || null,
    category,
    targetWords: target,
    createdAt: FieldValue.serverTimestamp()
  });

  // Only the term goes back to the caller — the real answer stays server-side.
  return { term: parsed.term, answerId };
});

// ---- Include Claude: write Claude's own bluff for the round ----------------
// Now sees the real answer server-side (never sent to any browser — same
// document a normal player never gets to see before reveal) so it can
// mechanically avoid reusing its specific words, rather than guessing at
// what might overlap. Testing showed the blind approach still produced
// accidental shared vocabulary ("yesterday" in both a real and fake
// definition of a word about yesterday) since Claude's own general
// knowledge of well-documented terms naturally converges with the truth.
exports.generateBluff = onCall({ secrets: [ANTHROPIC_API_KEY] }, async (request) => {
  const { term, category, answerSource, answerId, itemId, gameId, roundIndex } = request.data;
  if (!term || !category) {
    throw new Error("term and category are required.");
  }

  let realAnswer = null;
  try {
    if (answerSource === 'generated' && answerId) {
      const snap = await db.collection('balderlaugh_round_answers').doc(answerId).get();
      if (snap.exists) realAnswer = snap.data().real;
    } else if (answerSource === 'seed' && itemId) {
      const snap = await db.collection('balderlaugh_items').doc(itemId).get();
      if (snap.exists) realAnswer = snap.data().real;
    }
  } catch (err) {
    console.error('generateBluff: could not fetch real answer for overlap-avoidance, continuing blind:', err);
  }

  const target = await drawTarget(gameId, roundIndex, "bluff", category);
  const overlapRule = realAnswer
    ? `The REAL answer (for your reference only — never reveal or paraphrase it) is:
"${realAnswer}"

Your bluff must share ZERO of the same specific/content words as that real
answer — no matching nouns, adjectives, numbers, or proper nouns. Common
small words (a, the, of, who, is) don't count, and reusing the term "${term}"
itself is fine since every player already sees it. But if the real answer
says "Scottish," don't also say "Scottish" — invent a different origin
entirely. If it says "island," avoid "island" too. Go a genuinely different
direction, not a close variant.`
    : `If you happen to already know anything genuinely true about "${term}" —
nationality, era, actual profession, or any other real fact — do NOT
include it, even accurately. Invent a different version of every detail.`;

  const prompt = `You're playing Balderlaugh, a Balderdash-style bluffing party
game. The category is ${CATEGORY_BRIEF[category] || category}. The term is "${term}".

Write a funny, plausible-SOUNDING but FALSE definition/bio/plot-summary for
"${term}" — something that could genuinely trick other players into voting
for it as the real answer. Go for actually funny, not just false — surprising
and unexpected beats safe and generic.

Write it like a person improvising a guess on the spot would, not like an
encyclopedia entry — don't invent precise dates, exact durations, or named
mechanisms just to sound authoritative; those over-specific details are a
tell that this was AI-generated, not a real human bluff.

${overlapRule}

${lengthInstruction(target, category)}

Reply with ONLY a JSON object: {"bluff": "your fake definition here"}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY.value(),
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }]
    })
  });
  const data = await res.json();
  if (!res.ok) {
    console.error("generateBluff: Anthropic API returned an error — status:", res.status, "| body:", JSON.stringify(data).slice(0, 1000));
    throw new Error(`Anthropic API error (${res.status}): ${data?.error?.message || "unknown"}`);
  }
  const text = (data.content || []).map(b => b.text || "").join("");
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  let parsed;
  if (jsonMatch) {
    try { parsed = JSON.parse(jsonMatch[0]); } catch { /* falls through */ }
  }
  if (!parsed || !parsed.bluff) {
    console.error("generateBluff parse failure — raw text:", text.slice(0, 500));
    throw new Error("Could not parse a bluff from the model response.");
  }
  return { bluff: await fitLength(parsed.bluff, target, false, category) };
});

// ---- Answer lookup helpers (server-side only) -------------------------------
function answerRefFor(ref){
  if (!ref) return null;
  if (ref.answerSource === "generated" && ref.answerId) return db.collection("balderlaugh_round_answers").doc(String(ref.answerId));
  if (ref.answerSource === "seed" && ref.itemId) return db.collection("balderlaugh_items").doc(String(ref.itemId));
  return null;
}

// ---- checkAnswers: yes/no per item, never the text -------------------------
exports.checkAnswers = onCall(async (request) => {
  const refs = Array.isArray(request.data && request.data.refs) ? request.data.refs.slice(0, 10) : [];
  const exists = await Promise.all(refs.map(async r => {
    try {
      const ref = answerRefFor(r);
      if (!ref) return false;
      const snap = await ref.get();
      return snap.exists && !!snap.data().real;
    } catch { return false; }
  }));
  return { exists };
});

// ---- startReading: writing -> reading, with the answer attached -------------
// The client works out the shuffle order and next Reader as before and
// passes them in; the server checks the round really is ready to move on
// (everyone active has submitted, or the writing clock has run out), then
// writes the phase change and the real answer together in one transaction.
// Anyone with dev tools therefore never sees the answer before the whole
// table does — the only way to get it early is to force the round forward
// for everyone, which the table would notice.
const READING_MIN_S = 60, READING_MAX_S = 900, CLOCK_GRACE_MS = 3000;
exports.startReading = onCall(async (request) => {
  const { gameId, roundIndex, order, readerUid, readerQueue, readingSeconds } = request.data || {};
  if (!gameId || roundIndex == null || !Array.isArray(order)) {
    throw new HttpsError("invalid-argument", "gameId, roundIndex and order are required.");
  }
  const gameRef = db.collection("balderlaugh_games").doc(String(gameId));
  return db.runTransaction(async tx => {
    const snap = await tx.get(gameRef);
    if (!snap.exists) return { ok: false, reason: "no-game" };
    const g = snap.data();
    const r = g.round || {};
    if (r.index !== roundIndex || r.phase !== "writing") return { ok: false, reason: "already-moved" };

    const players = g.players || {};
    const subs = r.submissions || {};
    const active = Object.keys(players).filter(u => !players[u].sittingOut);
    const humanIn = Object.keys(subs).filter(u => active.includes(u)).length;
    const timeUp = typeof r.phaseEndsAt === "number" && Date.now() >= r.phaseEndsAt - CLOCK_GRACE_MS;
    if (!timeUp && !(active.length > 0 && humanIn >= active.length)) return { ok: false, reason: "not-ready" };

    const expected = [...Object.keys(subs), "REAL"];
    const valid = order.length === expected.length && new Set(order).size === order.length && order.every(id => expected.includes(id));
    const finalOrder = valid ? order : shuffle(expected);

    const aRef = answerRefFor(r);
    const aSnap = aRef ? await tx.get(aRef) : null;
    const answerText = aSnap && aSnap.exists && aSnap.data().real ? aSnap.data().real : "(answer unavailable)";

    const secs = Math.min(READING_MAX_S, Math.max(READING_MIN_S, Number(readingSeconds) || 480));
    const update = {
      "round.phase": "reading",
      "round.phaseEndsAt": Date.now() + secs * 1000,
      "round.shuffleOrder": finalOrder,
      "round.answerText": answerText,
      "round.readerUid": players[readerUid] ? readerUid : (active[0] || null)
    };
    if (Array.isArray(readerQueue) && readerQueue.every(u => typeof u === "string")) update.readerQueue = readerQueue;
    tx.update(gameRef, update);
    return { ok: true };
  });
});

// ---- CCC: mark any human bluff that's surprisingly close to the truth -----
// Bragging rights only, no scoring — Claude reads the real answer and every
// human bluff (never Claude's own, if Include Claude is on) and flags any
// that landed close to actually correct, purely by luck or half-knowledge.
exports.judgeCloseCalls = onCall({ secrets: [ANTHROPIC_API_KEY] }, async (request) => {
  const { term, realAnswer, submissions } = request.data; // submissions: [{id, text}]
  if (!term || !realAnswer || !Array.isArray(submissions) || submissions.length === 0) {
    return { closeIds: [] };
  }

  const list = submissions.map((s, i) => `${i + 1}. ${s.text}`).join("\n");
  const prompt = `You're judging a party game. The real definition/description of
"${term}" is:
"${realAnswer}"

These are bluffs players wrote, not knowing the real answer:
${list}

Some bluffs might coincidentally land close to the actual truth, even
though the player was just guessing. Identify any that are genuinely
close in substance to the real answer (not just similar-sounding) — this
is meant to be rare, a nice "wow, you were almost right" moment, not
generous. Most rounds should have zero.

Reply with ONLY a JSON object: {"closeIndexes": [<1-based numbers from
the list above, or an empty array if none qualify>]}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY.value(),
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }]
    })
  });
  const data = await res.json();
  if (!res.ok) {
    console.error("judgeCloseCalls: Anthropic API returned an error — status:", res.status, "| body:", JSON.stringify(data).slice(0, 1000));
    return { closeIds: [] };
  }
  const text = (data.content || []).map(b => b.text || "").join("");
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  try {
    if (!jsonMatch) throw new Error("no JSON in response");
    const parsed = JSON.parse(jsonMatch[0]);
    const indexes = Array.isArray(parsed.closeIndexes) ? parsed.closeIndexes : [];
    const closeIds = indexes.map(n => submissions[n - 1]).filter(Boolean).map(s => s.id);
    return { closeIds };
  } catch {
    // Fail closed — no badge, not a broken one.
    return { closeIds: [] };
  }
});

// ---- CSF: pick the funniest human-written bluff ----------------------------
exports.judgeFunniest = onCall({ secrets: [ANTHROPIC_API_KEY] }, async (request) => {
  const { term, submissions } = request.data; // submissions: [{id, text}]
  if (!term || !Array.isArray(submissions) || submissions.length === 0) {
    throw new Error("term and a non-empty submissions array are required.");
  }

  const list = submissions.map((s, i) => `${i + 1}. ${s.text}`).join("\n");
  const prompt = `These are fake dictionary-style bluffs for the party game
Balderlaugh, all written for the term "${term}":

${list}

Pick the funniest one. If any entry crosses into content you shouldn't
engage with (explicit sexual content, hate speech/slurs, or anything
sexualizing minors), exclude it from consideration entirely — do not
describe why, just leave it out. From what remains, reply with ONLY a JSON
object: {"funniestIndex": <1-based number from the list above>, "reason":
"one short sentence"}. If every entry must be excluded, reply
{"funniestIndex": null, "reason": "none eligible"}.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY.value(),
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }]
    })
  });
  const data = await res.json();
  if (!res.ok) {
    console.error("judgeFunniest: Anthropic API returned an error — status:", res.status, "| body:", JSON.stringify(data).slice(0, 1000));
    return { winnerId: null, reason: "Judge call failed." };
  }
  const text = (data.content || []).map(b => b.text || "").join("");
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  try {
    if (!jsonMatch) throw new Error("no JSON in response");
    const parsed = JSON.parse(jsonMatch[0]);
    if (parsed.funniestIndex == null) return { winnerId: null, reason: parsed.reason };
    const winner = submissions[parsed.funniestIndex - 1];
    return { winnerId: winner ? winner.id : null, reason: parsed.reason };
  } catch {
    return { winnerId: null, reason: "Could not parse judge response." };
  }
});
