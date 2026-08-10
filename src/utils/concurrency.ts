/**
 * Map independent work with a fixed upper bound while preserving input order.
 *
 * Unlike batching, workers immediately take the next item when they finish, so
 * one slow item does not hold up the rest of its batch. Mapper rejections are
 * propagated to the caller.
 */
export const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  if (items.length === 0) return [];

  const workerCount = Math.min(
    items.length,
    Math.max(1, Math.floor(Number.isFinite(concurrency) ? concurrency : 1)),
  );
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]!, index);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
};
