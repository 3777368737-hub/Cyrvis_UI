export type SearchEngine = 'bing' | 'baidu' | 'google';
const SEARCH_ENDPOINTS: Record<SearchEngine, string> = {
  bing: 'https://www.bing.com/search?q=',
  baidu: 'https://www.baidu.com/s?wd=',
  google: 'https://www.google.com/search?q=',
};

export const assertHttpUrl = (value: string): URL => {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http/https URLs are allowed');
  }
  return url;
};

export const buildSearchUrl = (
  query: string,
  engine: SearchEngine = 'bing',
  site?: string,
): string => {
  const trimmed = query.trim();
  if (!trimmed) {
    throw new Error('search query is empty');
  }
  const normalizedSite = site?.trim().replace(/^https?:\/\//i, '');
  if (normalizedSite && !/^[A-Za-z0-9.-]+$/.test(normalizedSite)) {
    throw new Error(`invalid site filter: ${site}`);
  }
  const fullQuery = normalizedSite
    ? `${trimmed} site:${normalizedSite}`
    : trimmed;
  return `${SEARCH_ENDPOINTS[engine]}${encodeURIComponent(fullQuery)}`;
};

/**
 * Windows uses Bing; macOS uses Safari's default search engine. The caller can
 * still override the engine explicitly.
 */
export const defaultSearchEngine = (): SearchEngine =>
  process.platform === 'darwin' ? 'google' : 'bing';
