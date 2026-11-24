# token-radar-01

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/ncalamsyah/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/ncalamsyah/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Launch Radar (model radar-2.5) ranks pre-token DefiLlama protocols by an implied launch value computed from sealed snapshot figures: live-token category mcap/TVL comps, 7d growth, age without a token, chain breadth, and a small 5% concentration bonus for protocols on three or more chains. One `scoreBreakdown()` function returns every multiplier, and the dashboard's detail dialog lists that score breakdown (category, growth, maturity, chain and concentration multipliers) so you can see what drove each rank. Protocols on three or more chains carry a "multi-chain" badge, and the static farm-plan dashboard adds a chain filter and a chain-count sort.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node --experimental-strip-types main.ts --input /path/to/snapshot.json
open out/dashboard/index.html
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=y0qfr724&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
