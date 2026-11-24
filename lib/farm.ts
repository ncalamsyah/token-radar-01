// Launch Radar farm plans (radar-3.0): the capital, hold and action tables, the steps built from them, and a verdict.
//
// Every protocol gets 6 working steps plus one closing verdict step: 7. A protocol whose category starts a
// word with "lend" or "dex" (Lending, Uncollateralized Lending, Dexs, RWA Lending...) gets a category-specific
// upkeep step inserted just before the notebook step: 8. Both are inside the gate's 3 to 12.
// The word-start match keeps "Indexes" from counting as a DEX.
//
// verdict is an absolute expected-value band (implied_value_usd, after token odds), set on MODEL:
//   EV >= farm_ev_min ($5M) -> 'farm'; EV >= thin_ev_min ($1M) -> 'thin'; else 'skip'.
//
// The dashboard no longer carries its own copy of these tables: data.js ships each row's finished steps
// (farm_steps), which one is the category-specific extra (farm_extra) and the verdict.

import { MODEL, fmtMoney } from './scoring.ts';
import type { ModelConstants, SnapshotProtocol } from './scoring.ts';

export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

export type FarmKind = 'lend' | 'dex';
export type FarmVerdict = 'farm' | 'thin' | 'skip';

export interface FarmPlan {
  steps: FarmStep[];
  /** Index in `steps` of the lend/dex-only step, or null when the plan has none. */
  extra: number | null;
  kind: FarmKind | null;
  verdict: FarmVerdict;
  /** USD deployed in the plan. */
  capital: number;
}

/** The gate's bounds for one farm step string. */
export const STEP_MIN_CHARS = 20;
export const STEP_MAX_CHARS = 600;

export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > STEP_MAX_CHARS) s = `${s.slice(0, STEP_MAX_CHARS - 4)}...`;
  if (s.length < STEP_MIN_CHARS) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** Capital tiers by TVL (USD to deploy). */
export function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 300;
  if (p.tvl_usd >= 1_000_000_000) return 200;
  if (p.tvl_usd >= 250_000_000) return 125;
  if (p.tvl_usd >= 50_000_000) return 75;
  return 50;
}

/** Farm, thin or skip: expected value in dollars against the model's two bands. */
export function verdictFor(implied: number, model: ModelConstants = MODEL): FarmVerdict {
  if (implied >= model.farm_ev_min) return 'farm';
  if (implied >= model.thin_ev_min) return 'thin';
  return 'skip';
}

/** Younger protocols need a longer hold before activity looks organic. */
export function holdDaysFor(age: number | null): number {
  if (age === null) return 60;
  if (age < 120) return 90;
  if (age < 270) return 60;
  if (age < 540) return 45;
  return 30;
}

// Category keyword -> concrete first action. {cap}, {name}, {chain} are filled in per protocol.
const ACTIONS: Array<[string[], string]> = [
  [['lend', 'cdp', 'collateral'], 'Supply ${cap} of USDC as collateral on {name} ({chain}), borrow under 40% LTV, and leave both legs open.'],
  [['dex', 'amm'], "Add ${cap} of balanced liquidity to {name}'s deepest pool on {chain} and leave the LP position open."],
  [['yield', 'leveraged farm', 'aggregator'], "Deposit ${cap} into {name}'s primary vault on {chain} and keep the shares staked only if the vault itself scores points."],
  [['curator', 'allocator', 'risk'], 'Deposit ${cap} into a {name}-curated vault on {chain} and keep the receipt tokens in the same wallet.'],
  [['perp', 'derivative', 'basis'], 'Deposit ${cap} USDC margin on {name} ({chain}), open a tiny hedge under 2x, and keep funding paid.'],
  [['prediction'], 'Fund ${cap} on {name}, place one market under 5% of bankroll, and hold until settlement or the farm window ends.'],
  [['stable'], "Mint or deposit ${cap} of the stable asset through {name} on {chain} and hold it in the protocol's own wallet view."],
  [['rwa'], "Mint ${cap} of {name}'s yield-bearing RWA receipt on {chain} and keep it unbridged for the hold window."],
  [['insurance'], 'Buy ${cap} of cover from {name} on {chain} against a core DeFi risk and keep the policy active.'],
  [['bridge'], 'Bridge ${cap} of USDC to {chain} through {name}, then spend at least half inside its own app so the route is not a pass-through.'],
  [['staking', 'restak'], "Stake ${cap} of the chain's staking asset through {name} on {chain} and keep the liquid receipt in-wallet."],
];
const DEFAULT_ACTION = "Deposit ${cap} of USDC into {name}'s primary product on {chain} and leave the position open through the hold window.";

function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const hit = ACTIONS.find(([keys]) => keys.some((k) => c.includes(k)));
  return (hit ? hit[1] : DEFAULT_ACTION)
    .replace('${cap}', () => `$${capital}`)
    .replace('{name}', () => p.name)
    .replace('{chain}', () => chain);
}

/** Which category-specific step a protocol earns: lend wins when a category names both. */
export function farmKind(p: SnapshotProtocol): FarmKind | null {
  const c = (p.category ?? '').toLowerCase();
  if (/\blend/.test(c)) return 'lend';
  if (/\bdex/.test(c)) return 'dex';
  return null;
}

function extraStep(kind: FarmKind, p: SnapshotProtocol, capital: number, chain: string): FarmStep {
  if (kind === 'lend') {
    const slice = Math.max(10, Math.round(capital / 10));
    return {
      text: `Check your health factor on ${p.name} (${chain}) every week and keep the borrow under 40% LTV; once a month repay and re-borrow about $${slice} so the loan shows live borrow-side activity.`,
      cost: `about $3 to $6 of gas per repay and re-borrow, plus interest on about $${slice}`,
      time: '10 minutes a week, 20 minutes a month',
    };
  }
  return {
    text: `Every two weeks collect the fees on your ${p.name} LP position on ${chain} and add them back to the same pool; if price has left your range, re-centre it once instead of letting it sit idle.`,
    cost: `about $3 to $8 of gas per compound, plus the impermanent loss already riding on the $${capital}`,
    time: '15 minutes every two weeks',
  };
}

/** The closing step: the verdict, the dollar EV, and the band it landed in. */
function verdictStep(verdict: FarmVerdict, implied: number, capital: number, model: ModelConstants): FarmStep {
  const ev = fmtMoney(implied);
  const farmBand = fmtMoney(model.farm_ev_min);
  const thinBand = fmtMoney(model.thin_ev_min);
  const text =
    verdict === 'farm'
      ? `Verdict FARM: expected value after token odds is ${ev}, at or above the ${farmBand} farm band, so run the full plan with the $${capital} deployed.`
      : verdict === 'thin'
        ? `Verdict THIN: expected value after token odds is ${ev}, between the ${thinBand} thin band and the ${farmBand} farm band, so deploy only the $${capital} minimum and keep upkeep light.`
        : `Verdict SKIP: expected value after token odds is ${ev}, under the ${thinBand} thin band, so watch it and do not deploy the $${capital} yet.`;
  return { text, cost: `$${capital} of capital at risk, no extra fee to decide`, time: '2 minutes to decide' };
}

/** `implied` is the row's expected value after token odds (implied_value_usd). */
export function farmPlan(p: SnapshotProtocol, age: number | null, implied: number, model: ModelConstants = MODEL): FarmPlan {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gasSetup = capital >= 150 ? 12 : capital >= 75 ? 7 : 4;
  const steps: FarmStep[] = [
    {
      text: `Create a fresh farming wallet, fund it only with the $${capital} you will deploy plus gas, and store the seed offline.`,
      cost: `under $3 of gas to receive funds on ${chain}`,
      time: '10 minutes',
    },
    {
      text: actionFor(p, capital, chain),
      cost: `$${capital} of capital plus about $${gasSetup} of gas`,
      time: '20 minutes to set up',
    },
    {
      text: `Once a week, do one on-chain action on ${p.name} (deposit, withdraw dust, borrow/repay, swap, or vote) from the same wallet.`,
      cost: 'about $2 to $5 of gas each week',
      time: '15 minutes a week',
    },
    {
      text: `Keep the core position funded for at least ${hold} days so activity spans multiple protocol snapshots.`,
      cost: `the $${capital} stays locked in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before claiming anything, open only the points or rewards UI that ${p.name} publishes itself; never pay a stranger to "claim" for you.`,
      cost: 'no fee to check; claim gas only from the official UI',
      time: '15 minutes',
    },
    {
      text: `Log wallet address, open date, tx hashes, and exit date in a farm notebook so you can unwind or repeat without guessing.`,
      cost: 'nothing but the notebook',
      time: '5 minutes after each change',
    },
  ];
  const kind = farmKind(p);
  let extra: number | null = null;
  if (kind !== null) {
    extra = steps.length - 1; // just before the notebook step
    steps.splice(extra, 0, extraStep(kind, p, capital, chain));
  }
  const verdict = verdictFor(implied, model);
  steps.push(verdictStep(verdict, implied, capital, model));
  return { steps, extra, kind, verdict, capital };
}
