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
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

const CATEGORY_BRIEF = {
  oddWords: `a genuinely real, obscure English dictionary word (not invented, not a proper noun) along with its real dictionary definition`,
  obscurePeople: `a real, historically documented but little-known person, along with an accurate one-to-two sentence account of what they're known for`,
  movies: `a real, obscure (but actually released) movie — title plus year — along with an accurate one-to-two sentence plot summary`
};

// ---- Live item generation, grounded with web search ------------------------
exports.generateItem = onCall({ secrets: [ANTHROPIC_API_KEY] }, async (request) => {
  const { category, excludeTerms, gameId, roundIndex } = request.data;
  if (!category || !CATEGORY_BRIEF[category] || !gameId || roundIndex == null) {
    throw new Error("category, gameId, and roundIndex are all required.");
  }
  const avoid = Array.isArray(excludeTerms) && excludeTerms.length
    ? `\n\nAlready used this game, so pick something different: ${excludeTerms.join(", ")}.`
    : "";

  const prompt = `You're generating content for a party game called Balderlaugh, a
Balderdash-style bluffing game. I need ${CATEGORY_BRIEF[category]}.

Use web search to verify the item and its answer are ACTUALLY real and
accurate before responding — this is important, the whole game depends on
the "real" answer being genuinely true, not something you recall
unverified from memory. Pick something obscure enough to not be
immediately obvious, but confirmable.${avoid}

Once verified, respond with ONLY a JSON object (no other text):
{"term": "the word/person name/movie title", "real": "the real definition/bio/plot summary, 1-2 sentences", "source": "brief note on where you verified this"}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY.value(),
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
      tools: [{ type: "web_search_20250305", name: "web_search" }]
    })
  });
  const data = await res.json();
  // Response may interleave text/tool_use/tool_result blocks across
  // multiple search turns — only the text blocks matter for the final answer.
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch {
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
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  // Only the term goes back to the caller — the real answer stays server-side.
  return { term: parsed.term, answerId };
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
      model: "claude-sonnet-4-6",
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }]
    })
  });
  const data = await res.json();
  const text = (data.content || []).map(b => b.text || "").join("");
  try {
    return JSON.parse(text.replace(/```json|```/g, "").trim());
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
      model: "claude-sonnet-4-6",
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }]
    })
  });
  const data = await res.json();
  const text = (data.content || []).map(b => b.text || "").join("");
  try {
    const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
    if (parsed.funniestIndex == null) return { winnerId: null, reason: parsed.reason };
    const winner = submissions[parsed.funniestIndex - 1];
    return { winnerId: winner ? winner.id : null, reason: parsed.reason };
  } catch {
    return { winnerId: null, reason: "Could not parse judge response." };
  }
});
