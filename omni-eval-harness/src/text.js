// Pure text utilities: normalization, tokenization, and Word Error Rate (WER).
//
// Dependency-free so the scorers unit-test without a network or a key. The same
// normalization is applied to both the reference and the hypothesis, so any
// edit distance is computed on a level playing field.

/**
 * Normalize a string for content/WER comparison: lowercase, replace every
 * non-alphanumeric run with a single space, and trim. Punctuation, casing, and
 * em-dashes therefore never count as differences.
 */
export function normalize(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Normalize then split into word tokens (empty string -> []). */
export function tokenize(text) {
  const n = normalize(text);
  return n.length === 0 ? [] : n.split(" ");
}

/**
 * Case-insensitive, normalization-aware substring test. Used by `contains` /
 * `not_contains` assertions so "Wednesday" matches "...on wednesday at 10".
 */
export function normalizedIncludes(haystack, needle) {
  return normalize(haystack).includes(normalize(needle));
}

/**
 * Levenshtein edit distance between two token arrays (substitution = insertion
 * = deletion = cost 1). Classic two-row DP, O(n*m) time, O(min) space.
 */
export function editDistance(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost, // substitution / match
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/**
 * Word Error Rate between a reference and a hypothesis string, as a percentage.
 * WER = edits / reference_words * 100. An empty reference yields 0% when the
 * hypothesis is also empty, else 100% (every hypothesis word is an insertion).
 */
export function wer(reference, hypothesis) {
  const ref = tokenize(reference);
  const hyp = tokenize(hypothesis);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 100;
  return (editDistance(ref, hyp) / ref.length) * 100;
}

/**
 * Aggregate WER over many (reference, hypothesis) pairs: total edits divided by
 * total reference words (the standard corpus-level WER, not a mean of per-pair
 * rates, so long utterances are weighted by their length). Returns null when no
 * pair has a reference, i.e. there is nothing to score.
 */
export function aggregateWer(pairs) {
  let edits = 0;
  let refWords = 0;
  let scored = 0;
  for (const { reference, hypothesis } of pairs) {
    const ref = tokenize(reference);
    if (ref.length === 0) continue;
    edits += editDistance(ref, tokenize(hypothesis));
    refWords += ref.length;
    scored += 1;
  }
  if (scored === 0 || refWords === 0) return null;
  return (edits / refWords) * 100;
}
