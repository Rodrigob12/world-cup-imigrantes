#!/usr/bin/env node
/* ============================================================================
   fetch-features.js
   Generates the JSON the Match Center (features.html) reads, from the FREE
   football-data.org tier. Runs server-side in the GitHub Action (the browser
   can't call football-data.org directly — it's CORS-blocked).

   Writes:
     data/standings.json  — group tables   (/competitions/WC/standings)
     data/scorers.json    — goals + assists (/competitions/WC/scorers)
     data/matches.json    — fixtures/results(/competitions/WC/matches)

   Free tier does NOT provide lineups, minute-by-minute events, or card
   leaderboards — the UI shows honest "not available" states for those.
   Everything is empty until the tournament is played; that's expected.
   ============================================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const HOST = 'https://api.football-data.org/v4';
const COMP = process.env.WC_COMPETITION || 'WC';

const TOKEN = process.env.FOOTBALL_DATA_TOKEN;
if (!TOKEN) {
  console.error('ERROR: FOOTBALL_DATA_TOKEN is not set (repo secret of the same name).');
  process.exit(1);
}

async function api(endpoint) {
  const res = await fetch(`${HOST}${endpoint}`, { headers: { 'X-Auth-Token': TOKEN } });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { /* leave null */ }
  if (!res.ok) {
    const msg = (data && (data.message || data.error)) || text || res.statusText;
    const err = new Error(`API ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function write(name, obj) {
  fs.writeFileSync(path.join(DATA, name), JSON.stringify(obj, null, 2) + '\n');
}

const stamp = () => ({ updated: new Date().toISOString(), source: `football-data.org ${COMP}` });

// "W,D,L" -> ["W","D","L"]
function parseForm(f) {
  if (!f) return [];
  return String(f).split(/[,\s]+/).filter(Boolean).map(x => x[0].toUpperCase());
}

async function buildStandings() {
  let data;
  try { data = await api(`/competitions/${COMP}/standings`); }
  catch (e) { console.warn('standings unavailable:', e.message); data = { standings: [] }; }
  const groups = [];
  (data.standings || []).forEach(s => {
    if (s.type !== 'TOTAL' || !s.group) return;           // group totals only
    const name = String(s.group).replace(/group[\s_]*/i, '').toUpperCase();
    const table = (s.table || []).map(r => ({
      name: r.team && r.team.name, tla: r.team && r.team.tla, crest: r.team && r.team.crest,
      played: r.playedGames, w: r.won, d: r.draw, l: r.lost,
      gf: r.goalsFor, ga: r.goalsAgainst, gd: r.goalDifference, points: r.points,
      form: parseForm(r.form)
    }));
    groups.push({ name, table });
  });
  groups.sort((a, b) => a.name.localeCompare(b.name));
  write('standings.json', Object.assign(stamp(), { groups }));
  console.log(`standings.json: ${groups.length} group(s)`);
}

async function buildScorers() {
  let data;
  try { data = await api(`/competitions/${COMP}/scorers?limit=20`); }
  catch (e) { console.warn('scorers unavailable:', e.message); data = { scorers: [] }; }
  const scorers = (data.scorers || []).map(s => ({
    name: s.player && s.player.name, team: s.team && s.team.name, crest: s.team && s.team.crest,
    goals: s.goals || 0, assists: s.assists || 0, penalties: s.penalties || 0
  }));
  write('scorers.json', Object.assign(stamp(), { scorers }));
  console.log(`scorers.json: ${scorers.length} player(s)`);
}

async function buildMatches() {
  let data;
  try { data = await api(`/competitions/${COMP}/matches`); }
  catch (e) { console.warn('matches unavailable:', e.message); data = { matches: [] }; }
  const matches = (data.matches || []).map(m => {
    const ft = (m.score && m.score.fullTime) || {};
    return {
      id: m.id, utcDate: m.utcDate, status: m.status, stage: m.stage, group: m.group,
      home: { name: m.homeTeam && m.homeTeam.name, tla: m.homeTeam && m.homeTeam.tla, crest: m.homeTeam && m.homeTeam.crest, score: ft.home != null ? ft.home : null },
      away: { name: m.awayTeam && m.awayTeam.name, tla: m.awayTeam && m.awayTeam.tla, crest: m.awayTeam && m.awayTeam.crest, score: ft.away != null ? ft.away : null },
      winner: m.score && m.score.winner
    };
  });
  write('matches.json', Object.assign(stamp(), { count: matches.length, matches }));
  console.log(`matches.json: ${matches.length} match(es)`);
}

async function main() {
  if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
  await buildStandings();
  await buildScorers();
  await buildMatches();
}

main().catch(err => { console.error('FAILED:', err.message); process.exit(1); });
