#!/usr/bin/env node
/* ============================================================================
   fetch-results.js
   Reads pool.json, pulls finished World Cup matches from API-Football, and
   writes results.json in the EXACT shape index.html expects:
       results[team] = { g:[W|D|L|null, x3], ko:{r32,r16,qf,sf,final: bool} }
   Manual corrections in overrides.json are applied last and always win.

   This file is safe to re-run: it rebuilds results from scratch each time,
   so it never drifts. Before any match is played it simply writes all blanks.
   ============================================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const POOL_PATH = path.join(ROOT, 'pool.json');
const OVERRIDES_PATH = path.join(ROOT, 'overrides.json');
const RESULTS_PATH = path.join(ROOT, 'results.json');

const API_HOST = 'https://v3.football.api-sports.io';

const KEY = process.env.API_FOOTBALL_KEY;
if (!KEY) {
  console.error('ERROR: API_FOOTBALL_KEY environment variable is not set.');
  console.error('In GitHub Actions this comes from the repo secret API_FOOTBALL_KEY.');
  process.exit(1);
}

/* ---------- helpers ---------- */

// Normalise a team name for comparison: lowercase, strip accents & punctuation.
function normalize(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/[^a-z0-9]/g, '');      // strip spaces & punctuation
}

// Alternate spellings the API might use -> canonical pool name.
const ALIASES = {
  'United States': ['USA', 'United States of America', 'US'],
  'South Korea': ['Korea Republic', 'Korea South'],
  'Turkiye': ['Turkey', 'Türkiye'],
  'Ivory Coast': ["Cote d'Ivoire", 'Côte d’Ivoire', 'Cote d Ivoire'],
  'Czech Republic': ['Czechia'],
  'DR Congo': ['Congo DR', 'Congo-DR', 'Democratic Republic of Congo', 'Congo Democratic Republic'],
  'Curacao': ['Curaçao'],
  'Cape Verde': ['Cabo Verde', 'Cape Verde Islands'],
  'Bosnia': ['Bosnia and Herzegovina', 'Bosnia & Herzegovina'],
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

function resolveTeam(idx, apiName) {
  return idx[normalize(apiName)] || null;
}

// Knockout round label -> our key. Returns null for group games / 3rd-place.
function koKey(round) {
  const r = String(round).toLowerCase();
  if (r.includes('round of 32')) return 'r32';
  if (r.includes('round of 16')) return 'r16';
  if (r.includes('quarter')) return 'qf';
  if (r.includes('semi')) return 'sf';
  if (r.includes('3rd') || r.includes('third')) return null; // 3rd-place playoff: no points
  if (r.includes('final')) return 'final';
  return null;
}

// "Group Stage - 1" / "Group A - 2" -> 0-based index (0..2). null if not a group game.
function groupGameIndex(round) {
  const r = String(round).toLowerCase();
  if (!r.includes('group')) return null;
  const m = r.match(/(\d)/);
  if (!m) return null;
  return Math.min(Math.max(parseInt(m[1], 10) - 1, 0), 2);
}

const FINISHED = new Set(['FT', 'AET', 'PEN']); // full-time / after extra time / penalties

function blankTeam() {
  return { g: [null, null, null], ko: { r32: false, r16: false, qf: false, sf: false, final: false } };
}

async function apiGet(endpoint) {
  const res = await fetch(`${API_HOST}${endpoint}`, { headers: { 'x-apisports-key': KEY } });
  if (!res.ok) {
    throw new Error(`API request failed: ${res.status} ${res.statusText} for ${endpoint}`);
  }
  const data = await res.json();
  if (data.errors && Object.keys(data.errors).length) {
    throw new Error(`API returned errors: ${JSON.stringify(data.errors)}`);
  }
  return data.response || [];
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
  const leagueId = pool.apiFootballLeagueId || 1;
  const season = pool.season || 2026;
  const teams = Object.values(pool.players).flat();
  const teamIdx = buildTeamIndex(teams);

  // Start everyone at blank, then fill from finished matches.
  const results = {};
  for (const t of teams) results[t] = blankTeam();

  console.log(`Fetching fixtures: league=${leagueId} season=${season} ...`);
  const fixtures = await apiGet(`/fixtures?league=${leagueId}&season=${season}`);
  console.log(`Received ${fixtures.length} fixtures from API-Football.`);

  let counted = 0;
  const unresolved = new Set();

  for (const fx of fixtures) {
    const status = fx.fixture && fx.fixture.status && fx.fixture.status.short;
    if (!FINISHED.has(status)) continue; // only completed matches

    const round = (fx.league && fx.league.round) || '';
    const home = fx.teams && fx.teams.home;
    const away = fx.teams && fx.teams.away;
    const hg = fx.goals && fx.goals.home;
    const ag = fx.goals && fx.goals.away;

    const homeTeam = home && resolveTeam(teamIdx, home.name);
    const awayTeam = away && resolveTeam(teamIdx, away.name);
    if (home && home.name && !homeTeam) unresolved.add(home.name);
    if (away && away.name && !awayTeam) unresolved.add(away.name);

    const gi = groupGameIndex(round);
    if (gi !== null) {
      if (hg != null && ag != null) {
        const homeRes = hg > ag ? 'W' : (hg < ag ? 'L' : 'D');
        const awayRes = ag > hg ? 'W' : (ag < hg ? 'L' : 'D');
        if (homeTeam) { results[homeTeam].g[gi] = homeRes; counted++; }
        if (awayTeam) { results[awayTeam].g[gi] = awayRes; counted++; }
      }
      continue;
    }

    const kk = koKey(round);
    if (kk) {
      // Whoever wins a knockout match advances -> mark that round won.
      let winner = null;
      if (home && home.winner === true) winner = homeTeam;
      else if (away && away.winner === true) winner = awayTeam;
      else if (hg != null && ag != null && hg !== ag) winner = (hg > ag ? homeTeam : awayTeam);
      if (winner) { results[winner].ko[kk] = true; counted++; }
    }
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
    _source: `api-football league ${leagueId} season ${season}`,
    _note: 'Auto-generated by scripts/fetch-results.js. Do not edit by hand — use overrides.json for manual corrections.'
  }, results);

  fs.writeFileSync(RESULTS_PATH, JSON.stringify(output, null, 2) + '\n');
  console.log(`Wrote results.json — ${counted} team-result(s) recorded from finished matches.`);
}

main().catch(err => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
