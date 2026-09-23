/**
 * NOT YET DEPLOYED — write and deploy these before the game's "live
 * generation" and CCC/CSF/Include Claude toggles will do anything.
 *
 * Four functions:
 *   - generateItem: the PRIMARY way Balderlaugh now gets round content.
 *     Given a category, asks Claude — with web search enabled — for a
 *     genuinely real, obscure item and its real answer, grounded in an
 *     actual source rather than generated from memory alone. Returns only
 *     the term to the client; the real answer is written straight to
 *     Firestore server-side and never travels back through the response,
 *     so nobody (host included) sees it before voting opens.
 *   - judgeGuess (CCC): score a player's free-text guess against the real
 *     answer, for a bonus point.
 *   - judgeFunniest (CSF): given the round's human-written bluffs, pick
 *     the funniest, excluding anything Claude declines to rate.
 *   - (Include Claude, the toggle where Claude submits its own bluff, can
 *     reuse judgeFunniest's basic single-call pattern below — not written
 *     yet, flagged here so it's not forgotten.)
 *
 * Deploy with the Firebase CLI once you're ready:
 *   firebase deploy --only functions
 *
 * Store your Anthropic API key as a Firebase secret, NOT in this file:
 *   firebase functions:secrets:set ANTHROPIC_API_KEY
 *
 * generateItem also needs Admin SDK Firestore access (already available
 * inside a deployed Cloud Function without any extra credential file —
 * that's only needed for the local seed.js script, not here).
 */

const { onCall } = require("firebase-functions/v2/https");
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

// Picking a random length/style target BEFORE writing the prompt, rather
// than just asking the model for "1-2 sentences" and hoping — left alone,
// it defaults to maximum density every time (precise dates, named
// mechanisms, stacked specifics), which becomes an obvious tell once
// there's a mix of human bluffs on the list that don't read that way.
// Used for BOTH the real answer and Claude's bluff, each drawn
// independently per round, so length itself carries no signal about
// which entry is real. A soft per-tier cap on stacked specifics wasn't
// enough — a real response still landed 5 numbers deep in one sentence —
// so every tier now carries the same hard, absolute ceiling.
const HARD_CAP = "HARD LIMIT, no exceptions: never exceed 30 words total, and never state more than ONE specific number, date, or quantity in the whole thing — not one per clause, ONE total, or zero.";
const LENGTH_STYLES = [
  { instruction: `One short phrase, well under 12 words. No specific numbers or dates at all — describe it in general terms only. ${HARD_CAP}`, weight: 4 },
  { instruction: `One plain sentence, 12-20 words. ${HARD_CAP}`, weight: 4 },
  { instruction: `One or two short sentences, up to 30 words total — this is the most detail you're allowed to give. ${HARD_CAP}`, weight: 2 }
];
function pickLengthStyle(){
  const total = LENGTH_STYLES.reduce((s, x) => s + x.weight, 0);
  let r = Math.random() * total;
  for (const s of LENGTH_STYLES) {
    if (r < s.weight) return s.instruction;
    r -= s.weight;
  }
  return LENGTH_STYLES[0].instruction;
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
  const lengthStyle = pickLengthStyle();

  const prompt = `You're generating content for a party game called Balderlaugh, a
Balderdash-style bluffing game. I need ${CATEGORY_BRIEF[category]}.

Use web search to verify the item and its answer are ACTUALLY real and
accurate before responding — this is important, the whole game depends on
the "real" answer being genuinely true, not something you recall
unverified from memory. Pick something obscure enough to not be
immediately obvious, but confirmable.${avoid}

For the "real" field's length and level of detail: ${lengthStyle}

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

  // Store the real answer server-side, keyed to this exact game+round.
  // Rules only allow `get` on this collection (not `list`), so a client
  // can fetch this one document once it's playing this exact round, but
  // can't browse other games' or rounds' answers.
  const answerId = `${gameId}_${roundIndex}`;
  await db.collection("balderlaugh_round_answers").doc(answerId).set({
    term: parsed.term,
    real: parsed.real,
    source: parsed.source || null,
    category,
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
  const { term, category, answerSource, answerId, itemId } = request.data;
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

  const lengthStyle = pickLengthStyle();
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

For the length and level of detail: ${lengthStyle}

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
  return { bluff: parsed.bluff };
});

// ---- CCC: judge a free-text guess against the real answer -----------------
exports.judgeGuess = onCall({ secrets: [ANTHROPIC_API_KEY] }, async (request) => {
  const { term, realAnswer, guess } = request.data;
  if (!term || !realAnswer || !guess) {
    throw new Error("term, realAnswer, and guess are all required.");
  }

  const prompt = `You're judging a party game. The real definition/description of "${term}" is:
"${realAnswer}"

A player guessed:
"${guess}"

Is the player's guess close enough in substance to count as correct? Minor
wording differences are fine; it needs to capture the real meaning, not just
sound plausible. Reply with ONLY a JSON object: {"correct": true|false,
"reason": "one short sentence"}`;

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
    console.error("judgeGuess: Anthropic API returned an error — status:", res.status, "| body:", JSON.stringify(data).slice(0, 1000));
    return { correct: false, reason: "Judge call failed." };
  }
  const text = (data.content || []).map(b => b.text || "").join("");
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  try {
    if (!jsonMatch) throw new Error("no JSON in response");
    return JSON.parse(jsonMatch[0]);
  } catch {
    // If parsing fails, don't award the badge — fail closed, not open.
    return { correct: false, reason: "Could not parse judge response." };
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
