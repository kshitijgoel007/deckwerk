/**
 * Extra fuzz seeds supplied by the environment.
 *
 * The fixed seeds hard-coded in each fuzz suite are the regression corpus: a
 * failure there reproduces anywhere. On top of that, CI's nightly workflow
 * exports `FUZZ_SEED=$(date +%Y%m%d)` so every night also walks a fresh,
 * date-rotated seed — new territory daily, still perfectly reproducible from
 * the failure message. Comma-separated values run several extra seeds at once.
 */
export function extraFuzzSeeds(): number[] {
  const raw = process.env.FUZZ_SEED?.trim();
  if (!raw) return [];
  const seeds = raw
    .split(',')
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((seed) => Number.isFinite(seed));
  return [...new Set(seeds)];
}
