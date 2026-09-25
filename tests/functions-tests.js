// Offline tests for functions/index.js — no Firebase or API key needed.
// Run from the repo folder:  node tests/functions-tests.js
process.argv[2] = require('path').join(__dirname, '..', 'functions', 'index.js');
const { fns, store, claude } = require('./fake-firebase.js');
const wc = t => String(t).trim().split(/\s+/).filter(Boolean).length;
let pass = 0, fail = 0;
const check = (name, cond, extra='') => { if(cond){ pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };
const call = (fn, data) => fns[fn]({ data });

(async () => {
  console.log('\n[1] generateItem + length decks');
  store.set('balderlaugh_games/TEST', { players:{}, bluffLengths: [] });
  const targets = [];
  for (let r = 0; r < 6; r++) {
    const res = await call('generateItem', { category:'movies', excludeTerms:[], gameId:'TEST', roundIndex:r });
    const ans = store.get(`balderlaugh_round_answers/${res.answerId}`);
    targets.push(ans.targetWords);
    const n = wc(ans.real);
    check(`round ${r+1}: target ${ans.targetWords}, got ${n} words, answer stored, only term returned`, ans && !('real' in res) && n >= 6 && Math.abs(n - ans.targetWords) <= Math.max(2, Math.round(ans.targetWords*0.2)) + 2);
    if (r === 2) store.get('balderlaugh_games/TEST').bluffLengths = [5,6,4,7,5,6,5,4,6,7,5,6]; // table writes short (deck re-dealt from the room)
  }
  const d1 = targets.slice(0,3).sort((a,b)=>a-b), d2 = targets.slice(3).sort((a,b)=>a-b);
  check(`round 1 uses the gentle default (6-18): ${targets[0]}`, targets[0] >= 6 && targets[0] <= 18);
  check(`once the table writes 4-7 words, targets stay 6-9 (movie min 6): ${targets.slice(3)}`, targets.slice(3).every(t => t >= 6 && t <= 9));

  console.log('\n[2] "Try again" on the same round reuses its target');
  const st = store.get('balderlaugh_length_state/TEST').real.target;
  await call('generateItem', { category:'movies', excludeTerms:[], gameId:'TEST', roundIndex:'5-2' });
  check('retry 5-2 got the same target as round 5', store.get('balderlaugh_round_answers/TEST_5-2').targetWords === st);

  console.log('\n[3] Claude way off -> one rewrite');
  claude.mode = 'verbose'; claude.calls.length = 0;
  store.set('balderlaugh_games/V', { players:{} });
  const v = await call('generateItem', { category:'oddWords', excludeTerms:[], gameId:'V', roundIndex:0 });
  const va = store.get(`balderlaugh_round_answers/${v.answerId}`);
  const rewrites = claude.calls.filter(p => p.startsWith('Rewrite')).length;
  const tt = va.targetWords, hiOk = tt < 10 ? tt + 1 : Math.min(30, tt + Math.max(2, Math.round(tt*0.2))) + 2;
  check(`target ${tt}: 26-word draft ${26 > hiOk ? 'rewritten' : 'close enough, kept'} -> ${wc(va.real)} words (rewrites: ${rewrites})`,
    26 > hiOk ? (rewrites === 1 && Math.abs(wc(va.real)-tt) <= 4) : rewrites === 0);
  check('rewrite prompt for the real answer forbids new facts', claude.calls.filter(p=>p.startsWith('Rewrite')).every(p => p.includes('do not add any new facts')));
  claude.mode = 'badrewrite'; claude.calls.length = 0;
  store.set('balderlaugh_games/W', { players:{} });
  // force a short target by pre-seeding the deck
  store.set('balderlaugh_length_state/W', { real: { deck:[6,6,6] } });
  claude.mode = 'verbose';
  const w = await call('generateItem', { category:'oddWords', excludeTerms:[], gameId:'W', roundIndex:0 });
  claude.mode = 'good';
  check(`rewrite path returns a sane answer (${wc(store.get('balderlaugh_round_answers/'+w.answerId).real)} words)`, wc(store.get('balderlaugh_round_answers/'+w.answerId).real) > 0);

  console.log('\n[4] generateBluff');
  const b = await call('generateBluff', { term:'The Moose', category:'movies', answerSource:'generated', answerId:'TEST_0', gameId:'TEST', roundIndex:0 });
  check(`bluff with game info: ${wc(b.bluff)} words, own deck`, wc(b.bluff) >= 6 && store.get('balderlaugh_length_state/TEST').bluff);
  check('bluff prompt includes the real answer for overlap-avoidance', claude.calls.some(p => p.includes('The REAL answer')));
  const old = await call('generateBluff', { term:'The Moose', category:'movies' });
  check('old-style call (no game info) still works', typeof old.bluff === 'string' && wc(old.bluff) > 0);

  console.log('\n[5] checkAnswers');
  store.set('balderlaugh_items/seed1', { term:'x', real:'a real thing' });
  store.set('balderlaugh_items/empty', { term:'y' });
  const ca = await call('checkAnswers', { refs: [
    { answerSource:'seed', itemId:'seed1' }, { answerSource:'seed', itemId:'gone' },
    { answerSource:'generated', answerId:'TEST_0' }, { answerSource:'generated', answerId:'nope' },
    { answerSource:'seed', itemId:'empty' }, { answerSource:'weird' }, null ] });
  check(`exists = ${JSON.stringify(ca.exists)}`, JSON.stringify(ca.exists) === '[true,false,true,false,false,false,false]');
  check('never returns answer text', !JSON.stringify(ca).includes('real thing'));

  console.log('\n[6] startReading');
  const base = () => ({ players: { a:{name:'A'}, b:{name:'B'}, c:{name:'C', sittingOut:true} },
    round: { index:2, phase:'writing', phaseEndsAt: Date.now() + 60000, answerSource:'seed', itemId:'seed1',
      submissions: { a:{text:'x'} }, answerText:null } });
  store.set('balderlaugh_games/G', base());
  let r = await call('startReading', { gameId:'G', roundIndex:2, order:['a','REAL'], readerUid:'a', readerQueue:['b'] });
  check('refuses while B still writing and time left', r.ok === false && r.reason === 'not-ready' && store.get('balderlaugh_games/G').round.answerText === null);
  store.get('balderlaugh_games/G').round.submissions.b = { text:'y' };
  r = await call('startReading', { gameId:'G', roundIndex:2, order:['a','REAL'], readerUid:'a', readerQueue:['b'] });
  let g = store.get('balderlaugh_games/G');
  check('sitting-out C not waited on; moves when A+B are in', r.ok && g.round.phase === 'reading');
  check('answer attached at the same moment', g.round.answerText === 'a real thing');
  check(`stale order (missed B) replaced with full shuffle: ${g.round.shuffleOrder}`, g.round.shuffleOrder.length === 3 && ['a','b','REAL'].every(x => g.round.shuffleOrder.includes(x)));
  check('reader + queue saved', g.round.readerUid === 'a' && JSON.stringify(g.readerQueue) === '["b"]');
  r = await call('startReading', { gameId:'G', roundIndex:2, order:['a','b','REAL'], readerUid:'a' });
  check('second phone calling late is ignored', r.ok === false && r.reason === 'already-moved');

  store.set('balderlaugh_games/G', base()); store.get('balderlaugh_games/G').round.phaseEndsAt = Date.now() + 2000;
  r = await call('startReading', { gameId:'G', roundIndex:2, order:['a','REAL'], readerUid:'zzz' });
  g = store.get('balderlaugh_games/G');
  check('time up (within 3s grace) moves even with B missing', r.ok && g.round.phase === 'reading');
  check('bogus reader replaced with an active player', ['a','b'].includes(g.round.readerUid));
  check('valid order kept as sent', JSON.stringify(g.round.shuffleOrder) === '["a","REAL"]');

  store.set('balderlaugh_games/G', base()); Object.assign(store.get('balderlaugh_games/G').round, { phaseEndsAt: Date.now()-1, itemId:'gone' });
  r = await call('startReading', { gameId:'G', roundIndex:2, order:['a','REAL'], readerUid:'a' });
  check('missing answer mid-round does not hang', r.ok && store.get('balderlaugh_games/G').round.answerText === '(answer unavailable)');
  r = await call('startReading', { gameId:'NOPE', roundIndex:2, order:[] });
  check('deleted game handled', r.ok === false && r.reason === 'no-game');
  store.set('balderlaugh_games/G', base());
  r = await call('startReading', { gameId:'G', roundIndex:1, order:['a','REAL'] });
  check('wrong round number ignored', r.ok === false);
  let threw = false; try { await call('startReading', { gameId:'G' }); } catch { threw = true; }
  check('bad request rejected', threw);

  console.log('\n[7] room steers from round 2');
  store.set('balderlaugh_games/R2', { players:{} });
  await call('generateItem', { category:'oddWords', excludeTerms:[], gameId:'R2', roundIndex:0 });
  store.get('balderlaugh_games/R2').bluffLengths = [4,5,5,4];
  const t2 = []; for (let r = 1; r < 4; r++) { await call('generateItem', { category:'oddWords', excludeTerms:[], gameId:'R2', roundIndex:r }); t2.push(store.get('balderlaugh_length_state/R2').real.target); }
  check(`round 1's default deck discarded; rounds 2-4 sized to a 4-5 word table: ${t2}`, t2.every(t => t >= 4 && t <= 7));

  console.log('\n[8] style: measuring the table');
  const S = fns._test;
  const cases = [['A moose that can dance', 0], ['a moose that cant dance', 1], ['i think its a moose', 1], ['werds about a moose', 1],
    ['thay jst walk', 1], ['A Swedish film by Ingmar', 0], ['the moose is u', 1], ["It's the Moose's big day", 0], ['The Moose Who Knew Too Much rules', 0]];
  for (const [t, want] of cases) check(`"${t}" -> ${want ? 'slip' : 'clean'}`, (S.entryHasSlip(t, 'The Moose Who Knew Too Much') ? 1 : 0) === want);
  check('rate with no data ~0.1', Math.abs(S.slipRate([]) - 0.1) < 1e-9);
  check('rate for a sloppy table (8 of 10) is high', S.slipRate([1,1,1,1,1,1,1,1,0,0]) > 0.55);

  console.log('\n[9] style: dressing Claude\'s text');
  const real = 'A Swedish documentary that follows a young moose on its long migration across Lapland';
  let changed = 0, keyKept = true, termKept = true;
  for (let i = 0; i < 400; i++) { const o = S.addSlips(real, 0.6, S.termWordSet('The Moose Who Knew Too Much'));
    if (o !== real) changed++; if (!o.includes('documentary') || !o.includes('migration')) keyKept = false; if (!/\bmoose\b/.test(o) || !o.includes('Swedish') || !o.includes('Lapland')) termKept = false; }
  check(`at a 60% table, about 60% get a slip (${Math.round(changed/4)}%)`, changed > 180 && changed < 300);
  check('the two longest (key) words never touched', keyKept);
  check('prompt words and names never touched', termKept);
  let c2 = 0; for (let i = 0; i < 400; i++) if (S.addSlips(real, 0.1, new Set()) !== real) c2++;
  check(`careful table (10%): rarely (${Math.round(c2/4)}%)`, c2 < 80);
  const samples = new Set(); for (let i = 0; i < 60; i++) samples.add(S.addSlips("I don't really believe their moose is definitely lost", 0.75, new Set()));
  console.log('    e.g.', [...samples].filter(x => x !== "I don't really believe their moose is definitely lost").slice(0, 4).join(' | '));
  check('plain punctuation', S.plainPunct('a moose\u2014big\u2014walks; it\u2019s \u201cfun\u201d\u2026') === 'a moose, big, walks, it\'s "fun"...');

  console.log('\n[10] startReading measures the table and dresses the answer');
  store.set('balderlaugh_items/s9', { real: 'A plain documentary \u2014 about moose; really' });
  store.set('balderlaugh_games/SR', { players:{ a:{}, b:{} }, round:{ index:0, phase:'writing', phaseEndsAt: Date.now()-1, term:'Moose', answerSource:'seed', itemId:'s9',
    submissions:{ a:{text:'dont know thay moose'}, b:{text:'a lazy moose i think'}, CLAUDE:{text:'Perfectly written'} } } });
  await call('startReading', { gameId:'SR', roundIndex:0, order:['a','b','CLAUDE','REAL'], readerUid:'a' });
  const st2 = store.get('balderlaugh_length_state/SR');
  check(`two sloppy human entries recorded, Claude's ignored: ${JSON.stringify(st2 && st2.style)}`, st2 && JSON.stringify(st2.style.recent) === '[1,1]');
  const at = store.get('balderlaugh_games/SR').round.answerText;
  check(`answer has phone punctuation: "${at}"`, !/[\u2014;]/.test(at) && at.includes('documentary'));

  console.log(`\n${pass} passed, ${fail} failed`);
})();
