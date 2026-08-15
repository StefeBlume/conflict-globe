// ACLED (Armed Conflict Location & Event Data) - optional, benoetigt kostenlosen Key.
// Registrierung: https://developer.acleddata.com/  ->  ACLED_KEY + ACLED_EMAIL in .env
import { fetchJson } from './http.mjs';

const BASE = 'https://api.acleddata.com/acled/read';

export function acledConfigured() {
  return Boolean(process.env.ACLED_KEY && process.env.ACLED_EMAIL);
}

/** Ereigniszaehlung der letzten N Tage pro Land - liefert eine harte Intensitaetskennzahl. */
export async function acledEvents(country, days = 7) {
  if (!acledConfigured()) return null;
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const url =
    `${BASE}?key=${encodeURIComponent(process.env.ACLED_KEY)}` +
    `&email=${encodeURIComponent(process.env.ACLED_EMAIL)}` +
    `&country=${encodeURIComponent(country)}` +
    `&event_date=${since}&event_date_where=>%3D&limit=2000&fields=event_date|event_type|fatalities|admin1|notes`;
  try {
    const data = await fetchJson(url, { timeout: 40000, retries: 1 });
    const rows = Array.isArray(data.data) ? data.data : [];
    const fatalities = rows.reduce((s, r) => s + (parseInt(r.fatalities, 10) || 0), 0);
    const byRegion = {};
    for (const r of rows) {
      if (!r.admin1) continue;
      byRegion[r.admin1] = (byRegion[r.admin1] || 0) + 1;
    }
    const topRegions = Object.entries(byRegion)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => ({ name, count }));
    return { events: rows.length, fatalities, days, topRegions };
  } catch (err) {
    return { error: String(err.message || err) };
  }
}
