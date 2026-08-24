/* ============================================================================
   Competition engine - fixtures, standings, form.

   Lifted out of the old per-division admin pages, which each carried their own
   copy. Three near-identical league pages and two near-identical cup pages
   meant a fix to the table logic had to be made five times. This is the single
   copy the generic templates share.

   Pure functions over plain data: no DOM, no network, no globals. That makes
   them testable (see scripts/test-competition.mjs) and safe to reuse in the
   viewer, which needs the same standings maths the admin uses.
   ========================================================================= */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;   // tests
  else root.Competition = api;                                             // browser
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

/* -------------------------------------------------------------------------
   Fixtures
   ---------------------------------------------------------------------- */

function shuffle(list, random) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Round-robin schedule using the circle method: fix the first team, rotate the
 * rest one place each round. With an odd number of teams a null is added, and
 * whoever draws it sits that round out.
 *
 * @param {string[]} teams
 * @param {object}   [opts]
 * @param {boolean}  [opts.doubleRound]  play every pairing home and away
 * @param {function} [opts.random]       injectable for deterministic tests
 * @returns {Array<{day:number, matches:Array, byeTeam:string|null, deadline:string|null}>}
 */
function generateRoundRobin(teams, opts = {}) {
  const random = opts.random || Math.random;
  const unique = [...new Set(teams.filter(Boolean))];
  if (unique.length < 2) throw new Error('Need at least 2 teams');

  const shuffled = shuffle(unique, random);
  const isOdd = shuffled.length % 2 !== 0;
  const arr = isOdd ? [...shuffled, null] : [...shuffled];
  const size = arr.length;

  const matchdays = [];
  let matchId = 0;

  for (let r = 0; r < size - 1; r++) {
    const matches = [];
    let byeTeam = null;

    for (let i = 0; i < size / 2; i++) {
      const t1 = arr[i];
      const t2 = arr[size - 1 - i];
      if (t1 === null || t2 === null) {
        byeTeam = t1 === null ? t2 : t1;
        continue;
      }
      const [home, away] = random() < 0.5 ? [t1, t2] : [t2, t1];
      matches.push({ id: matchId++, home, away, hs: null, as: null, played: false, events: [] });
    }

    matchdays.push({ day: matchdays.length + 1, matches, byeTeam, deadline: null });

    // Rotate everything except the first slot.
    const last = arr[size - 1];
    for (let i = size - 1; i > 1; i--) arr[i] = arr[i - 1];
    arr[1] = last;
  }

  if (opts.doubleRound) {
    const firstHalf = matchdays.length;
    for (let r = 0; r < firstHalf; r++) {
      const source = matchdays[r];
      matchdays.push({
        day: matchdays.length + 1,
        byeTeam: source.byeTeam,
        deadline: null,
        // Reverse fixtures: the away side hosts the return leg.
        matches: source.matches.map(m => ({
          id: matchId++, home: m.away, away: m.home,
          hs: null, as: null, played: false, events: []
        }))
      });
    }
  }

  return matchdays;
}

/* -------------------------------------------------------------------------
   Standings
   ---------------------------------------------------------------------- */

const DEFAULT_POINTS = { win: 3, draw: 1, loss: 0 };

/**
 * League table from played matches.
 * Ordered on points, then goal difference, then goals for, then name - the
 * ordering the old admin used, kept so published tables do not reshuffle.
 */
function buildTable(teams, matchdays, opts = {}) {
  const points = { ...DEFAULT_POINTS, ...(opts.points || {}) };
  const stats = {};
  for (const t of teams) {
    stats[t] = { team: t, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 };
  }

  for (const md of matchdays || []) {
    for (const m of md.matches || []) {
      if (!m.played) continue;
      const h = stats[m.home];
      const a = stats[m.away];
      // A team removed from the competition can still appear in old fixtures.
      if (!h || !a) continue;
      if (typeof m.hs !== 'number' || typeof m.as !== 'number') continue;

      h.p++; a.p++;
      h.gf += m.hs; h.ga += m.as;
      a.gf += m.as; a.ga += m.hs;

      if (m.hs > m.as)       { h.w++; h.pts += points.win;  a.l++; a.pts += points.loss; }
      else if (m.hs === m.as) { h.d++; h.pts += points.draw; a.d++; a.pts += points.draw; }
      else                    { a.w++; a.pts += points.win;  h.l++; h.pts += points.loss; }
    }
  }

  return Object.values(stats)
    .sort((a, b) =>
      b.pts - a.pts ||
      (b.gf - b.ga) - (a.gf - a.ga) ||
      b.gf - a.gf ||
      a.team.localeCompare(b.team))
    .map((t, i) => ({ pos: i + 1, ...t, gd: t.gf - t.ga }));
}

/** Last N results for a team, oldest first. */
function form(team, matchdays, limit = 5) {
  const results = [];
  for (const md of matchdays || []) {
    for (const m of md.matches || []) {
      if (!m.played) continue;
      if (m.home === team)      results.push(m.hs > m.as ? 'W' : m.hs === m.as ? 'D' : 'L');
      else if (m.away === team) results.push(m.as > m.hs ? 'W' : m.as === m.hs ? 'D' : 'L');
    }
  }
  return results.slice(-limit);
}

/**
 * Per-team detail derived from scores alone.
 *
 * Everything here comes from the results an admin already enters, so no
 * goalscorer or card entry is needed. That is the whole point: a league that
 * only records scores still gets something worth reading.
 *
 * Returns the league-table row for each team plus clean sheets, biggest win,
 * heaviest defeat, streaks, and the home/away split.
 */
function teamStats(teams, matchdays, opts = {}) {
  const table = buildTable(teams, matchdays, opts);
  const extra = {};

  for (const t of teams) {
    extra[t] = {
      cleanSheets: 0, failedToScore: 0,
      biggestWin: null, heaviestDefeat: null,
      longestWin: 0, longestUnbeaten: 0,
      home: { p: 0, w: 0, d: 0, l: 0 },
      away: { p: 0, w: 0, d: 0, l: 0 },
      results: []                     // chronological, for streaks
    };
  }

  for (const md of matchdays || []) {
    for (const m of md.matches || []) {
      if (!m.played) continue;
      if (typeof m.hs !== 'number' || typeof m.as !== 'number') continue;

      for (const side of ['home', 'away']) {
        const team = m[side];
        const own = extra[team];
        if (!own) continue;           // a team removed from the competition

        const scored = side === 'home' ? m.hs : m.as;
        const let_in = side === 'home' ? m.as : m.hs;
        const other = side === 'home' ? m.away : m.home;

        if (let_in === 0) own.cleanSheets++;
        if (scored === 0) own.failedToScore++;

        const outcome = scored > let_in ? 'W' : scored === let_in ? 'D' : 'L';
        own.results.push(outcome);

        const split = own[side];
        split.p++;
        if (outcome === 'W') split.w++;
        else if (outcome === 'D') split.d++;
        else split.l++;

        const margin = scored - let_in;
        if (outcome === 'W') {
          const best = own.biggestWin;
          if (!best || margin > best.margin ||
              (margin === best.margin && scored > best.for)) {
            own.biggestWin = { for: scored, against: let_in, margin, opponent: other };
          }
        } else if (outcome === 'L') {
          const worst = own.heaviestDefeat;
          if (!worst || -margin > worst.margin ||
              (-margin === worst.margin && let_in > worst.against)) {
            own.heaviestDefeat = { for: scored, against: let_in, margin: -margin, opponent: other };
          }
        }
      }
    }
  }

  // Longest runs, from the chronological result list.
  for (const t of teams) {
    const own = extra[t];
    let win = 0, unbeaten = 0;
    for (const r of own.results) {
      win = r === 'W' ? win + 1 : 0;
      unbeaten = r === 'L' ? 0 : unbeaten + 1;
      if (win > own.longestWin) own.longestWin = win;
      if (unbeaten > own.longestUnbeaten) own.longestUnbeaten = unbeaten;
    }
    delete own.results;
  }

  return table.map(row => ({ ...row, ...extra[row.team], form: form(row.team, matchdays) }));
}

/** Superlatives across the competition, for a highlights strip. */
function leagueLeaders(stats) {
  const played = stats.filter(s => s.p > 0);
  if (!played.length) return null;

  const best = (pick, better) =>
    played.reduce((a, b) => (better(pick(b), pick(a)) ? b : a));
  const more = (x, y) => x > y;
  const fewer = (x, y) => x < y;

  return {
    bestAttack:  best(s => s.gf, more),
    bestDefence: best(s => s.ga, fewer),
    mostCleanSheets: best(s => s.cleanSheets, more),
    longestUnbeaten: best(s => s.longestUnbeaten, more)
  };
}

/** Goal and assist totals from match events, ranked. */
function playerStats(matchdays) {
  const players = {};
  const touch = name => (players[name] = players[name] || { name, goals: 0, assists: 0 });

  for (const md of matchdays || []) {
    for (const m of md.matches || []) {
      for (const e of m.events || []) {
        if (e.type === 'goal' && e.player) touch(e.player).goals++;
        if (e.assist) touch(e.assist).assists++;
      }
    }
  }

  return Object.values(players)
    .sort((a, b) => b.goals - a.goals || b.assists - a.assists ||
                    a.name.localeCompare(b.name));
}

/* -------------------------------------------------------------------------
   Group + knockout
   ---------------------------------------------------------------------- */

/** Split teams across N groups, snake-seeded so groups stay even. */
function makeGroups(teams, groupCount, opts = {}) {
  const random = opts.random || Math.random;
  const pool = shuffle([...new Set(teams.filter(Boolean))], random);
  const names = 'ABCDEFGH'.slice(0, groupCount).split('');
  const groups = {};
  names.forEach(n => { groups[n] = []; });

  pool.forEach((team, i) => {
    // Serpentine so an uneven pool spreads rather than loading the first group.
    const row = Math.floor(i / groupCount);
    const col = i % groupCount;
    const index = row % 2 === 0 ? col : groupCount - 1 - col;
    groups[names[index]].push(team);
  });

  return groups;
}

/** Every pairing within each group, as a flat fixture list per group. */
function groupFixtures(groups, opts = {}) {
  const out = {};
  let id = 0;
  for (const [name, teams] of Object.entries(groups)) {
    out[name] = [];
    for (let i = 0; i < teams.length; i++) {
      for (let j = i + 1; j < teams.length; j++) {
        const [home, away] = (opts.random || Math.random)() < 0.5
          ? [teams[i], teams[j]] : [teams[j], teams[i]];
        out[name].push({ id: id++, home, away, hs: null, as: null, played: false, events: [] });
      }
    }
  }
  return out;
}

/** Standings within one group, reusing the league table maths. */
function groupTable(teams, fixtures) {
  return buildTable(teams, [{ matches: fixtures || [] }]);
}

/** Top N from each group, in group order. */
function qualifiers(groups, fixtures, perGroup = 2) {
  const out = [];
  for (const [name, teams] of Object.entries(groups)) {
    const table = groupTable(teams, fixtures[name]);
    table.slice(0, perGroup).forEach((row, i) => {
      out.push({ group: name, position: i + 1, team: row.team });
    });
  }
  return out;
}

/* -------------------------------------------------------------------------
   Knockout bracket
   ---------------------------------------------------------------------- */

function roundName(matchCount) {
  if (matchCount === 1) return 'Final';
  if (matchCount === 2) return 'Semi-finals';
  if (matchCount === 4) return 'Quarter-finals';
  return `Round of ${matchCount * 2}`;
}

function blankMatch() {
  return { home: null, away: null, hs: null, as: null, winner: null };
}

/**
 * Build the bracket from group qualifiers.
 *
 * Winners are drawn against a runner-up from their partner group, and the two
 * matches from each group pair are placed in opposite halves of the draw. That
 * is what stops two teams from the same group meeting again in the very next
 * round - the property the old four-group version got by hand-writing
 * A1vB2, C1vD2, B1vA2, D1vC2. This generalises it to any even group count.
 */
function seedBracket(qualified) {
  const winners = qualified.filter(q => q.position === 1).sort((a, b) => a.group.localeCompare(b.group));
  const runners = qualified.filter(q => q.position === 2).sort((a, b) => a.group.localeCompare(b.group));

  const n = winners.length;
  if (n < 2) throw new Error('Need at least 2 groups to build a bracket');
  if (n !== runners.length) throw new Error('Every group must supply two qualifiers');
  if ((n & (n - 1)) !== 0) throw new Error(`${n} groups does not make an even bracket`);

  const firstHalf = [];
  const secondHalf = [];

  for (let p = 0; p < n / 2; p++) {
    const a = 2 * p;
    const b = 2 * p + 1;
    firstHalf.push({ ...blankMatch(), home: winners[a].team, away: runners[b].team });
    secondHalf.push({ ...blankMatch(), home: winners[b].team, away: runners[a].team });
  }

  const first = [...firstHalf, ...secondHalf].map((m, i) => ({ ...m, id: i }));

  // Empty rounds all the way down to the final.
  const rounds = [{ name: roundName(first.length), matches: first }];
  let count = first.length;
  let id = first.length;
  while (count > 1) {
    count = count / 2;
    rounds.push({
      name: roundName(count),
      matches: Array.from({ length: count }, () => ({ ...blankMatch(), id: id++ }))
    });
  }
  return rounds;
}

/**
 * Push decided winners into the next round.
 * Mutates nothing: returns a new rounds array.
 */
function advanceBracket(rounds) {
  const out = rounds.map(r => ({ ...r, matches: r.matches.map(m => ({ ...m })) }));

  // Every round is resolved, including the last - the final has no round after
  // it, but its winner is the champion and still has to be worked out.
  for (let r = 0; r < out.length; r++) {
    const here = out[r].matches;

    for (let i = 0; i < here.length; i++) {
      const m = here[i];
      const hasScores = typeof m.hs === 'number' && typeof m.as === 'number';

      let decided = null;
      if (hasScores && m.hs !== m.as) {
        // Scores are authoritative. Reading an existing m.winner first would
        // freeze the original result, so correcting a wrongly entered score
        // would leave the beaten team in the next round.
        decided = m.hs > m.as ? m.home : m.away;
      } else if (m.winner === m.home || m.winner === m.away) {
        // Level on the day, or not played yet: keep an explicitly set winner,
        // which is how a penalty shootout gets recorded.
        decided = m.winner;
      }
      m.winner = decided || null;

      if (r === out.length - 1) continue;         // nothing downstream of the final

      const slot = out[r + 1].matches[Math.floor(i / 2)];
      if (!slot) continue;
      const side = i % 2 === 0 ? 'home' : 'away';

      // A changed result must clear everything it fed, or a stale name and an
      // orphaned score linger in the next round.
      if (slot[side] !== decided) {
        slot[side] = decided;
        slot.hs = null; slot.as = null; slot.winner = null;
      }
    }
  }
  return out;
}

/** The team that lifted the trophy, or null while the final is undecided. */
function champion(rounds) {
  if (!rounds || !rounds.length) return null;
  const final = rounds[rounds.length - 1].matches[0];
  return final ? final.winner || null : null;
}

return {
  generateRoundRobin,
  buildTable,
  form,
  teamStats,
  leagueLeaders,
  playerStats,
  makeGroups,
  groupFixtures,
  groupTable,
  qualifiers,
  seedBracket,
  advanceBracket,
  champion,
  roundName,
  DEFAULT_POINTS
};
});
