#!/usr/bin/env node
/* ============================================================================
   fetch-results.js
   Reads pool.json, pulls finished World Cup matches from football-data.org,
   and writes results.json in the EXACT shape index.html expects:
       results[team] = { g:[W|D|L|null, x3], ko:{r32,r16,qf,sf,final: bool} }
   Manual corrections in overrides.json are applied last and always win.

   Safe to re-run: it rebuilds results from scratch each time, so it never
   drifts. Before any match is played it simply writes all blanks.

   Auth: football-data.org free tier. Token comes from env FOOTBALL_DATA_TOKEN
   (in GitHub Actions this is the repo secret of the same name).
   ============================================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const POOL_PATH = path.join(ROOT, 'pool.json');
const OVERRIDES_PATH = path.join(ROOT, 'overrides.json');
const RESULTS_PATH = path.join(ROOT, 'results.json');

const API_HOST = 'https://api.football-data.org/v4';

const TOKEN = process.env.FOOTBALL_DATA_TOKEN;
if (!TOKEN) {
  console.error('ERROR: FOOTBALL_DATA_TOKEN environment variable is not set.');
  console.error('In GitHub Actions this comes from the repo secret FOOTBALL_DATA_TOKEN.');
  process.exit(1);
}

/* ---------- helpers ---------- */

// Normalise a team name for comparison: lowercase, strip accents & punctuation.
function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/[^a-z0-9]/g, '');      // strip spaces & punctuation
}

// Alternate spellings the API might use -> canonical pool name.
const ALIASES = {
  'United States': ['USA', 'United States of America', 'US'],
  'South Korea': ['Korea Republic', 'Korea South', 'Republic of Korea'],
  'Turkiye': ['Turkey', 'Türkiye'],
  'Ivory Coast': ["Cote d'Ivoire", 'Côte d’Ivoire', 'Cote d Ivoire'],
  'Czech Republic': ['Czechia'],
  'DR Congo': ['Congo DR', 'Congo-DR', 'Democratic Republic of Congo', 'Congo Democratic Republic', 'DR Congo'],
  'Curacao': ['Curaçao'],
  'Cape Verde': ['Cabo Verde', 'Cape Verde Islands'],
  'Bosnia': ['Bosnia and Herzegovina', 'Bosnia & Herzegovina', 'Bosnia-Herzegovina'],
  'Saudi Arabia': ['KSA']
};

function buildTeamIndex(teams) {
  const idx = {};
  for (const t of teams) {
    idx[normalize(t)] = t;
    for (const a of ALIASES[t] || []) idx[normalize(a)] = t;
  }
  return idx;
}

// Resolve a football-data team object to a pool team, trying name/shortName/tla.
function resolveTeam(idx, teamObj) {
  if (!teamObj) return null;
  for (const candidate of [teamObj.name, teamObj.shortName, teamObj.tla]) {
    const hit = idx[normalize(candidate)];
    if (hit) return hit;
  }
  return null;
}

// football-data "stage" -> our knockout key. null for group / 3rd-place.
const STAGE_KO = {
  LAST_32: 'r32',
  LAST_16: 'r16',
  QUARTER_FINALS: 'qf',
  QUARTER_FINAL: 'qf',
  SEMI_FINALS: 'sf',
  SEMI_FINAL: 'sf',
  FINAL: 'final'
};

const FINISHED = new Set(['FINISHED']);

function blankTeam() {
  return { g: [null, null, null], ko: { r32: false, r16: false, qf: false, sf: false, final: false } };
}

async function apiGet(endpoint) {
  const res = await fetch(`${API_HOST}${endpoint}`, { headers: { 'X-Auth-Token': TOKEN } });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { data = null; }
  if (!res.ok) {
    const msg = (data && (data.message || data.error)) || text || res.statusText;
    const err = new Error(`API ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Fetch WC matches. Try the requested season first; if the free tier rejects
// the season filter, fall back to the competition's current season.
async function fetchMatches(competition, season) {
  try {
    return await apiGet(`/competitions/${competition}/matches?season=${season}`);
  } catch (e) {
    if (e.status === 403 || e.status === 400) {
      console.warn(`Season filter ${season} not allowed (${e.message}); falling back to current season.`);
      return await apiGet(`/competitions/${competition}/matches`);
    }
    throw e;
  }
}

function applyOverrides(results, overrides) {
  for (const [team, ov] of Object.entries(overrides || {})) {
    if (team.startsWith('_')) continue; // skip _help / _example metadata
    if (!results[team]) results[team] = blankTeam();
    if (Array.isArray(ov.g)) {
      ov.g.forEach((v, i) => { if (i < 3 && v !== undefined) results[team].g[i] = v; });
    }
    if (ov.ko && typeof ov.ko === 'object') {
      for (const [k, v] of Object.entries(ov.ko)) {
        if (k in results[team].ko) results[team].ko[k] = !!v;
      }
    }
  }
}

/* ---------- main ---------- */

async function main() {
  const pool = JSON.parse(fs.readFileSync(POOL_PATH, 'utf8'));
  const competition = pool.footballDataCompetition || 'WC';
  const season = pool.season || 2026;
  const teams = Object.values(pool.players).flat();
  const teamIdx = buildTeamIndex(teams);

  // Start everyone blank, then fill from finished matches.
  const results = {};
  for (const t of teams) results[t] = blankTeam();

  console.log(`Fetching matches: competition=${competition} season=${season} ...`);
  const data = await fetchMatches(competition, season);
  const matches = (data && data.matches) || [];
  console.log(`Received ${matches.length} matches from football-data.org.`);

  let counted = 0;
  const unresolved = new Set();

  for (const m of matches) {
    if (!FINISHED.has(m.status)) continue; // only completed matches

    const stage = m.stage || '';
    const home = m.homeTeam, away = m.awayTeam;
    const score = m.score || {};
    const ft = score.fullTime || {};
    const hg = ft.home, ag = ft.away;

    const homeTeam = resolveTeam(teamIdx, home);
    const awayTeam = resolveTeam(teamIdx, away);
    if (home && home.name && !homeTeam) unresolved.add(home.name);
    if (away && away.name && !awayTeam) unresolved.add(away.name);

    if (stage === 'GROUP_STAGE') {
      const gi = Math.min(Math.max((m.matchday || 1) - 1, 0), 2);
      let homeRes = null, awayRes = null;
      if (score.winner === 'HOME_TEAM') { homeRes = 'W'; awayRes = 'L'; }
      else if (score.winner === 'AWAY_TEAM') { homeRes = 'L'; awayRes = 'W'; }
      else if (score.winner === 'DRAW') { homeRes = 'D'; awayRes = 'D'; }
      else if (hg != null && ag != null) {
        homeRes = hg > ag ? 'W' : (hg < ag ? 'L' : 'D');
        awayRes = ag > hg ? 'W' : (ag < hg ? 'L' : 'D');
      }
      if (homeTeam && homeRes) { results[homeTeam].g[gi] = homeRes; counted++; }
      if (awayTeam && awayRes) { results[awayTeam].g[gi] = awayRes; counted++; }
      continue;
    }

    const kk = STAGE_KO[stage];
    if (kk) {
      // Winner of a knockout match advances -> mark that round won.
      let winner = null;
      if (score.winner === 'HOME_TEAM') winner = homeTeam;
      else if (score.winner === 'AWAY_TEAM') winner = awayTeam;
      else if (hg != null && ag != null && hg !== ag) winner = (hg > ag ? homeTeam : awayTeam);
      if (winner) { results[winner].ko[kk] = true; counted++; }
    }
    // THIRD_PLACE and anything else: no points.
  }

  if (unresolved.size) {
    console.warn(`WARNING: ${unresolved.size} API team name(s) did not match the pool and were ignored:`);
    console.warn('  ' + [...unresolved].sort().join(', '));
    console.warn('If any belong to your pool, add an alias in scripts/fetch-results.js (ALIASES).');
  }

  // Manual corrections win.
  let overrides = {};
  try { overrides = JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8')); }
  catch (e) { /* no overrides file yet — fine */ }
  applyOverrides(results, overrides);

  const output = Object.assign({
    _updated: new Date().toISOString(),
    _source: `football-data.org ${competition} season ${season}`,
    _note: 'Auto-generated by scripts/fetch-results.js. Do not edit by hand — use overrides.json for manual corrections.'
  }, results);

  fs.writeFileSync(RESULTS_PATH, JSON.stringify(output, null, 2) + '\n');
  console.log(`Wrote results.json — ${counted} team-result(s) recorded from finished matches.`);
}

main().catch(err => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
