import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const root = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(root));

const KMA_SEA_OBS_URL = 'https://apihub.kma.go.kr/api/typ01/url/sea_obs.php';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const MARINE_URL = 'https://marine-api.open-meteo.com/v1/marine';
const SEA_OBS_TTL = 300_000;
const WEATHER_TTL = 300_000;
const MAX_STATION_DISTANCE_KM = 80;

const cache = new Map();

function cached(key, ttl, producer) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  return Promise.resolve()
    .then(producer)
    .then(value => {
      cache.set(key, { at: Date.now(), value });
      return value;
    });
}

// KMA uses -99 / -99.0 as the missing-value marker.
const number = value => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > -90 ? Math.round(parsed * 100) / 100 : null;
};

const kmaTime = stamp => (/^\d{12}$/.test(stamp)
  ? `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:00+09:00`
  : null);

function parseSeaObs(text) {
  return text.split('\n').flatMap(line => {
    const cells = line.trim().split(',').map(cell => cell.trim());
    if (line.startsWith('#') || cells.length < 14) return [];
    const lng = Number.parseFloat(cells[4]);
    const lat = Number.parseFloat(cells[5]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
    return [{
      id: cells[2], name: cells[3], kind: cells[0], lat, lng,
      observedAt: kmaTime(cells[1]),
      wave: number(cells[6]), windDir: number(cells[7]), wind: number(cells[8]),
      gust: number(cells[9]), waterTemp: number(cells[10]), airTemp: number(cells[11]),
    }];
  });
}

async function seaStations() {
  if (!process.env.KMA_API_KEY) throw new Error('KMA_API_KEY is not configured');
  const url = new URL(KMA_SEA_OBS_URL);
  url.searchParams.set('authKey', process.env.KMA_API_KEY);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`KMA returned ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const text = buffer.toString('utf8').includes('\uFFFD') || !/[가-힣]/.test(buffer.toString('utf8'))
    ? buffer.toString('euc-kr')
    : buffer.toString('utf8');
  if (text.trim().startsWith('{')) throw new Error(`KMA rejected the request: ${text.trim().slice(0, 160)}`);
  const stations = parseSeaObs(text);
  if (!stations.length) throw new Error('KMA returned no marine observations');
  return stations;
}

const getSeaStations = () => cached('sea_obs', SEA_OBS_TTL, seaStations);

function haversine(lat1, lng1, lat2, lng2) {
  const toRad = value => (value * Math.PI) / 180;
  const dPhi = toRad(lat2 - lat1);
  const dLambda = toRad(lng2 - lng1);
  const a = Math.sin(dPhi / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLambda / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

function nearest(stations, lat, lng, field) {
  let best = null;
  for (const station of stations) {
    if (station[field] === null || station[field] === undefined) continue;
    const distance = haversine(lat, lng, station.lat, station.lng);
    if (distance > MAX_STATION_DISTANCE_KM) continue;
    if (!best || distance < best.distance) best = { station, distance };
  }
  return best;
}

async function openMeteoWeather(lat, lng) {
  const url = new URL(FORECAST_URL);
  url.searchParams.set('latitude', lat);
  url.searchParams.set('longitude', lng);
  url.searchParams.set('current', 'precipitation,rain,wind_speed_10m,wind_direction_10m');
  url.searchParams.set('wind_speed_unit', 'ms');
  url.searchParams.set('timezone', 'Asia/Seoul');
  const current = (await (await fetch(url)).json()).current ?? {};
  return {
    observedAt: current.time ?? null,
    rain: number(current.precipitation),
    wind: number(current.wind_speed_10m),
    windDir: number(current.wind_direction_10m),
  };
}

async function openMeteoWave(lat, lng) {
  const url = new URL(MARINE_URL);
  url.searchParams.set('latitude', lat);
  url.searchParams.set('longitude', lng);
  url.searchParams.set('current', 'wave_height');
  const current = (await (await fetch(url)).json()).current ?? {};
  return { observedAt: current.time ?? null, wave: number(current.wave_height) };
}

async function buildWeather(lat, lng) {
  const result = {
    ok: false, lat, lng,
    fetchedAt: new Date().toISOString(),
    sources: [], marine: {}, rain: null, errors: [],
  };

  let stations = null;
  try {
    stations = await getSeaStations();
    result.sources.push('kma.sea_obs');
  } catch (error) {
    result.errors.push(`sea_obs: ${error.message}`);
  }

  if (stations) {
    const wave = nearest(stations, lat, lng, 'wave');
    if (wave) {
      result.marine.wave = {
        value: wave.station.wave, unit: 'm', station: wave.station.name,
        stationId: wave.station.id, distanceKm: Math.round(wave.distance * 10) / 10,
        observedAt: wave.station.observedAt,
      };
    }
    const wind = nearest(stations, lat, lng, 'wind');
    if (wind) {
      result.marine.wind = {
        value: wind.station.wind, gust: wind.station.gust, dir: wind.station.windDir,
        unit: 'm/s', station: wind.station.name, stationId: wind.station.id,
        distanceKm: Math.round(wind.distance * 10) / 10, observedAt: wind.station.observedAt,
      };
    }
  }

  let openMeteo = null;
  try {
    openMeteo = await cached(`om:${lat.toFixed(3)}:${lng.toFixed(3)}`, WEATHER_TTL, () => openMeteoWeather(lat, lng));
    result.sources.push('open-meteo');
    result.rain = { value: openMeteo.rain, unit: 'mm', window: '1h', observedAt: openMeteo.observedAt };
  } catch (error) {
    result.errors.push(`open-meteo: ${error.message}`);
  }

  if (!result.marine.wave) {
    try {
      const model = await cached(`omw:${lat.toFixed(3)}:${lng.toFixed(3)}`, WEATHER_TTL, () => openMeteoWave(lat, lng));
      result.marine.wave = {
        value: model.wave, unit: 'm', station: 'Open-Meteo 해양모델',
        stationId: null, distanceKm: 0, observedAt: model.observedAt, modelled: true,
      };
      result.errors.push('wave: KMA 파고 관측 없음 → 모델값 대체');
    } catch (error) {
      result.errors.push(`open-meteo-marine: ${error.message}`);
    }
  }

  if (!result.marine.wind && openMeteo?.wind !== null && openMeteo?.wind !== undefined) {
    result.marine.wind = {
      value: openMeteo.wind, gust: null, dir: openMeteo.windDir,
      unit: 'm/s', station: 'Open-Meteo 10m', stationId: null,
      distanceKm: 0, observedAt: openMeteo.observedAt, modelled: true,
    };
  }

  result.ok = Boolean(Object.keys(result.marine).length || result.rain);
  return result;
}

// Browser receives only the Kakao JavaScript key. The KMA key remains server-side.
app.get('/api/config', (_req, res) => res.json({ kakaoMapAppKey: process.env.KAKAO_MAP_APP_KEY || null }));

app.get('/api/marine-obs', async (_req, res) => {
  try {
    const stations = await getSeaStations();
    res.json({ source: 'kma.sea_obs', count: stations.length, stations });
  } catch (error) {
    res.status(502).json({ error: 'KMA sea observation failed', detail: error.message });
  }
});

app.get('/api/weather', async (req, res) => {
  const lat = Number.parseFloat(req.query.lat);
  const lng = Number.parseFloat(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: 'lat and lng are required numbers' });
  }
  try {
    res.json(await buildWeather(lat, lng));
  } catch (error) {
    res.status(502).json({ error: 'weather aggregation failed', detail: error.message });
  }
});

app.get('/api/marine-status', async (req, res) => {
  const station = String(req.query.station || '').trim();
  if (!station) return res.status(400).json({ error: 'station is required' });
  try {
    const stations = await getSeaStations();
    const match = stations.find(item => item.id === station);
    if (!match) return res.status(404).json({ error: 'unknown station', station });
    res.json({ source: 'kma.sea_obs', station, observation: match });
  } catch (error) {
    res.status(502).json({ error: 'KMA sea observation failed', detail: error.message });
  }
});

app.listen(process.env.PORT || 3000, () => console.log(`Safety dashboard: http://localhost:${process.env.PORT || 3000}`));
