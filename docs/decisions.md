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

## Known limits

- **Segment figures.** "Revenue up 300%" that is true of one business segment shows as
  Contradicted, not Misleading. The SEC's structured API leaves out segment breakdowns;
  catching this means reading the filing itself.
- **Fresh earnings.** Structured data arrives with the 10-Q or 10-K, which can trail the
  earnings press release. Until then the "latest quarter" is the previous one.
- **Fourth quarters.** Companies report the full year, not Q4 alone. Q4 is calculated as the
  full year minus the first three quarters, and labelled as calculated.
- **Companies without SEC revenue data.** Foreign filers that do not report in US GAAP,
  OTC shells and crypto come back as "no filing data".
- **Other dollar figures.** Only revenue and net income are checked. Cash, debt, earnings per
  share, spending and valuation come back as "can't be checked".
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
