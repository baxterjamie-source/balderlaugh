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
// it's re-dealt from the room: the recent HUMAN bluff lengths (the client
// records these in the game doc as `bluffLengths`) give a short, a typical
// and a long card sized to this table, so the real answer looks like just
// another player's entry. Round 1 uses a default spread; from round 2 the
// room steers. Clamped to 4-30 words (movies min 6).
// Round 1 only (nothing to read yet): a middle-of-the-road spread, since a
// 25-word answer in round 1 would stand out at most tables.
const DEFAULT_BANDS = [[4, 9], [8, 14], [10, 18]];
const MIN_ROOM_SAMPLES = 2;  // one round with 2+ players is enough to start
const ROOM_WINDOW = 24;      // most recent human bluffs considered
const MAX_WORDS = 30;

function minWords(category){ return category === "movies" ? 6 : 4; }
function bandsFor(category){
  return category === "movies" ? [[6, 10], [9, 14], [12, 18]] : DEFAULT_BANDS;
}
function randInt(lo, hi){ return lo + Math.floor(Math.random() * (Math.max(lo, hi) - lo + 1)); }
function shuffle(arr){
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function wordCount(t){ return String(t || "").trim().split(/\s+/).filter(Boolean).length; }
// Below the minimum: land just above it (floor..floor+2) rather than piling
// every short card onto exactly the minimum.
function clampTarget(n, category){
  const floor = minWords(category);
  if (!Number.isFinite(n) || n < floor) return randInt(floor, floor + 2);
  return Math.min(MAX_WORDS, n);
}
// The room's recent human bluff lengths, oddballs out (one-word jokes and
// runaway essays don't steer the deck), sorted short to long.
function roomSample(roomLengths){
  let L = (Array.isArray(roomLengths) ? roomLengths : [])
    .filter(n => Number.isFinite(n) && n >= 2 && n <= 60)
    .slice(-ROOM_WINDOW)
    .sort((x, y) => x - y);
  if (L.length >= 8) L = L.slice(1, -1); // drop the single shortest and longest
  return L;
}
function pct(L, p){ return L[Math.min(L.length - 1, Math.max(0, Math.round(p * (L.length - 1))))]; }

// Three cards: a short, a typical and a long version of what THIS table
// writes. No default blended in once the room has spoken — a table of
// 5-word writers gets answers of roughly 4-8 words.
function buildDeck(roomLengths, category){
  const L = roomSample(roomLengths);
  if (L.length < MIN_ROOM_SAMPLES) {
    return shuffle(bandsFor(category).map(([lo, hi]) => clampTarget(randInt(lo, hi), category)));
  }
  const s = pct(L, 0.15), m = pct(L, 0.5), l = pct(L, 0.85);
  const cap = Math.round(L[L.length - 1] * 1.5); // never much longer than their longest
  const cards = [
    randInt(Math.round(s * 0.8), s),
    randInt(Math.round(m * 0.9), Math.round(m * 1.1)),
    Math.min(cap, randInt(l, Math.round(l * 1.25)))
  ];
  return shuffle(cards.map(n => clampTarget(n, category)));
}

// kind: "real" | "bluff". Same round (e.g. a "Try again") reuses its target.
// A deck dealt before the room had written anything is thrown out as soon
// as room data exists, so the room steers from round 2, not round 4.
async function drawTarget(gameId, roundIndex, kind, category){
  const fallback = () => buildDeck([], category)[0];
  if (!gameId || roundIndex == null) return fallback();
  const roundKey = String(roundIndex).split("-")[0];
  try {
    const stateRef = db.collection("balderlaugh_length_state").doc(String(gameId));
    // Read the game outside the transaction so players' own writes to it
    // are never held up waiting on this.
    const g = await db.collection("balderlaugh_games").doc(String(gameId)).get();
    const lengths = g.exists ? g.data().bluffLengths : [];
    const roomReady = roomSample(lengths).length >= MIN_ROOM_SAMPLES;
    return await db.runTransaction(async tx => {
      const st = await tx.get(stateRef);
      const state = (st.exists && st.data()[kind]) || {};
      if (state.roundKey === roundKey && Number.isFinite(state.target)) return state.target;
      let deck = Array.isArray(state.deck) ? [...state.deck] : [];
      let fromRoom = !!state.fromRoom;
      if (!deck.length || (roomReady && !fromRoom)) { deck = buildDeck(lengths, category); fromRoom = roomReady; }
      const target = clampTarget(deck.shift(), category);
      tx.set(stateRef, { [kind]: { deck, roundKey, target, fromRoom }, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      return target;
    });
  } catch (err) {
    console.error("drawTarget failed, using a default length:", err);
    return fallback();
  }
}

// Short targets get no slack on the long side (a long answer on a terse
// table is exactly the tell we're hiding); longer ones get about 20%.
function lengthBand(target, category){
  const tol = Math.max(2, Math.round(target * 0.2));
  return {
    lo: Math.max(minWords(category), target - tol),
    hi: target < 10 ? target + 1 : Math.min(MAX_WORDS, target + tol),
    slackHi: target < 10 ? 0 : 2
  };
}
function lengthInstruction(target, category){
  const { lo, hi } = lengthBand(target, category);
  const numbers = target < 12
    ? "No specific numbers or dates at all."
    : "Never state more than ONE specific number, date, or quantity in the whole thing (zero is fine).";
  return `LENGTH: between ${lo} and ${hi} words (aim for about ${target}). Count them. ${numbers} Never exceed ${MAX_WORDS} words.`;
}

// ---- HUMAN-LOOKING STYLE ------------------------------------------------------
// People typing on phones make slips; Claude doesn't. So a spotless entry is
// a tell, and some players misspell on purpose to look "human". Answer: give
// Claude's entries (the real answer and Claude's bluff) the same chance of a
// small slip as this table's own bluffs have. The table's slip rate is
// measured each round in startReading from the humans' entries, using an
// English word list plus a few phone habits (dropped apostrophes, lowercase
// "i", txt-speak). Slips never touch the prompt's own words, names, numbers
// or the answer's two longest words, so the real answer stays true and
// readable.
const STYLE_WINDOW = 40, STYLE_PRIOR = 0.1, STYLE_PRIOR_WEIGHT = 4;
const EXTRA_OK = ["ok","okay","lol","selfie","emoji","wifi","covid","app","apps","online","email","emails","vs","etc","tv","dvd","internet","website","smartphone","hashtag","blog","podcast"];
const TXT_SPEAK = new Set(["u","ur","b4","bc","thx","pls","plz","idk","tho","cuz","ppl","tbh","srsly","w/",
  // contractions typed without the apostrophe (some are also dictionary words, e.g. "cant")
  "dont","cant","wont","isnt","didnt","doesnt","wasnt","arent","werent","hasnt","havent","couldnt","wouldnt",
  "shouldnt","im","ive","youre","theyre","thats","whats","hes","shes"]);
let DICT = null;
function dict(){
  if (!DICT) { DICT = new Set(require("an-array-of-english-words")); EXTRA_OK.forEach(w => DICT.add(w)); }
  return DICT;
}
function termWordSet(term){ return new Set((String(term || "").toLowerCase().match(/[a-z]+/g)) || []); }

// Does this human entry contain at least one slip?
function entryHasSlip(text, term){
  const raw = String(text || "").replace(/[‘’]/g, "'");
  if (/(^|[^A-Za-z'])i([^A-Za-z']|$)/.test(raw)) return true; // lowercase "i"
  const skip = termWordSet(term);
  for (let w of raw.split(/\s+/)) {
    const lw0 = w.toLowerCase();
    if (TXT_SPEAK.has(lw0.replace(/[.,!?;:]+$/, ""))) return true;
    w = w.replace(/^[^A-Za-z']+|[^A-Za-z']+$/g, "");
    if (w.length < 2) continue;
    if (/[^A-Za-z']/.test(w)) continue;   // digits, hyphens: leave alone
    if (w.includes("'")) continue;        // bothered with an apostrophe
    if (/[A-Z]/.test(w)) continue;        // capitalized: probably a name
    const lw = w.toLowerCase();
    if (skip.has(lw)) continue;
    if (!dict().has(lw)) return true;     // "werds", "dont", "thay", "jst"
  }
  return false;
}
function slipRate(recent){
  const r = Array.isArray(recent) ? recent : [];
  const sum = r.reduce((a, b) => a + (b ? 1 : 0), 0);
  return (sum + STYLE_PRIOR * STYLE_PRIOR_WEIGHT) / (r.length + STYLE_PRIOR_WEIGHT);
}

// Plain phone punctuation (the page also does this for every entry).
function plainPunct(t){
  return String(t || "")
    .replace(/[‘’‛′]/g, "'").replace(/[“”„″]/g, '"')
    .replace(/…/g, "...")
    .replace(/\s*[—–]\s*/g, ", ").replace(/\s*;\s*/g, ", ")
    .replace(/,\s*([,.!?])/g, "$1").replace(/\s+/g, " ").trim().replace(/^,\s*/, "").replace(/[,\s]+$/, "");
}

const MISSPELL = { definitely:"definately", receive:"recieve", separate:"seperate", weird:"wierd", until:"untill",
  because:"becuase", believe:"beleive", their:"thier", friend:"freind", friends:"freinds", tomorrow:"tommorow",
  occurred:"occured", government:"goverment", really:"realy", finally:"finaly", beautiful:"beautifull", truly:"truely",
  embarrassed:"embarassed", pursue:"persue", guard:"gaurd", relevant:"relevent", success:"sucess", surprise:"suprise",
  basically:"basicly", restaurant:"restaraunt", cemetery:"cemetary", existence:"existance", independent:"independant",
  noticeable:"noticable", occasion:"occassion", recommend:"reccomend", necessary:"neccessary", achieve:"acheive",
  argument:"arguement", calendar:"calender", beginning:"begining", which:"wich", probably:"probly", actually:"actualy",
  immediately:"immediatly", accidentally:"accidently", environment:"enviroment", library:"libary", especially:"especialy",
  disappear:"dissapear", address:"adress", across:"accross", tongue:"tounge" };
const QWERTY = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
function neighbor(ch){
  for (let r = 0; r < 3; r++) {
    const i = QWERTY[r].indexOf(ch);
    if (i < 0) continue;
    const opts = [QWERTY[r][i - 1], QWERTY[r][i + 1]].filter(Boolean);
    return opts[Math.floor(Math.random() * opts.length)];
  }
  return ch;
}
function typo(w){
  const n = w.length, i = randInt(1, n - 2);
  const pick = Math.random();
  const dbl = w.search(/([a-z])\1/);
  if (pick < 0.3 && dbl > 0) return w.slice(0, dbl) + w.slice(dbl + 1);   // "follows" -> "folows"
  if (pick < 0.55 && w[i] !== w[i + 1] && i < n - 2) return w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2); // swap
  if (pick < 0.8) return w.slice(0, i) + neighbor(w[i]) + w.slice(i + 1);  // fat thumb
  return w.slice(0, i) + w.slice(i + 1);                                    // dropped letter
}
function oneSlip(text, protect){
  const toks = text.split(/(\s+)/);
  const cands = [];
  toks.forEach((tok, idx) => {
    const m = tok.match(/^([^A-Za-z']*)([A-Za-z']+)([^A-Za-z']*)$/);
    if (!m) return;
    const core = m[2], lc = core.toLowerCase();
    if (/[A-Z]/.test(core) || protect.has(lc.replace(/'.*$/, ""))) return;
    if (MISSPELL[lc]) cands.push({ idx, m, kind: "misspell", w: 5 });
    else if (/^[a-z]+'(t|re|ve|ll|m|s|d)$/.test(core)) cands.push({ idx, m, kind: "apos", w: 4 });
    else if (/^[a-z]{4,}$/.test(core)) cands.push({ idx, m, kind: "typo", w: 1 });
  });
  if (!cands.length) return text;
  let r = Math.random() * cands.reduce((a, c) => a + c.w, 0), c = cands[0];
  for (const x of cands) { if (r < x.w) { c = x; break; } r -= x.w; }
  const [, pre, core, post] = c.m;
  let out = c.kind === "misspell" ? MISSPELL[core] : c.kind === "apos" ? core.replace("'", "") : typo(core);
  // A typo that happens to make another real word ("plain" -> "pain") could
  // change the meaning of the real answer — try again, then give up.
  for (let k = 0; c.kind === "typo" && k < 4 && dict().has(out); k++) out = typo(core);
  if (c.kind === "typo" && dict().has(out)) return text;
  toks[c.idx] = pre + out + post;
  return toks.join("");
}
// Same chance of a slip as a human entry at this table; a sloppy table's
// longer entries sometimes get two.
function addSlips(text, rate, protectWords){
  if (!text || text === "(answer unavailable)") return text;
  const protect = new Set(protectWords);
  const words = (text.match(/[A-Za-z']+/g) || []).map(w => w.toLowerCase());
  [...words].sort((a, b) => b.length - a.length).slice(0, 2).forEach(w => protect.add(w)); // key words stay right
  if (Math.random() >= Math.min(0.75, rate)) return text;
  let out = oneSlip(text, protect);
  if (rate > 0.5 && words.length >= 10 && Math.random() < 0.3) out = oneSlip(out, protect);
  return out;
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
  const { lo, hi, slackHi } = lengthBand(target, category);
  const n = wordCount(text);
  // A little slack, but never below the category minimum, and none on the
  // long side for short targets.
  if (n >= Math.max(minWords(category), lo - 2) && n <= hi + slackHi) return text;
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
  let bluff = plainPunct(await fitLength(parsed.bluff, target, false, category));
  try {
    const st = gameId ? await db.collection("balderlaugh_length_state").doc(String(gameId)).get() : null;
    const recent = st && st.exists && st.data().style ? st.data().style.recent : [];
    bluff = addSlips(bluff, slipRate(recent), termWordSet(term));
  } catch (err) { console.error("generateBluff: style step skipped:", err); }
  return { bluff };
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
  try { dict(); } catch (err) { console.error("word list failed to load:", err); } // load before locking the game doc
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
    const stateRef = db.collection("balderlaugh_length_state").doc(String(gameId));
    const stSnap = await tx.get(stateRef);

    // Style: how often do THIS table's bluffs have a slip? (humans only)
    let recent = (stSnap.exists && stSnap.data().style && stSnap.data().style.recent) || [];
    let styleOk = true;
    try {
      const flags = Object.entries(subs).filter(([u, x]) => u !== "CLAUDE" && x && x.text)
        .map(([, x]) => entryHasSlip(x.text, r.term) ? 1 : 0);
      recent = [...recent, ...flags].slice(-STYLE_WINDOW);
    } catch (err) { styleOk = false; console.error("startReading: style check skipped:", err); }
    const realText = aSnap && aSnap.exists && aSnap.data().real ? aSnap.data().real : null;
    const answerText = realText
      ? (styleOk ? addSlips(plainPunct(realText), slipRate(recent), termWordSet(r.term)) : plainPunct(realText))
      : "(answer unavailable)";

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
    if (styleOk) tx.set(stateRef, { style: { recent }, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
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

// Internal helpers, exposed ONLY when the offline tests run
// (tests/functions-tests.js sets BALDERLAUGH_TEST) — never in a deploy.
if (process.env.BALDERLAUGH_TEST) exports._test = { entryHasSlip, slipRate, addSlips, plainPunct, termWordSet, buildDeck, lengthBand };
