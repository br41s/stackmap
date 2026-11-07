// The sky over the village: where the sun is in Bangkok, what the light does with it, and how
// the weather service's answer is read (lib/weather.mjs). Pure functions, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BANGKOK, WEATHER_URL, conditionOf, normalizeWeather, watchWeather } from "../lib/weather.mjs";
import { atBangkokHour, bangkokClock, mix, skyState, sunPosition } from "../public/sky.js";

const DEG = 180 / Math.PI;
const day = new Date("2026-03-20T00:00:00+07:00"); // the equinox: the sun passes almost overhead at noon
const at = (hour, date = day) => atBangkokHour(date, hour);

test("Bangkok keeps UTC+7, and a Bangkok hour is the same day's hour", () => {
  assert.deepEqual(bangkokClock(new Date("2026-11-07T02:15:00Z")), { hour: 9.25, label: "09:15", day: "2026-11-07" });
  assert.equal(bangkokClock(new Date("2026-11-07T18:30:00Z")).day, "2026-11-08"); // past midnight there
  assert.equal(bangkokClock(at(15.5)).label, "15:30");
  assert.equal(bangkokClock(at(15.5, new Date("2026-06-01T20:00:00Z"))).day, "2026-06-02");
});

test("the sun rises in the east, crosses the south at noon and sets in the west", () => {
  const noon = sunPosition(at(12.4)); // solar noon in Bangkok is a little after the clock's (it is west of its time zone's meridian)
  assert.ok(Math.abs(noon.elevation * DEG - 76.2) < 1.5, `noon elevation ${noon.elevation * DEG}`);
  assert.ok(Math.abs(noon.azimuth * DEG - 180) < 15, `noon azimuth ${noon.azimuth * DEG}`);
  const morning = sunPosition(at(8));
  const evening = sunPosition(at(16));
  assert.ok(morning.azimuth * DEG < 120 && morning.elevation > 0.3, "morning: east, climbing");
  assert.ok(evening.azimuth * DEG > 240 && evening.elevation > 0.3, "afternoon: west, falling");
  assert.ok(sunPosition(at(0)).elevation < 0 && sunPosition(at(3)).elevation < 0, "night");
  assert.ok(Math.abs(sunPosition(at(6.2)).elevation * DEG) < 6, "sunrise is about six");
  assert.ok(Math.abs(sunPosition(at(18.3)).elevation * DEG) < 6, "sunset is about six in the evening");
});

test("the year changes the noon sun: higher in the rainy season than in December", () => {
  const june = sunPosition(at(12, new Date("2026-06-21T05:00:00Z"))).elevation;
  const december = sunPosition(at(12, new Date("2026-12-21T05:00:00Z"))).elevation;
  assert.ok(june > december);
});

test("the light follows the sun: bright by day, warm at the edges, dim and blue at night", () => {
  const sky = (hour, weather) => skyState({ ...sunPosition(at(hour)), weather });
  const [noon, dusk, midnight] = [sky(12), sky(18.2), sky(0)];
  assert.ok(noon.day > 0.95 && midnight.day === 0 && dusk.day > 0 && dusk.day < noon.day);
  assert.ok(noon.lightPower > 1.5 && midnight.lightPower < 0.7 && midnight.lightPower > 0.2, "the moon still lights the night");
  assert.ok(dusk.warmth > 0.6 && noon.warmth < 0.2 && midnight.warmth === 0);
  assert.ok(midnight.lamps === 1 && noon.lamps === 0 && midnight.stars > 0.9 && noon.stars === 0);
  assert.notEqual(noon.skyTop, midnight.skyTop);
  assert.ok(midnight.lightElevation > 0.4, "the moon is above the horizon whenever it lights the night");
  assert.equal(noon.lightColor, "#fff1d6");
  assert.ok(dusk.lightColor !== noon.lightColor && midnight.lightColor === "#a9bcff");
});

test("cloud and rain dim the sun and grey the sky; a clear sky is the reference", () => {
  const clear = skyState({ ...sunPosition(at(12)) });
  const rainy = skyState({ ...sunPosition(at(12)), weather: { cloud: 0.95, rain: 0.8, condition: "rain" } });
  const storm = skyState({ ...sunPosition(at(12)), weather: { cloud: 1, rain: 1, condition: "storm" } });
  assert.ok(rainy.lightPower < clear.lightPower * 0.7 && storm.lightPower <= rainy.lightPower);
  assert.ok(rainy.gloom > 0.5 && storm.gloom > rainy.gloom && clear.gloom === 0);
  assert.notEqual(rainy.skyTop, clear.skyTop);
  const lum = (c) => parseInt(c.slice(1, 3), 16) + parseInt(c.slice(3, 5), 16) + parseInt(c.slice(5, 7), 16);
  assert.ok(lum(storm.skyTop) > 250, "a storm by day is a grey sky, not a night"); // regression: it once turned dark navy
  assert.ok(rainy.rain === 0.8 && storm.storm && !clear.storm);
  assert.equal(skyState({ ...sunPosition(at(12)), weather: { condition: "fog" } }).fog, 0.7);
});

test("moving the clock never makes the light jump", () => {
  let prev = skyState(sunPosition(at(0)));
  for (let h = 0.1; h <= 24; h += 0.1) {
    const s = skyState(sunPosition(at(h)));
    assert.ok(Math.abs(s.lightPower - prev.lightPower) < 0.35, `power jumps at ${h}`);
    assert.ok(Math.abs(s.day - prev.day) < 0.15, `day jumps at ${h}`);
    prev = s;
  }
  assert.equal(mix("#000000", "#ffffff", 0.5), "#808080");
  assert.equal(mix("#102030", "#102030", 0.7), "#102030");
});

test("weather codes become a condition", () => {
  assert.deepEqual([0, 1, 2, 3, 45, 53, 63, 81, 95, 99, 73].map(conditionOf), ["clear", "clear", "partly", "cloudy", "fog", "drizzle", "rain", "rain", "storm", "storm", "snow"]);
  assert.equal(conditionOf(1234), "cloudy"); // an unknown code is not a clear sky
});

test("the service's answer is read, or refused", () => {
  const reply = { current: { time: "2026-11-07T09:15", temperature_2m: 28.9, weather_code: 3, cloud_cover: 86, precipitation: 0, wind_speed_10m: 4.5, is_day: 1 } };
  assert.deepEqual(normalizeWeather(reply), { at: "2026-11-07T09:15", tempC: 29, code: 3, condition: "cloudy", cloud: 0.86, rain: 0, wind: 5, isDay: true });
  const storm = normalizeWeather({ current: { weather_code: 95, precipitation: 6.2, is_day: 0 } });
  assert.equal(storm.condition, "storm");
  assert.equal(storm.rain, 1);
  assert.equal(storm.cloud, 1); // no cloud figure: the code says storm
  assert.equal(storm.isDay, false);
  assert.equal(normalizeWeather({ current: { weather_code: 61, cloud_cover: 90, precipitation: 0 } }).rain, 0.65); // rain code, no rate yet
  assert.equal(normalizeWeather({}), null);
  assert.equal(normalizeWeather({ current: { weather_code: "x" } }), null);
  assert.equal(normalizeWeather(null), null);
});

test("the request names only Bangkok; a failed read keeps the last answer", async () => {
  assert.match(WEATHER_URL, /^https:\/\/api\.open-meteo\.com\//);
  assert.match(WEATHER_URL, new RegExp(`latitude=${BANGKOK.lat}&longitude=${BANGKOK.lon}`));
  assert.equal(new URL(WEATHER_URL).search.match(/key|token|user/i), null);
  const seen = [];
  let calls = 0;
  const fetchImpl = async () => {
    if (++calls === 2) throw new Error("offline");
    return { ok: true, json: async () => ({ current: { weather_code: 0, cloud_cover: calls * 10 } }) };
  };
  const stop = watchWeather({ onChange: (w) => seen.push(w.cloud), everyMs: 20, fetchImpl });
  await new Promise((r) => setTimeout(r, 110));
  stop();
  assert.ok(seen.length >= 2 && seen[0] === 0.1, "reads on start, and goes on after a failure");
});
