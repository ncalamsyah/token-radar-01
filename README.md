# token-radar-01

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/ncalamsyah/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/ncalamsyah/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Launch Radar (model radar-3.0) ranks pre-token DefiLlama protocols by an expected launch value computed only from the sealed snapshot's figures; no protocol name is special-cased and live-token protocols are used as comps, never ranked.

- **Fitted size curve.** For every DefiLlama category with at least four live-token peers, market cap ÷ TVL is regressed on log10 TVL (ordinary least squares), so a large protocol is not given the same multiple of TVL as a small one. Categories with two or three peers keep their median, and the rest use a default; the multiple is clamped to a floor and cap. The fitted parameters ship in `data.js`.
- **Held-out tests.** The fit is checked on itself and the results are shown on the board: leave-one-out and a walk-forward split (fit on the lower-TVL half, score the upper half), each as mean absolute log error and Spearman rank correlation. They are modest, and the board says so.
- **Token odds.** The chance a token ever lists falls with age without one (exponential decay from a young-protocol ceiling to a floor; unknown age gets its own value). Age is the only input.
- **Expected value.** `launch value = TVL × size-fit multiple × growth × age × chains × concentration × liquidity spread`; `EV = launch value × token odds`. The board ranks by EV, and every row carries its one-line equation. `scoreBreakdown()` returns every factor.
- **Integrity strip.** The first screen shows the watchlist covered N/N, the board size, all 758 protocols accounted for (pre-token + live + other), both held-out rank correlations, the farm/thin/skip counts and the model version.
- **Farm verdicts.** Every plan ends with a verdict in dollars, set by absolute expected-value bands (`MODEL.farm_ev_min`, `MODEL.thin_ev_min`): `farm` at $5M of EV or more, `thin` at $1M or more, else `skip`. Plans are 7 steps (8 for lending and DEX), each with a cost and a time.
- **Dashboard.** A static, network-free page: sortable and filterable by category, chain and verdict, multi-chain badge, and a detail view that shows the equation, odds, launch value against EV, the fit note and the farm plan, and recomputes EV and the verdict from `data.js` to show they match `board.json`.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node --experimental-strip-types main.ts --input /path/to/snapshot.json
open out/dashboard/index.html
node --experimental-strip-types --test tests/
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=y0qfr724&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
