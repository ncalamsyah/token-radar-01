// token-radar-01 entry (Node 22, standard library only).
// Model radar-3.0: Launch Radar. Per category, a size-aware multiple (least-squares line of mcap/TVL on
// log10 TVL through live-token peers, tested leave-one-out and walk-forward), times growth, maturity, chain
// breadth, a concentration bonus and a liquidity spread bonus gives a launch value; token odds (falling
// with age without a token) turn it into an expected value, which ranks the board. Farm plans are 7 steps
// (8 for lending and DEX) and end in a farm / thin / skip verdict set by absolute expected-value bands.
//
// Layout: lib/scoring.ts (the math), lib/farm.ts (farm plans), lib/model.ts (snapshot -> board and
// data.js), lib/dossier.ts (dossier.json), dashboard/ (data.js, radar-view.js, app.js: a static page).
//
// Flow: read the sealed snapshot (/input/snapshot.json or --input <file|dir>), score every pre-token
// protocol with lib/model.ts, check the board against the gate, then write to the output directory:
//   board.json, data.js (for the dashboard), dashboard/, screenshots/, and last dossier.json
// (built by lib/dossier.ts; the scorer rebuilds it from this output and compares bytes).
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node --experimental-strip-types main.ts --input ../token-radar-01-kit/input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier, PLAIN_NAME } from './lib/dossier.ts';
import { summarizeBoard } from './lib/explain.ts';
import { MODEL, MODEL_VERSION, boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { fmtMoney } from './lib/scoring.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps (reference/gate.json): the text cap shapes the bytes, the rest refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const DASHBOARD_CAPS = { max_files: 400, max_bytes: 4_194_304 };

function fail(message: string, code = 1): never {
  process.stderr.write(`token radar: ${message}\n`);
  process.exit(code);
}

/** --name <value> or --name=value out of the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) fail(`no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input`, 2);
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

// radar-3.0 scoring: one pass over the snapshot, then the gate check before anything is written.
const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) fail(`the model wrote a board the gate refuses: ${issue}`);
const multiChain = board.filter((r) => r.chains.length >= MODEL.concentration_min_chains).length;
const deepPlans = board.filter((r) => r.farm_extra !== null).length;
const mix = summarizeBoard(board);
const fd = radar.fit_diagnostics;
const ig = radar.integrity;
const bands = radar.farm_verdict_thresholds;

mkdirSync(out, { recursive: true });
writeFileSync(
  join(out, 'board.json'),
  `${JSON.stringify({ model_version: MODEL_VERSION, fit_diagnostics: fd, farm_verdict_thresholds: bands, integrity: ig, rows: board })}\n`,
);
writeFileSync(join(out, 'data.js'), dataScript(radar));

const dashFiles = copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  fail(`screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view`);
}
for (const name of shots) {
  if (!PLAIN_NAME.test(name)) fail(`screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters`);
}

// The dossier is written last, once everything it summarises is on disk.
writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: DASHBOARD_CAPS }));

process.stdout.write(
  `token radar (${MODEL_VERSION}): ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
    `token radar: watchlist fully covered: ${ig.watchlist_covered} of ${ig.watchlist_size}; ${ig.pre_token_count} pre-token + ${ig.live_count} live + ${ig.other_count} other = ${ig.protocols_total} protocols accounted\n` +
    `token radar: size-fit on ${fd.peers_fitted} peers in ${fd.categories_fitted} categories; leave-one-out MALE ${fd.loo_male}, Spearman ${fd.loo_spearman}; walk-forward MALE ${fd.wf_male}, Spearman ${fd.wf_spearman}\n` +
    `token radar: farm verdicts (farm >= ${fmtMoney(bands.farm_ev_min)} EV, thin >= ${fmtMoney(bands.thin_ev_min)}, else skip): ${mix.farm} farm, ${mix.thin} thin, ${mix.skip} skip (of ${mix.total})\n` +
    `token radar: ${multiChain} of ${board.length} board rows are multi-chain (>=${MODEL.concentration_min_chains} chains), ${deepPlans} lend/dex rows carry an 8-step farm plan\n` +
    `token radar: board mix: ${mix.multiChain} multi-chain, ${mix.lendDex} lend/dex, ${mix.positiveGrowth} with TVL up over 7d, ${mix.unknownAge} of unknown age (of ${mix.total})\n` +
    `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')} (${dashFiles.length} files), ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);
