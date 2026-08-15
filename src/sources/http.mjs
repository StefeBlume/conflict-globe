// Gemeinsamer HTTP-Helfer: Browser-UA, Timeout, Retries, curl-Fallback.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ReliefWeb liefert je nach CDN-Knoten mal 200, mal 406 auf denselben Accept-Header.
// Deshalb rotieren wir ueber mehrere Varianten, statt eine "richtige" zu suchen.
const ACCEPT_VARIANTS = [
  'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, text/html;q=0.7',
  'text/html,application/xhtml+xml,application/xml;q=0.9',
  'application/rss+xml, text/xml',
  '*/*',
];

export async function fetchText(url, { timeout = 30000, retries = 3, headers = {} } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': UA,
          Accept: ACCEPT_VARIANTS[attempt % ACCEPT_VARIANTS.length],
          ...headers,
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(600 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }

  // Manche CDNs (z.B. ReliefWeb) lehnen den TLS-/HTTP2-Fingerprint von undici
  // dauerhaft mit HTTP 406 ab, waehrend curl sauber bedient wird.
  try {
    return await curlText(url, timeout);
  } catch {
    throw lastErr;
  }
}

async function curlText(url, timeout = 30000) {
  const { stdout } = await execFileP(
    'curl',
    [
      '-sSL', '--compressed',
      '--max-time', String(Math.ceil(timeout / 1000)),
      '-A', UA,
      '-H', 'Accept: application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, text/html;q=0.7',
      '--fail',
      url,
    ],
    { maxBuffer: 32 * 1024 * 1024, timeout: timeout + 5000 },
  );
  return stdout;
}

export async function fetchJson(url, opts = {}) {
  const text = await fetchText(url, {
    ...opts,
    headers: { Accept: 'application/json, text/plain;q=0.8', ...(opts.headers || {}) },
  });
  try {
    return JSON.parse(text);
  } catch {
    // GDELT antwortet bei Rate-Limits mit Klartext statt JSON.
    throw new Error(`Keine JSON-Antwort: ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
  }
}
