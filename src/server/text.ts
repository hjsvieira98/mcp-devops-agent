const TRUNCATION_MARKER = '\n…[truncated]';

export function truncate(value: string, max: number): { text: string; truncated: boolean } {
  if (max <= 0) return { text: '', truncated: value.length > 0 };
  if (value.length <= max) return { text: value, truncated: false };
  if (max <= 1) return { text: value.slice(0, max), truncated: true };
  if (max <= TRUNCATION_MARKER.length)
    return { text: `${value.slice(0, max - 1)}…`, truncated: true };
  return {
    text: `${value.slice(0, max - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`,
    truncated: true,
  };
}

export function firstLine(value: string, max = 200): string {
  const line = value.split('\n')[0] ?? '';
  return truncate(line, max).text;
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await mapper(item, index);
    }
  });
  await Promise.all(workers);
  return results;
}
