// Bangkok's weather, for the village's sky: the current conditions from Open-Meteo, a public
// forecast service that needs no key. The request carries only Bangkok's fixed coordinates —
// nothing about this machine, the map or its owner — and the answer is a handful of numbers.
// Polled every 15 minutes while the server runs; STACKMAP_WEATHER=off turns it off, and the page
// then falls back to a clear sky at Bangkok's local time. Pure parsing plus one small poller.

export const BANGKOK = { lat: 13.7563, lon: 100.5018, timezone: "Asia/Bangkok" };
export const WEATHER_URL = `https://api.open-meteo.com/v1/forecast?latitude=${BANGKOK.lat}&longitude=${BANGKOK.lon}&current=temperature_2m,weather_code,cloud_cover,precipitation,wind_speed_10m,is_day&timezone=${encodeURIComponent(BANGKOK.timezone)}`;

// WMO weather interpretation codes → what the sky should look like.
//   clear · partly · cloudy · fog · drizzle · rain · storm · snow
export function conditionOf(code) {
  if (code === 0 || code === 1) return "clear";
  if (code === 2) return "partly";
  if (code === 3) return "cloudy";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 57) return "drizzle";
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  if (code >= 95 && code <= 99) return "storm";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  return "cloudy";
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const FALLBACK_CLOUD = { clear: 0.08, partly: 0.4, cloudy: 0.85, fog: 0.7, drizzle: 0.8, rain: 0.9, storm: 1, snow: 0.9 };
const FALLBACK_RAIN = { drizzle: 0.25, rain: 0.65, storm: 1 };

// The response of the forecast call as the few numbers the sky uses, or null if it is not one.
export function normalizeWeather(json) {
  const c = json?.current;
  if (!c || typeof c.weather_code !== "number") return null;
  const condition = conditionOf(c.weather_code);
  const cloud = Number.isFinite(c.cloud_cover) ? clamp01(c.cloud_cover / 100) : FALLBACK_CLOUD[condition];
  const rate = Number.isFinite(c.precipitation) ? c.precipitation : 0;
  const rain = condition === "snow" ? 0 : clamp01(Math.max(rate / 4, FALLBACK_RAIN[condition] ?? 0));
  return {
    at: typeof c.time === "string" ? c.time : null, // Bangkok local time, as the service reports it
    tempC: Number.isFinite(c.temperature_2m) ? Math.round(c.temperature_2m) : null,
    code: c.weather_code,
    condition,
    cloud: Math.round(cloud * 100) / 100,
    rain: Math.round(rain * 100) / 100,
    wind: Number.isFinite(c.wind_speed_10m) ? Math.round(c.wind_speed_10m) : 0, // km/h
    isDay: c.is_day === 1,
  };
}

// Reads the service now and every `everyMs`, calling `onChange(weather)` with each good answer. A
// failure keeps the last answer and is tried again next time. Returns a function that stops it.
export function watchWeather({ url = WEATHER_URL, onChange, everyMs = 900_000, fetchImpl = fetch }) {
  const tick = async () => {
    try {
      const res = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return;
      const weather = normalizeWeather(await res.json());
      if (weather) onChange(weather);
    } catch {}
  };
  tick();
  const timer = setInterval(tick, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
