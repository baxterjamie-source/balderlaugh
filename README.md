# Balderlaugh — setup notes

## What's working right now
- Discoverable lobby list ("Jamie's Game", "Pat's Game"...) + join-by-code fallback
- Explicit host transfer ("Make host" next to any player)
- Full round loop: prompt → write bluffs (with timer) → vote on which is real →
  optional crowd "funniest" vote → reveal with badges and vote counts → scoring →
  standings → next round → final leaderboard
- Scoring: +2 for correctly spotting the real answer, +1 to a bluff's author for
  each player it fools
- Auto-advances phases the moment everyone's submitted/voted (doesn't wait out
  the full timer if the room's ready)
- Everything syncs live through Firestore — no login, same open-access pattern
  as the Low-or-Out list

## Not built yet (on purpose)
CCC (free-guess bonus), CSF (Claude picks funniest), and Include Claude all need
a server-side judge — you can't call the Claude API straight from a public
GitHub Pages site without exposing an API key. Their toggles are in the lobby
UI already (visibly disabled, labeled "coming soon") so the settings panel
reflects the full design, but they don't do anything yet. `judge-function/`
has a starting point for the Cloud Function that would wire them up.

Crowd funniest vote (the un-judged, players-vote-for-funniest version) IS live,
since it's pure client-side voting with no judge required.

## To run it
1. Create a Firebase project (or reuse an existing one — just make sure the
   Firestore collection name stays unique; this app uses `balderlaugh_games`).
2. Enable Firestore in the project, in open/test mode (matches how
   cottagerestocklist is set up — no auth, anyone can read/write).
3. Paste your Firebase config into the `firebaseConfig` object near the top of
   the `<script type="module">` block in `index.html`.
4. Push `index.html` to the cottage repo (e.g. `balderlaugh.html`) and link it
   from the "Fun Stuff" section of the site index alongside Baseball Darts and
   the GG Mini.

## Known limitation (read before a big game night)
There's no backend, so nothing truly gates data — a player who opened dev
tools during the writing phase could in theory peek at Firestore before the
reveal. The real answer text is only written to the game doc the moment the
reveal phase begins (not before), which minimizes the window, but it isn't
airtight. Fine for a trusted room of friends; the CCC/CSF Cloud Function,
whenever it's built, could also close this gap properly if it ever matters.

## Things worth playtesting / tuning
- Timer lengths: writing is 90s, voting is 60s — both are constants near the
  top of the script (`WRITING_SECONDS`, `VOTING_SECONDS`), easy to tweak.
- Data bank only has the 10 examples per category from our design chat —
  worth padding out before a real game night so items don't repeat across
  rounds (the game reshuffles the pool back in once exhausted, but more
  variety is better).
- No spectator/rejoin-mid-round handling — someone who reloads mid-round
  rejoins fine (game state lives in Firestore), but there's no "kick a player"
  control yet if someone drops off mid-game.
