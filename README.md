# Balderlaugh — setup notes

## What's working right now
- Discoverable lobby list ("Jamie's Game", "Pat's Game"...) + join-by-code fallback
- Explicit host transfer ("Make host" next to any player), plus auto-handoff
  if the host leaves or is the one who disconnects
- Refresh-safe: reloading mid-game reattaches you to wherever you left off,
  instead of dropping you back at the home screen
- Duplicate-name guard on join ("That name is taken")
- Full round loop: prompt → write bluffs (with timer) → vote on which is real →
  optional crowd "funniest" vote (ties share the badge) → reveal with badges
  and vote counts → scoring → standings → next round → final leaderboard
- Scoring: +2 for correctly spotting the real answer, +1 to a bluff's author for
  each player it fools
- Auto-advances phases the moment everyone's submitted/voted, and any player's
  device (not just the host's) can trigger that advance — so a locked/backgrounded
  host phone can't stall the room
- Round content is **live-generated with web-search grounding** via the
  `generateItem` Cloud Function (not deployed yet — see below), falling back
  automatically to the pre-seeded Firestore bank if generation fails
- Everything else syncs live through Firestore — no login, same open-access
  pattern as the Low-or-Out list

## Not built yet (on purpose)
`generateItem` (live round content), CCC (free-guess bonus), CSF (Claude
picks funniest), and Include Claude all need a server-side judge — you can't
call the Claude API straight from a public GitHub Pages site without
exposing an API key. `judge-function/index.js` has working code for
`generateItem`, `judgeGuess`, and `judgeFunniest` — it just needs to be
deployed (see "Deploying judge-function" below). Until it's deployed, the
client's `generateItem` call will fail and the game silently falls back to
the seeded bank every round — so the game is fully playable either way, it
just won't have fresh AI-generated content until you deploy it.

CCC/CSF/Include Claude's toggles are still visibly disabled ("coming soon")
in the lobby UI — their client-side wiring isn't built yet, only the
function code is ready.

Crowd funniest vote (the un-judged, players-vote-for-funniest version) IS
live, since it's pure client-side voting with no judge required.

## To run it
1. Create a Firebase project (or reuse an existing one — just make sure the
   Firestore collection name stays unique; this app uses `balderlaugh_games`).
2. Enable Firestore in the project, in open/test mode (matches how
   cottagerestocklist is set up — no auth for gameplay data, anyone can
   read/write the game doc itself).
3. Paste your Firebase config into the `firebaseConfig` object near the top of
   the `<script type="module">` block in `index.html`.
4. Seed the fallback item bank — see "Item content" below. Not strictly
   required if you deploy `generateItem` first, but worth having as a safety
   net regardless.
5. Deploy `judge-function` (see below) so live generation actually works.
6. Set the Firestore rules — see "Firestore rules" below.
7. Push `index.html` to the repo and make sure Pages is enabled (Settings →
   Pages → Deploy from branch → `main` / root), then link it from the cottage
   site's "Fun Stuff" section alongside Baseball Darts and the GG Mini.

## Deploying judge-function (for live generation)
1. `cd judge-function && npm install`
2. If this project hasn't used Cloud Functions before: `firebase init
   functions` in the repo root (point it at the existing `judge-function`
   folder rather than letting it scaffold a new one, or just copy
   `index.js`/`package.json` into whatever folder it scaffolds).
3. Get an Anthropic API key from the [Anthropic Console](https://console.anthropic.com/)
   if you don't already have one, then:
   `firebase functions:secrets:set ANTHROPIC_API_KEY`
4. `firebase deploy --only functions`
5. That's it — `index.html` already calls `generateItem` by name; as long
   as it deploys to the default region (`us-central1`), no client changes
   are needed. Test by starting a round and watching for "Writing the
   prompt…" — if generation is working, it'll take a few seconds (it's
   doing a real web search) before the round opens for writing.

`judgeGuess` and `judgeFunniest` deploy at the same time but aren't called
by the client yet — that's the next piece of work when you're ready for
CCC/CSF.

## Item content — the fallback bank
The pre-seeded fallback (used only if live generation fails) is populated
the same way as before:

1. `cd seed && npm install firebase-admin`
2. Firebase console → Project settings → Service accounts → "Generate new
   private key" → save the download as `seed/serviceAccountKey.json`
3. `node seed.js`

This writes `balderlaugh_items/{itemId}` (one doc per item) and
`balderlaugh_meta/itemIndex` (ids + terms only, no answers — used to pick a
random fallback prompt without downloading the full bank).

`seed/` is git-ignored — `items.json` and `serviceAccountKey.json` should
never end up in the repo, since GitHub Pages repos are public. Note: this
seeded list of 10-per-category was generated the same unverified way live
generation would be *without* the web-search grounding step — treat it as
"probably mostly right," not a verified source of truth. It's there as a
safety net for when generation fails, not as the primary content source.

## Firestore rules
Add rules for the new collections alongside whatever already covers
`cottage/lowStock` and `balderlaugh_games`:

```
match /balderlaugh_meta/{docId} {
  allow read: if true;
  allow write: if false;   // only the seed script (Admin SDK) writes this
}
match /balderlaugh_items/{itemId} {
  allow get: if true;      // can read ONE item if you already know its id
  allow list: if false;    // can't browse/enumerate the whole answer key
  allow write: if false;   // only the seed script (Admin SDK) writes this
}
match /balderlaugh_round_answers/{answerId} {
  allow get: if true;      // can read ONE round's answer if you know its id (gameId_roundIndex)
  allow list: if false;    // can't browse other games'/rounds' answers
  allow write: if false;   // only generateItem (Admin SDK, server-side) writes this
}
match /balderlaugh_used_terms/{termId} {
  allow read, write: if true;   // no secrets here — the term itself is shown to every player anyway
}
```

The `get`/`list` split is doing the real work here: a client can still ask
Firestore for the one specific item or round-answer it currently needs, but
can't query either collection to see everything in it at once.

## Cross-game term cooldown
`balderlaugh_used_terms` tracks every word/person/movie used across ALL
games (not just the current one), each stamped with when it was last used.
Both live generation and the seeded fallback check this before picking —
anything used in the last 60 days (`COOLDOWN_DAYS` in `index.html`) is
avoided where possible. It's a soft preference, not a hard block: if
honoring it would leave nothing left to pick from (a small seed bank plus
heavy testing, say), the game quietly falls back to ignoring it rather than
stalling a round.

**To reset it** (e.g. once testing wraps, for a clean slate before a real
game night): Firestore Database → Data tab → open `balderlaugh_used_terms`
→ delete the collection (the "⋮" menu on the collection has a "Delete
collection" option). Nothing else depends on it, so it's safe to wipe
anytime.

## Known limitation (read before a big game night)
Game *state* — submissions, votes, live scores — is still wide open in
Firestore, same open-access pattern as the rest of the cottage's tools. A
player who opened dev tools mid-round could in theory see other players'
bluffs before voting closes. The answer key itself (both the seeded bank
and live-generated round answers) is properly locked down, but this
remaining piece would need real auth to close fully. Fine for a trusted
room of friends.

Also worth knowing: web-search grounding meaningfully reduces hallucination
risk for live-generated items, but doesn't eliminate it — the model could
still misjudge a source or the search could turn up something misleading.
Reasonably trustworthy, not guaranteed.

## Things worth playtesting / tuning
- Both writing and voting time are now host-set per game (2:00-5:00, 30s
  steps, lobby settings) rather than fixed constants.
- Generation latency: with Include Claude on, the bluff call now has to
  wait for the real answer first (needed for overlap-avoidance — see
  below), so those two calls can't run in parallel anymore. Some added
  round-start delay there is an inherent tradeoff, not a bug.
- No "kick a player" control if someone drops off mid-game and doesn't
  come back — the game will just keep waiting on their submission/vote
  until the timer expires and moves on without them.
- Same device, multiple browser tabs share the same local player identity
  (by design) — for a real multi-device test, use separate phones or
  separate browsers/incognito windows.
- "Play until there's a clear winner" (lobby toggle) adds tiebreaker
  rounds past the configured round count if the last round ends tied for
  first — the round pill shows "Bonus round N (tiebreaker)" once past the
  original count.

## The Reader role
A new phase sits between writing and voting: one player each round is
assigned Reader (a shuffled, no-repeat-until-exhausted rotation of active
players — `game.readerQueue`, rebuilt whenever it empties out). Only the
Reader sees the full shuffled list, real answer marked, no authors shown
— same blind-to-authorship rule as the reveal screen always had. Everyone
else just sees who's reading and waits. The Reader has an 8-minute cap
(`READING_SECONDS`) before it auto-advances for the whole table, same
any-client-can-trigger resilience pattern as the writing/voting timers —
but pressing "Show Group" is what actually starts the voting clock,
never the reading time itself.

## Single combined voting list
Each submission now gets one row with its own "Real" and "😂 Funniest"
chips, instead of the list rendering twice under two separate headers.
Selecting a chip on one row deselects it everywhere else (still
single-select per vote type) — the same submission's row can hold both
selections at once.

## Include Claude's bluff quality
`generateBluff` now sees the real answer server-side (never sent to any
browser) specifically so it can avoid reusing the real answer's specific
words — testing showed staying fully blind still produced accidental
overlap (e.g. both a real and fake definition of an "yesterday"-related
word using the word "yesterday"), since Claude's own general knowledge of
well-documented terms tends to converge with the truth even without being
told it. Length is also now hard-capped (30 words, at most one specific
number/date total) rather than softly suggested, after a test round
produced a real answer with five stacked statistics in one sentence
despite an earlier, softer instruction against exactly that.
