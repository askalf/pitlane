// Loader hook for shebang-register.mjs: a leading `#!` line becomes a `//` comment of the same length.
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (result.format !== 'module' || !result.source) return result;
  const text = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');
  if (!text.startsWith('#!')) return result;
  return { ...result, source: `//${text.slice(2)}` };
}
