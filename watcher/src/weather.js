// Current weather for the user's location, fetched from Open-Meteo.
// No API key required, free tier is fine for personal use.
//
// Cached in-memory for 30 minutes — recommendations don't need fresher
// data than that, and we don't want to hammer the API on rapid requests.
//
// Disabled silently if LOCATION_LAT / LOCATION_LON aren't set in
// watcher/.env. Returns null on any failure (network, parse, missing
// config) so render.js can fall back gracefully — never blocks a
// recommendation on a weather fetch.

const ts = () => new Date().toISOString();
const log = (...a) => console.log(ts(), '[weather]', ...a);
const err = (...a) => console.error(ts(), '[weather]', ...a);

const LAT  = parseFloat(process.env.LOCATION_LAT  || '');
const LON  = parseFloat(process.env.LOCATION_LON  || '');
const NAME = process.env.LOCATION_NAME || '';
const CACHE_MS = 30 * 60 * 1000;

let _cache = null; // { at: number, value: string | null }

// WMO weather code → human phrase. Source: open-meteo.com/en/docs.
function describeCode(code) {
  if (code === 0) return 'clear';
  if (code === 1) return 'mostly clear';
  if (code === 2) return 'partly cloudy';
  if (code === 3) return 'overcast';
  if (code === 45 || code === 48) return 'foggy';
  if (code >= 51 && code <= 55) return 'drizzle';
  if (code === 56 || code === 57) return 'freezing drizzle';
  if (code >= 61 && code <= 65) return 'rain';
  if (code === 66 || code === 67) return 'freezing rain';
  if (code >= 71 && code <= 75) return 'snow';
  if (code === 77) return 'snow grains';
  if (code >= 80 && code <= 82) return 'rain showers';
  if (code === 85 || code === 86) return 'snow showers';
  if (code === 95) return 'thunderstorm';
  if (code === 96 || code === 99) return 'thunderstorm with hail';
  return null;
}

export function isWeatherConfigured() {
  return Number.isFinite(LAT) && Number.isFinite(LON);
}

export async function getWeather() {
  if (!isWeatherConfigured()) return null;
  const now = Date.now();
  if (_cache && now - _cache.at < CACHE_MS) return _cache.value;

  try {
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.searchParams.set('latitude',  String(LAT));
    url.searchParams.set('longitude', String(LON));
    url.searchParams.set('current', 'temperature_2m,weather_code');
    url.searchParams.set('daily',   'temperature_2m_max,temperature_2m_min');
    url.searchParams.set('temperature_unit', 'fahrenheit');
    url.searchParams.set('wind_speed_unit', 'mph');
    url.searchParams.set('timezone', 'auto');
    url.searchParams.set('forecast_days', '1');

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000); // don't hold up the request
    let res;
    try {
      res = await fetch(url, { signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();

    const tNow  = Math.round(j?.current?.temperature_2m);
    const code  = j?.current?.weather_code;
    const tHi   = Math.round(j?.daily?.temperature_2m_max?.[0]);
    const tLo   = Math.round(j?.daily?.temperature_2m_min?.[0]);
    const cond  = describeCode(code);

    if (!Number.isFinite(tNow)) throw new Error('no temperature in response');

    const parts = [`${tNow}°F`];
    if (cond) parts.push(cond);
    if (Number.isFinite(tHi) && Number.isFinite(tLo)) parts.push(`high ${tHi}° / low ${tLo}°`);
    const summary = parts.join(', ');
    const value = NAME ? `${summary} in ${NAME}` : summary;

    _cache = { at: now, value };
    log(`fetched: ${value}`);
    return value;
  } catch (e) {
    err(`fetch failed: ${e?.message || e}`);
    // Cache the failure briefly so a flaky API doesn't slow every request.
    _cache = { at: now, value: null };
    return null;
  }
}
