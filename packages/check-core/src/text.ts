/**
 * Text copied from X, Reddit or a browser often carries link markup and
 * tracking URLs. Strip it so the extractor sees what a reader sees and the
 * app can find each claim's words in the post.
 */
export function cleanPostText(raw: string): string {
  return (
    raw
      // [label](https://...) -> label
      .replace(/\[([^\]]*)\]\((?:https?:\/\/|www\.)[^)\s]*\)/g, '$1')
      // a cashtag on its own line followed by the rest of its sentence: join them
      .replace(/(^|\n)(\$[A-Za-z]{1,5})\s*\n\s*/g, '$1$2 ')
      // lines that are only a URL, a handle, a separator or a timestamp
      .split('\n')
      .map((line) => line.replace(/\s+$/, ''))
      .filter((line) => !/^\s*(https?:\/\/\S+|@\w+|·|\d{1,2}[hm])\s*$/.test(line))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}
