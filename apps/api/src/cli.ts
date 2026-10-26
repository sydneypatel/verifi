import { DEMO_POST } from '@hypecheck/check-core/fixtures';
import { createChecker } from './checker';
import { loadEnv } from './env';

// Check a post from the terminal, with no interface in the way:
//   npm run check -- "\$AAPL revenue is up 300% this quarter"
//   npm run check:demo            (made-up company, no network, no keys)
//   npm run check -- --json "..."  (raw CheckResult)

loadEnv();

const args = process.argv.slice(2);
const fixtures = args.includes('--fixtures');
const asJson = args.includes('--json');
const text = args.filter((a) => !a.startsWith('--')).join(' ') || (fixtures ? DEMO_POST : '');

if (!text) {
  console.error('Usage: npm run check -- "<post text>"');
  process.exit(1);
}

const LABELS = { holds_up: 'HOLDS UP', misleading: 'MISLEADING', contradicted: 'CONTRADICTED', cant_check: "CAN'T CHECK" };

try {
  const checker = createChecker({ fixtures, env: process.env });
  const { result } = await checker.check(text, { source: 'cli' });

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\n${result.ticker ?? 'No ticker'}${result.entityName ? ` · ${result.entityName}` : ''}   (${checker.describe()})`);
    console.log(`${result.summary.holdsUp} of ${result.summary.checkable} checkable claims hold up (${result.summary.total} found)\n`);
    for (const { claim, verdict, reason, evidence } of result.claims) {
      console.log(`[${LABELS[verdict]}] "${claim.quote}"`);
      console.log(`    ${reason}`);
      for (const row of evidence?.figures ?? []) console.log(`      ${row.label.padEnd(44)} ${row.value}`);
      if (evidence) console.log(`    Source: ${evidence.citation.label}  ${evidence.citation.url}`);
      console.log('');
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
