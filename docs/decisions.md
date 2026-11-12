# Decisions

## The LLM reads, code decides

The LLM has one job: turn a messy post into a list of claims. Facts come from the SEC,
the comparison is arithmetic, and the reason shown to the user is built from those numbers.
A wrong extraction can produce a missed or mislabeled claim, but it cannot produce an
invented figure or source.

Model output is treated as untrusted input: the response is constrained to a JSON schema,
every field is re-validated in `llm/normalize.ts`, and the post is wrapped in tags with an
instruction to treat it as content (posts can contain text aimed at the model).

## One API, thin clients

Everything lives behind `POST /api/check`. The web app only renders a `CheckResult`.
A browser extension or a native app is a second renderer, not a second product.
The server is required regardless: the SEC API does not allow browser calls, and the
LLM key must stay off the client.

## One adapter per data source

Each source owns its fetch and its comparison (`EvidenceSource`). The pipeline does not
know what revenue is.

## Cache evidence, not results

Evidence is cached per company for six hours. A post checked many times costs one SEC
lookup. The cache is in memory today; put it in Postgres (Supabase) once there is more
than one server instance. LLM extraction is not cached yet; cache it by a hash of the
post text when volume makes it worth it.

## Verdict rules for revenue claims

Thresholds are constants at the top of `sources/sec/revenueSource.ts`. They are a first
guess and should be tuned against real posts.

| Verdict | Rule |
|---|---|
| Holds up | Within 2 points or 10% of the filed year-over-year figure, whichever is larger |
| Misleading | Matches a different comparison (quarter over quarter, or full year), or is within 5 points or 25% |
| Contradicted | Anything else, including the wrong direction |
| Can't be checked | Prediction, opinion, unsupported claim type, or no filing data |

## Verdict rules for dollar figures

Revenue and net income (or loss), from the same SEC data. Thresholds are at the top of
`sources/sec/figureSource.ts`.

| Verdict | Rule |
|---|---|
| Holds up | Within 3% of the filed figure for the period the post names |
| Misleading | Matches the full year when the post says quarter (or the reverse), or is within 15% |
| Contradicted | Anything else, including a profit claimed where a loss was filed |
| Can't be checked | The period named is not in the data, or the figure is not revenue or net income |

Which period a claim means:

- **Named quarter and year** ("Q2 2026"): the company's fiscal Q2 2026 or calendar Q2 2026.
  Either match counts, because posts use both and the two differ for companies whose fiscal
  year does not start in January.
- **Named year** ("2025 revenue"): that fiscal year.
- **"This quarter" or a quarter with no year**: the latest reported quarter.
- **No period at all**: the latest quarter or the latest fiscal year, whichever matches.

## Earnings press releases (8-K)

Companies announce a quarter in a press release (Form 8-K, Item 2.02, Exhibit 99.1) weeks
before the 10-Q carries the structured numbers. When the latest release was filed after the
latest 10-Q or 10-K, revenue, net income and growth checks use the release's quarter.

The release is HTML, so an LLM reads three figures from it (revenue, net income, diluted EPS),
each with the exact text it copied them from. Code then keeps a figure only if:

- that text is in the release, and
- the figure is printed in that text, at one of the table scales (ones, thousands, millions, billions), and
- the quarter-end date the model names is printed in the release.

Anything else is dropped and the check falls back to the filings. The LLM still never
supplies a number that the user sees unless the document prints it. Code is in
`sources/sec/releases.ts`. Needs `ANTHROPIC_API_KEY`; without it, filings alone are used.

Each release is read once per server instance (cached six hours), and only when it is newer
than the filed data.

## Market data and earnings estimates (Finnhub)

Optional, with `FINNHUB_API_KEY` (free tier: 60 calls a minute, personal and non-commercial
use only; the next tier is $3,500/month, so this is not the path for a commercial launch).

| Claim type | Example | Data |
|---|---|---|
| `earnings_result` | "beat earnings", "missed estimates", "EPS of $1.25", "beat by 20%" | `/stock/earnings`: last four quarters, EPS actual vs estimate |
| `price_move` | "up 40% this week", "shares fell 12% today" | `/quote` (today) and `/stock/metric` (5 days, month to date, year to date, 52 weeks) |
| `market_cap` | "a $3T company" | `/stock/profile2` |

Verdict rules (constants at the top of each file in `sources/finnhub/`):

| Claim | Holds up | Misleading | Contradicted |
|---|---|---|---|
| Beat / miss | Same outcome as reported | Reported in line (within half a cent) but the post says beat or miss; or the stated size of the beat is off by more than 2 points or 20% | Opposite outcome |
| EPS figure | Within 1 cent or 3% | Matches an older quarter, or within 15% | Anything else |
| Price move, window named | Within 3 points or 20% | Matches a different window, or right direction within 8 points or 40% | Anything else |
| Price move, no window | Matches any window (the reason says which) | Right direction within the loose band | Nothing matches |
| Market value | Within 10% | Within 25% | Anything else |

Prices move all day and a post is usually older than the check, so price bands are wide,
every reason says when the price was read, market evidence is cached for five minutes, and a
saved result with a price check is reused for five minutes instead of six hours.

Finnhub's EPS is the adjusted figure analysts track, which can differ from GAAP EPS in the
filing. The reason says so.

## Screenshots

A screenshot gets the post's text without scraping any platform: the person brings the post.

1. The app shrinks the image on the phone (at most 1800 px on the long edge, JPEG), well under
   Vercel's 4.5 MB request cap.
2. `POST /api/check { image }` has the model (vision) copy only the post's words: no names,
   handles, counts or app buttons. Nothing is checked or saved at this step.
3. The text goes into the post box and the person can fix it before checking. A misread is
   visible before it can reach a verdict.
4. The check is logged with `source: 'screenshot'`. The image is never stored, and only the
   text is saved, as with a paste.

## Known limits

- **Segment figures.** Claims about one business line ("Azure grew 40%", "AI Cloud revenue",
  "ad revenue", "data center") are flagged with a `segment` and come back as "can't be
  checked": the SEC's structured API leaves out segment breakdowns, and a company total is
  never used as evidence for a segment. Checking them means reading the filing itself.
- **Fresh earnings.** Structured data arrives with the 10-Q or 10-K, which can trail the
  earnings press release. The release fills the gap when `ANTHROPIC_API_KEY` is set and its
  figures verify; otherwise the "latest quarter" is the previous one.
- **Fourth quarters.** Companies report the full year, not Q4 alone. Q4 is calculated as the
  full year minus the first three quarters, and labelled as calculated.
- **Companies without SEC revenue data.** Foreign filers that do not report in US GAAP,
  OTC shells and crypto come back as "no filing data".
- **Other dollar figures.** Only revenue and net income are checked as dollar figures. Cash,
  debt and spending come back as "can't be checked". Earnings per share and market value are
  checked through Finnhub when it is connected.
- **Old posts and prices.** "Today" and "this week" mean the post's day (`postedAt`, or the
  date in a copied X author block). Finnhub's free tier has no price history, so a move
  "today" or "this week" is checked only when the post is from the same trading day as the
  price data (a day or three of slack for month, year-to-date and 52-week spans); otherwise
  it comes back as "can't be checked". Pre-market and after-hours moves, spans other than
  1 day, 5 days, month, YTD and 52 weeks, and moves from an all-time high are not checked.
- **EPS growth.** "EPS up 40% YoY" is kept apart from a beat and comes back as "can't be
  checked"; only beats, misses and per-share figures are checked against Finnhub.
- **Short interest.** Still not checked: Finnhub's short-interest data is not on the free tier.
- **Non-GAAP numbers.** Posts often quote "adjusted" profit. Filings are compared on the
  standard (GAAP) figure, so an adjusted number can show as Contradicted.
- **Private companies.** No ticker means no filings. Claims about private companies or leaked documents always come back as "can't be checked".
- **Market and macro data.** Stock prices ("closed down 15.5% at $65.78"), bond prices and
  yields, and Treasury yields or inflation are not in SEC filings. They need a market data
  source (prices) and FRED (rates, inflation).
- **Point-in-time figures.** Backlog (remaining performance obligations), cash and debt are
  reported as of a date, not over a period. The SEC data has them, but the series builder
  only reads period figures so far.
- **Text only.** Screenshots and links are not handled yet.
- **No accounts, rate limits or history.** Add before sharing the URL widely, since each
  check with an LLM key costs money.
- **SEC request rate.** The SEC limits automated traffic. The cache keeps volume low; add
  a throttle before running batch jobs.

## Next sources, in order of value

1. Short interest (FINRA, published twice a month; needs share float from a market data vendor).
2. Corporate events (recent 8-K filings, matched to the claim by the LLM).
3. Insider trades (Form 4).
4. More figures from the same SEC data: earnings per share, cash, debt.
