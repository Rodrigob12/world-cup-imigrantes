# World Cup Imigrantes — Pool 2026

A small web app that tracks a FIFA World Cup 2026 prediction pool for 6 players.
Standings update automatically from live match results via a scheduled GitHub
Action, and are published as a static site on GitHub Pages.

## How it works

| File | Purpose |
|------|---------|
| `index.html` | The website. Loads `results.json` and shows standings. |
| `pool.json` | Source of truth: the 6 players and the 8 teams each one owns. |
| `results.json` | **Auto-generated** scores. Do not edit by hand. |
| `overrides.json` | Manual corrections you control (always win over the API). |
| `scripts/fetch-results.js` | Pulls finished matches from football-data.org, writes `results.json`. |
| `.github/workflows/update-scores.yml` | Runs the script every 6 hours and on demand. |

## Scoring

- **Group stage:** Win = 3, Draw = 1, Loss = 0 (per team, 3 games).
- **Knockout (round won):** R32 = 3, R16 = 6, QF = 9, SF = 12, Final = 15.
- A player's score is the sum across all 8 of their teams.

## Updating scores

Scores refresh automatically every 6 hours. To run it immediately, open the
repo's **Actions** tab → **Update scores** → **Run workflow**.

## Fixing a wrong result

If the API gets a result wrong, edit `overrides.json` and commit it. Example:

```json
{
  "Brazil": { "g": ["W", "W", "D"], "ko": { "r32": true } }
}
```

Your override replaces whatever the API said for that team. It takes effect on
the next workflow run (or trigger one manually).

## Local development

```bash
export FOOTBALL_DATA_TOKEN=your_token_here   # never commit this
node scripts/fetch-results.js                # regenerates results.json
```

The token lives **only** in GitHub Secrets (`FOOTBALL_DATA_TOKEN`) — never in the code.
Get a free token at https://www.football-data.org/client/register
