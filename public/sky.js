// The sky over the village, as pure functions: where the sun is in Bangkok at a given moment and
// what the light, the sky colours, the lamps and the weather should look like because of it. No
// DOM, no WebGL — office.js applies the numbers; Node tests them. Angles in radians, elevation
// above the horizon, azimuth clockwise from north.

export const BANGKOK_LAT = 13.7563;
export const BANGKOK_LON = 100.5018;
const RAD = Math.PI / 180;
const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const smooth = (a, b, v) => {
  const t = clamp((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const lerp = (a, b, t) => a + (b - a) * t;

// Bangkok is UTC+7 all year; the clock the village keeps.
export function bangkokClock(date) {
  const t = new Date(date.getTime() + 7 * 3600_000);
  const hour = t.getUTCHours() + t.getUTCMinutes() / 60;
  const pad = (n) => String(n).padStart(2, "0");
  return { hour, label: `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`, day: `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}` };
}
// The same Bangkok day as `date`, at the given hour (0–24).
export function atBangkokHour(date, hour) {
  const t = new Date(date.getTime() + 7 * 3600_000);
  t.setUTCHours(0, 0, 0, 0);
  return new Date(t.getTime() + hour * 3600_000 - 7 * 3600_000);
}

// The sun's place in the sky (the usual low-precision solar formulas: good to a fraction of a degree).
export function sunPosition(date, lat = BANGKOK_LAT, lon = BANGKOK_LON) {
  const n = date.getTime() / 86_400_000 + 2440587.5 - 2451545.0; // days since J2000
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * RAD;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const eps = (23.439 - 0.0000004 * n) * RAD;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
  const H = (((gmst * 15 + lon) * RAD - ra) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI); // hour angle
  const phi = lat * RAD;
  const elevation = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  const azimuth = (Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi)) + Math.PI) % (2 * Math.PI);
  return { elevation, azimuth };
}

// ---------- colour ----------

const hex = (c) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
export function mix(a, b, t) {
  const [p, q] = [hex(a), hex(b)];
  return `#${p.map((v, i) => Math.round(lerp(v, q[i], clamp(t))).toString(16).padStart(2, "0")).join("")}`;
}

const SKY = {
  night: ["#0b1030", "#243062"],
  dusk: ["#5d6fb8", "#ffb48a"],
  day: ["#8fcbef", "#ffe9d2"],
  grey: ["#9aa8b5", "#d4d9dd"],
  storm: ["#4d5866", "#808b97"],
};

// What the sky and the light should be. `weather` is { cloud, rain, condition } (all optional, a
// clear sky if missing). Everything is smooth in the sun's elevation, so a slider or the clock
// moves it without jumps.
export function skyState({ elevation, azimuth = Math.PI, weather = {} }) {
  const deg = elevation / RAD;
  const cloud = clamp(weather.cloud ?? 0);
  const rain = clamp(weather.rain ?? 0);
  const condition = weather.condition ?? "clear";
  const day = smooth(-6, 14, deg);            // 0 in the night, 1 in full day
  const warmth = 1 - clamp(Math.abs(deg - 4) / 11); // 1 at sunrise and sunset
  const gloom = clamp(cloud * 0.55 + rain * 0.4 + (condition === "storm" ? 0.35 : 0));

  let top = mix(SKY.night[0], SKY.day[0], day);
  let bottom = mix(SKY.night[1], SKY.day[1], day);
  top = mix(top, SKY.dusk[0], warmth * 0.75 * (1 - cloud * 0.5));
  bottom = mix(bottom, SKY.dusk[1], warmth * 0.9 * (1 - cloud * 0.5));
  const grey = condition === "storm" ? SKY.storm : SKY.grey;
  // a heavy sky pulls the colours towards grey by day and towards a darker night by night
  top = mix(top, mix(SKY.night[0], grey[0], day), gloom);
  bottom = mix(bottom, mix(SKY.night[1], grey[1], day), gloom);

  // the dominant light: the sun, handing over to the moon after dark
  const sunUp = deg > -4;
  const moonElevation = Math.max(28 * RAD, -elevation);
  const lightElevation = sunUp ? Math.max(elevation, 6 * RAD) : moonElevation;
  const lightAzimuth = sunUp ? azimuth : (azimuth + Math.PI) % (2 * Math.PI);
  const lightColor = sunUp ? mix("#ffb26b", "#fff1d6", smooth(2, 26, deg)) : "#a9bcff";
  const sunPower = 2.1 * day * (1 - cloud * 0.6 - rain * 0.15) + 0.25 * warmth * (1 - cloud);
  const moonPower = 0.6 * (1 - day) * (1 - cloud * 0.5);

  return {
    elevation, azimuth,
    day, night: 1 - day, warmth, gloom,
    skyTop: top, skyBottom: bottom,
    lightColor, lightPower: Math.max(0.02, sunPower + moonPower), lightElevation, lightAzimuth,
    hemiSky: mix("#33417a", "#cfe6ff", day), hemiGround: mix("#1a1730", "#f3dcb5", day), hemiPower: lerp(0.32, 0.95, day) * (1 - gloom * 0.25),
    ambientPower: lerp(0.18, 0.35, day),
    lamps: clamp(1 - day * 1.7),                     // street lamps and windows come on at dusk
    stars: clamp((1 - day) ** 2 * (1 - cloud * 0.85)),
    cloud, rain, fog: condition === "fog" ? 0.7 : 0, storm: condition === "storm",
  };
}
