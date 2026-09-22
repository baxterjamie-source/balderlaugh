/**
 * NOT YET WIRED UP TO THE GAME.
 *
 * This is a starting point for the Cloud Function that would power:
 *   - CCC ("Claude Certified Correct"): score a player's free-text guess
 *     against the real answer, 0-3, for a bonus point on a threshold.
 *   - CSF ("Claude Says Funniest"): given the round's human-written bluffs,
 *     pick the funniest, excluding anything Claude declines to rate.
 *
 * Deploy with the Firebase CLI once you're ready:
 *   firebase deploy --only functions
 *
 * Store your Anthropic API key as a Firebase secret, NOT in this file:
 *   firebase functions:secrets:set ANTHROPIC_API_KEY
 *
 * The client side of this isn't built yet either — index.html's CCC/CSF/
 * Include Claude toggles are disabled placeholders. Wiring them up means:
 *   1. Client writes the guess (CCC) or the round's bluffs (CSF) to a
 *      "pending" doc/field.
 *   2. This function triggers (onDocumentWritten, or make it callable),
 *      calls the Claude API server-side, writes the verdict back.
 *   3. Client's existing onSnapshot listener picks up the verdict and
 *      renders the badge — same pattern as everything else in the app.
 */

const { onCall } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");

const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

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
