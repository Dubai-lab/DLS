#!/usr/bin/env node
/* Tests for the competition engine. Run: node scripts/test-competition.mjs
   These are the rules a season depends on, so they get checked rather than
   eyeballed - a wrong tiebreak or a missing fixture is expensive to discover
   halfway through a league. */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const C = require('../www/js/competition.js');

let pass = 0, fail = 0;

function check(name, fn) {
  try { fn(); console.log(`  ok    ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n          ${e.message}`); fail++; }
}
function eq(actual, expected, what) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what || ''} expected ${b}, got ${a}`);
}
function ok(cond, msg) { if (!cond) throw new Error(msg || 'expected truthy'); }

// Deterministic "random" so schedules are reproducible in tests.
const fixedRandom = () => 0.42;

const teams = (n) => Array.from({ length: n }, (_, i) => `Team ${String.fromCharCode(65 + i)}`);

/* ── Fixtures ─────────────────────────────────────────────────────────── */

check('even teams: every pair meets exactly once', () => {
  const t = teams(6);
  const mds = C.generateRoundRobin(t, { random: fixedRandom });
  eq(mds.length, 5, 'matchdays');

  const seen = new Map();
  for (const md of mds) {
    eq(md.matches.length, 3, `matchday ${md.day} size`);
    for (const m of md.matches) {
      const key = [m.home, m.away].sort().join(' v ');
      seen.set(key, (seen.get(key) || 0) + 1);
    }
  }
  eq(seen.size, 15, 'distinct pairings for 6 teams');
  for (const [k, v] of seen) if (v !== 1) throw new Error(`${k} played ${v} times`);
});

check('odd teams: one bye per round, nobody plays twice in a round', () => {
  const t = teams(5);
  const mds = C.generateRoundRobin(t, { random: fixedRandom });
  eq(mds.length, 5, 'matchdays');

  const byes = {};
  for (const md of mds) {
    eq(md.matches.length, 2, `matchday ${md.day} size`);
    ok(md.byeTeam, `matchday ${md.day} should have a bye`);
    byes[md.byeTeam] = (byes[md.byeTeam] || 0) + 1;

    const playing = md.matches.flatMap(m => [m.home, m.away]);
    eq(new Set(playing).size, playing.length, `matchday ${md.day} duplicate team`);
  }
  // With 5 teams every side sits out exactly once.
  eq(Object.keys(byes).length, 5, 'each team byes once');
});

check('double round produces home and away legs', () => {
  const t = teams(4);
  const mds = C.generateRoundRobin(t, { random: fixedRandom, doubleRound: true });
  eq(mds.length, 6, 'matchdays');

  const counts = new Map();
  for (const md of mds) for (const m of md.matches) {
    const key = `${m.home} v ${m.away}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  // Each ordered pairing occurs once: A v B and B v A both exist, neither twice.
  for (const [k, v] of counts) if (v !== 1) throw new Error(`${k} occurred ${v} times`);
  eq(counts.size, 12, 'ordered pairings for 4 teams, double round');
});

check('fewer than two teams is rejected', () => {
  let threw = false;
  try { C.generateRoundRobin(['Only One']); } catch (e) { threw = true; }
  ok(threw, 'should refuse to build a schedule');
});

check('duplicate team names are collapsed', () => {
  const mds = C.generateRoundRobin(['A', 'B', 'A', 'C'], { random: fixedRandom });
  const names = new Set(mds.flatMap(md => md.matches.flatMap(m => [m.home, m.away])));
  eq([...names].sort(), ['A', 'B', 'C'], 'unique teams');
});

/* ── Standings ────────────────────────────────────────────────────────── */

const md = matches => [{ day: 1, matches }];

check('win, draw and loss award the right points', () => {
  const table = C.buildTable(['A', 'B', 'C'], md([
    { home: 'A', away: 'B', hs: 2, as: 0, played: true },
    { home: 'B', away: 'C', hs: 1, as: 1, played: true }
  ]));
  const byTeam = Object.fromEntries(table.map(r => [r.team, r]));
  eq(byTeam.A.pts, 3, 'winner');
  eq(byTeam.B.pts, 1, 'draw + loss');
  eq(byTeam.C.pts, 1, 'draw');
  eq(byTeam.A.gd, 2, 'goal difference');
});

check('unplayed and half-entered matches are ignored', () => {
  const table = C.buildTable(['A', 'B'], md([
    { home: 'A', away: 'B', hs: 3, as: 1, played: false },
    { home: 'A', away: 'B', hs: null, as: 2, played: true }
  ]));
  eq(table[0].p, 0, 'no matches should count');
});

check('table ties break on goal difference, then goals scored', () => {
  const table = C.buildTable(['A', 'B', 'C'], md([
    { home: 'A', away: 'C', hs: 5, as: 0, played: true },   // A: +5, 5 scored
    { home: 'B', away: 'C', hs: 3, as: 0, played: true }    // B: +3, 3 scored
  ]));
  eq(table.map(r => r.team), ['A', 'B', 'C'], 'order');

  const level = C.buildTable(['X', 'Y', 'Z'], md([
    { home: 'X', away: 'Z', hs: 2, as: 1, played: true },   // X: +1, 2 scored
    { home: 'Y', away: 'Z', hs: 1, as: 0, played: true }    // Y: +1, 1 scored
  ]));
  eq(level.map(r => r.team), ['X', 'Y', 'Z'], 'goals scored breaks a level GD');
});

check('a removed team does not corrupt the table', () => {
  const table = C.buildTable(['A', 'B'], md([
    { home: 'A', away: 'GONE', hs: 3, as: 0, played: true },
    { home: 'A', away: 'B', hs: 1, as: 0, played: true }
  ]));
  const a = table.find(r => r.team === 'A');
  eq(a.p, 1, 'only the match between current teams counts');
  eq(table.length, 2, 'no phantom row');
});

check('form reports the last five, oldest first', () => {
  const days = [{ matches: [
    { home: 'A', away: 'B', hs: 1, as: 0, played: true },
    { home: 'B', away: 'A', hs: 2, as: 2, played: true },
    { home: 'A', away: 'B', hs: 0, as: 3, played: true }
  ] }];
  eq(C.form('A', days), ['W', 'D', 'L']);
  eq(C.form('B', days), ['L', 'D', 'W']);
});

check('player stats total goals and assists', () => {
  const days = [{ matches: [{
    played: true, home: 'A', away: 'B', hs: 2, as: 0,
    events: [
      { type: 'goal', player: 'Haaland', assist: 'Mendes' },
      { type: 'goal', player: 'Haaland' },
      { type: 'card', player: 'Mendes' }
    ]
  }] }];
  const stats = C.playerStats(days);
  eq(stats[0].name, 'Haaland');
  eq(stats[0].goals, 2);
  eq(stats.find(p => p.name === 'Mendes').assists, 1);
});

/* ── Groups and knockout ──────────────────────────────────────────────── */

check('groups split evenly and keep every team', () => {
  const t = teams(16);
  const groups = C.makeGroups(t, 4, { random: fixedRandom });
  eq(Object.keys(groups), ['A', 'B', 'C', 'D']);
  for (const [name, list] of Object.entries(groups)) {
    eq(list.length, 4, `group ${name} size`);
  }
  const all = Object.values(groups).flat();
  eq(new Set(all).size, 16, 'no team lost or duplicated');
});

check('uneven pools spread rather than loading the first group', () => {
  const groups = C.makeGroups(teams(10), 4, { random: fixedRandom });
  const sizes = Object.values(groups).map(g => g.length).sort();
  eq(sizes, [2, 2, 3, 3], 'sizes differ by at most one');
});

check('group fixtures pair everyone once within the group', () => {
  const groups = C.makeGroups(teams(8), 2, { random: fixedRandom });
  const fixtures = C.groupFixtures(groups, { random: fixedRandom });
  for (const [name, list] of Object.entries(fixtures)) {
    eq(list.length, 6, `group ${name}: 4 teams -> 6 matches`);
    const pairs = new Set(list.map(m => [m.home, m.away].sort().join('|')));
    eq(pairs.size, 6, `group ${name} duplicate pairing`);
  }
});

check('qualifiers take the top two per group', () => {
  const groups = { A: ['A1', 'A2', 'A3'], B: ['B1', 'B2', 'B3'] };
  const fixtures = {
    A: [{ home: 'A1', away: 'A2', hs: 3, as: 0, played: true },
        { home: 'A2', away: 'A3', hs: 2, as: 0, played: true }],
    B: [{ home: 'B1', away: 'B2', hs: 1, as: 0, played: true },
        { home: 'B2', away: 'B3', hs: 4, as: 0, played: true }]
  };
  const q = C.qualifiers(groups, fixtures, 2);
  eq(q.length, 4);
  eq(q.filter(x => x.group === 'A').map(x => x.team), ['A1', 'A2']);
  eq(q[0].position, 1);
});

/* ── Team stats derived from scores ───────────────────────────────────── */

// A small season with known answers. Order matters: streaks read chronologically.
const season = [
  { matches: [
    { home: 'A', away: 'B', hs: 3, as: 0, played: true },   // A win, clean sheet
    { home: 'C', away: 'D', hs: 1, as: 1, played: true } ] },
  { matches: [
    { home: 'A', away: 'C', hs: 2, as: 0, played: true },   // A win, clean sheet
    { home: 'B', away: 'D', hs: 0, as: 4, played: true } ] },// B fail to score
  { matches: [
    { home: 'D', away: 'A', hs: 1, as: 5, played: true },   // A big win away
    { home: 'B', away: 'C', hs: 2, as: 2, played: true } ] },
  { matches: [
    { home: 'A', away: 'D', hs: 0, as: 1, played: true },   // A finally lose
    { home: 'C', away: 'B', hs: 0, as: 0, played: true } ] }
];
const four = ['A', 'B', 'C', 'D'];
const statOf = (t, rows) => rows.find(r => r.team === t);

check('clean sheets and blanks are counted', () => {
  const rows = C.teamStats(four, season);
  eq(statOf('A', rows).cleanSheets, 2, 'A kept two clean sheets');
  eq(statOf('B', rows).failedToScore, 3, 'B blanked three times: 0-3, 0-4, 0-0');
});

check('biggest win and heaviest defeat are found', () => {
  const rows = C.teamStats(four, season);
  const a = statOf('A', rows);
  eq(a.biggestWin.margin, 4, 'A: 5-1 away to D');
  eq(a.biggestWin.opponent, 'D');

  const b = statOf('B', rows);
  eq(b.heaviestDefeat.margin, 4, 'B: 0-4 to D');
  eq(b.heaviestDefeat.opponent, 'D');
});

check('streaks read chronologically and stop at a loss', () => {
  const rows = C.teamStats(four, season);
  const a = statOf('A', rows);
  eq(a.longestWin, 3, 'A won the first three');
  eq(a.longestUnbeaten, 3, 'then lost, so the run ends');

  const c = statOf('C', rows);
  eq(c.longestWin, 0, 'C never won');
  // C drew, lost, drew, drew - the loss resets the run, so the best is the
  // two draws that follow it.
  eq(c.longestUnbeaten, 2, 'the defeat breaks the run');
});

check('home and away records split correctly', () => {
  const rows = C.teamStats(four, season);
  const a = statOf('A', rows);
  eq(a.home.p, 3, 'A played three at home');
  eq(a.home.w, 2, 'winning two');
  eq(a.away.p, 1, 'and one away');
  eq(a.away.w, 1, 'which it won');
});

check('team stats still carry the league-table row', () => {
  const rows = C.teamStats(four, season);
  const a = statOf('A', rows);
  eq(a.p, 4); eq(a.w, 3); eq(a.l, 1); eq(a.pts, 9);
  eq(a.form, ['W', 'W', 'W', 'L'], 'form comes along too');
});

check('an unplayed competition yields zeroes, not errors', () => {
  const rows = C.teamStats(four, [{ matches: [
    { home: 'A', away: 'B', hs: null, as: null, played: false }
  ] }]);
  eq(rows.length, 4);
  eq(statOf('A', rows).cleanSheets, 0);
  eq(statOf('A', rows).biggestWin, null);
  eq(C.leagueLeaders(rows), null, 'no leaders before anyone plays');
});

check('league leaders pick the right teams', () => {
  const rows = C.teamStats(four, season);
  const leaders = C.leagueLeaders(rows);
  eq(leaders.bestAttack.team, 'A', 'A scored the most');
  eq(leaders.mostCleanSheets.team, 'A');
  eq(leaders.longestUnbeaten.team, 'A', 'A went three unbeaten before losing');
});

/* ── Knockout bracket ─────────────────────────────────────────────────── */

const qual4 = [
  { group: 'A', position: 1, team: 'A1' }, { group: 'A', position: 2, team: 'A2' },
  { group: 'B', position: 1, team: 'B1' }, { group: 'B', position: 2, team: 'B2' },
  { group: 'C', position: 1, team: 'C1' }, { group: 'C', position: 2, team: 'C2' },
  { group: 'D', position: 1, team: 'D1' }, { group: 'D', position: 2, team: 'D2' }
];

check('bracket reproduces the original four-group seeding', () => {
  const rounds = C.seedBracket(qual4);
  eq(rounds.map(r => r.name), ['Quarter-finals', 'Semi-finals', 'Final']);
  eq(rounds[0].matches.map(m => `${m.home} v ${m.away}`),
     ['A1 v B2', 'C1 v D2', 'B1 v A2', 'D1 v C2'],
     'pairings and draw order');
});

check('same-group teams land in opposite halves', () => {
  const rounds = C.seedBracket(qual4);
  const half = rounds[0].matches.length / 2;
  const first = rounds[0].matches.slice(0, half).flatMap(m => [m.home, m.away]);
  const second = rounds[0].matches.slice(half).flatMap(m => [m.home, m.away]);
  // A1 and B1 both won their groups; they must not be able to meet in the semi.
  ok(first.includes('A1') && second.includes('B1'), 'group winners split');
  ok(first.includes('B2') && second.includes('A2'), 'runners-up split');
});

check('two groups make a straight semi-final', () => {
  const rounds = C.seedBracket(qual4.filter(q => 'AB'.includes(q.group)));
  eq(rounds.map(r => r.name), ['Semi-finals', 'Final']);
  eq(rounds[0].matches.length, 2);
});

check('an odd number of groups is rejected', () => {
  let threw = false;
  try { C.seedBracket(qual4.filter(q => 'ABC'.includes(q.group))); } catch (e) { threw = true; }
  ok(threw, 'should refuse an unbalanced bracket');
});

check('winners advance into the next round', () => {
  let rounds = C.seedBracket(qual4);
  rounds[0].matches[0].hs = 2; rounds[0].matches[0].as = 1;   // A1 beats B2
  rounds[0].matches[1].hs = 0; rounds[0].matches[1].as = 3;   // D2 beats C1
  rounds = C.advanceBracket(rounds);

  eq(rounds[0].matches[0].winner, 'A1');
  eq(rounds[0].matches[1].winner, 'D2');
  eq(rounds[1].matches[0].home, 'A1', 'semi home slot');
  eq(rounds[1].matches[0].away, 'D2', 'semi away slot');
});

check('a draw does not advance anyone', () => {
  let rounds = C.seedBracket(qual4);
  rounds[0].matches[0].hs = 1; rounds[0].matches[0].as = 1;
  rounds = C.advanceBracket(rounds);
  eq(rounds[0].matches[0].winner, null, 'no winner on a level score');
  eq(rounds[1].matches[0].home, null, 'nothing promoted');
});

check('correcting a result clears what it fed downstream', () => {
  let rounds = C.seedBracket(qual4);
  rounds[0].matches[0].hs = 3; rounds[0].matches[0].as = 0;   // A1 through
  rounds[0].matches[1].hs = 2; rounds[0].matches[1].as = 0;   // C1 through
  rounds = C.advanceBracket(rounds);
  rounds[1].matches[0].hs = 1; rounds[1].matches[0].as = 0;   // A1 wins the semi
  rounds = C.advanceBracket(rounds);
  eq(rounds[2].matches[0].home, 'A1', 'reached the final');

  // The quarter-final was entered wrongly; B2 actually won it.
  rounds[0].matches[0].hs = 0; rounds[0].matches[0].as = 1;
  rounds = C.advanceBracket(rounds);
  eq(rounds[1].matches[0].home, 'B2', 'semi updated');
  eq(rounds[1].matches[0].hs, null, 'stale semi score cleared');
  eq(rounds[2].matches[0].home, null, 'stale finalist cleared');
});

check('champion is only named once the final is decided', () => {
  let rounds = C.seedBracket(qual4.filter(q => 'AB'.includes(q.group)));
  eq(C.champion(rounds), null, 'nothing won yet');
  rounds[0].matches[0].hs = 1; rounds[0].matches[0].as = 0;
  rounds[0].matches[1].hs = 1; rounds[0].matches[1].as = 0;
  rounds = C.advanceBracket(rounds);
  rounds[1].matches[0].hs = 2; rounds[1].matches[0].as = 1;
  rounds = C.advanceBracket(rounds);
  ok(C.champion(rounds), 'a winner is named');
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
