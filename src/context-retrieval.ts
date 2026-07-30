export type ContextRetrievalOptions = {
  /** A concrete question, keywords, or the lead's stated context need. */
  query?: string;
  /** Maximum number of matching messages (or newest messages without a query). */
  matchLimit: number;
  /** Messages to retain on each side of a match. */
  contextMessages: number;
  /** Strict output budget; transcript input never becomes tool output wholesale. */
  maxChars: number;
};

type RankedBlock = { index: number; score: number };

function splitTranscript(transcript: string): string[] {
  return transcript.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
}

function tokens(value: string): string[] {
  return value.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
}

/** A compact stemmer for common English variants in coding transcripts. */
function stem(token: string): string {
  if (token.length <= 4) return token;
  if (token.endsWith("ies") && token.length > 5) return `${token.slice(0, -3)}y`;
  if (token.endsWith("ing") && token.length > 6) return token.slice(0, -3);
  if (token.endsWith("ed") && token.length > 5) return token.slice(0, -2);
  if (token.endsWith("es") && token.length > 5) return token.slice(0, -2);
  if (token.endsWith("s") && token.length > 4) return token.slice(0, -1);
  return token;
}

function scoreBlock(block: string, queryTerms: string[]): number {
  const blockTokens = tokens(block);
  let score = 0;
  const positions: number[] = [];

  for (const term of queryTerms) {
    const termStem = stem(term);
    for (let index = 0; index < blockTokens.length; index += 1) {
      const token = blockTokens[index];
      const exact = token === term;
      const stemmed = stem(token) === termStem;
      const substring = term.length >= 4 && (token.includes(term) || term.includes(token));
      if (!exact && !stemmed && !substring) continue;
      positions.push(index);
      score += exact ? 3 : stemmed ? 2 : 0.75;
    }
  }

  if (positions.length > 1) {
    const span = Math.max(...positions) - Math.min(...positions);
    score += 1 / (1 + span / Math.max(1, queryTerms.length));
  }
  return score;
}

function formatWithinBudget(blocks: string[], selected: Set<number>, ranked: RankedBlock[], maxChars: number): string {
  const truncationPrefix = `[truncated to ${maxChars} characters]\n`;
  const preferred = [...ranked.map(({ index }) => index), ...selected].filter(
    (index, position, all) => all.indexOf(index) === position,
  );
  const included = new Set<number>();
  let used = 0;

  for (const index of preferred) {
    const block = blocks[index];
    const separator = included.size === 0 ? 0 : 2;
    if (used + separator + block.length > maxChars) continue;
    included.add(index);
    used += separator + block.length;
  }
  if (included.size === 0) {
    const first = blocks[preferred[0]] ?? "";
    return `${truncationPrefix}${first.slice(0, Math.max(0, maxChars - truncationPrefix.length))}`;
  }

  const result = [...included].sort((left, right) => left - right).map((index) => blocks[index]).join("\n\n");
  return included.size === selected.size ? result : `${truncationPrefix}${result.slice(0, maxChars - truncationPrefix.length)}`;
}

/**
 * Context Mode-compatible local retrieval. It performs token, stem, substring,
 * and proximity ranking in-process for one supplied transcript only. It never
 * reaches into Context Mode's private persistent index or SQLite database.
 */
export function selectRelevantTranscriptContext(transcript: string, options: ContextRetrievalOptions): string {
  const blocks = splitTranscript(transcript);
  if (blocks.length === 0) return "(transcript is empty)";

  const queryTerms = tokens(options.query ?? "");
  if (queryTerms.length === 0) {
    const latest = new Set<number>();
    for (let index = Math.max(0, blocks.length - options.matchLimit); index < blocks.length; index += 1) latest.add(index);
    return formatWithinBudget(blocks, latest, [], options.maxChars);
  }

  const ranked = blocks
    .map((block, index) => ({ index, score: scoreBlock(block, queryTerms) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || right.index - left.index)
    .slice(0, options.matchLimit);
  if (ranked.length === 0) {
    const prefix = "(no transcript messages matched query: ";
    const suffix = ")";
    const message = `${prefix}${(options.query ?? "").slice(0, Math.max(0, options.maxChars - prefix.length - suffix.length))}${suffix}`;
    return message.slice(0, options.maxChars);
  }

  const selected = new Set<number>();
  for (const match of ranked) {
    for (
      let index = Math.max(0, match.index - options.contextMessages);
      index <= Math.min(blocks.length - 1, match.index + options.contextMessages);
      index += 1
    ) selected.add(index);
  }
  return formatWithinBudget(blocks, selected, ranked, options.maxChars);
}
