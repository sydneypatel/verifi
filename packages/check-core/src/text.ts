// Text copied from X, Reddit or a browser carries link markup, an author block,
// and inline links ($TICKER, @handle) broken onto lines of their own. Clean it
// so the extractor reads what a person reads, and so the app can find each
// claim's exact words in the post.

const LINK = /\[([^\]]*)\]\((?:https?:\/\/|www\.)[^)\s]*\)/g;
const TIMESTAMP = /^(\d{1,2}[smhd]|[A-Z][a-z]{2} \d{1,2}(, \d{4})?)$/;
const INLINE_TOKEN = /^[$@][A-Za-z_][\w.]*$/;
const NOISE_LINE = /^(https?:\/\/\S+|·)$/;

export function cleanPostText(raw: string): string {
  let lines = raw.replace(/\r\n?/g, '\n').replace(LINK, '$1').split('\n');

  // The author block X puts above a copied post: name, @handle, "·", "17h".
  const stamp = lines.slice(0, 6).findIndex((l) => TIMESTAMP.test(l.trim()));
  if (stamp !== -1 && lines.slice(0, stamp).some((l) => /^@\w+$/.test(l.trim()))) {
    lines = lines.slice(stamp + 1);
  }

  // Rejoin sentences around an inline $TICKER or @handle. A trailing space on
  // the line before means the link sat mid-sentence; otherwise it starts a line.
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const token = line.trim();
    if (!INLINE_TOKEN.test(token)) {
      out.push(line);
      continue;
    }
    const next = lines[i + 1];
    let joined = token;
    if (next !== undefined && next.trim() && (/^\s/.test(next) || /^[,.;:!?)'’]/.test(next))) {
      joined += (/^[,.;:!?)'’]/.test(next) ? '' : ' ') + next.replace(/^\s+/, '');
      i++;
    }
    const prev = out.at(-1);
    if (prev !== undefined && prev.trim() && /\s$/.test(prev)) out[out.length - 1] = prev.replace(/\s+$/, '') + ' ' + joined;
    else out.push(joined);
  }

  return out
    .map((l) => l.trim())
    .filter((l) => !NOISE_LINE.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
