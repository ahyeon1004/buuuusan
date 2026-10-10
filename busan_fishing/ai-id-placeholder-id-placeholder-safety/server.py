"""Dependency-free local server for the dashboard.
Run: python3 server.py  then open http://localhost:3000

Weather sources
  - KMA APIHub sea_obs.php : wave height / wind (this key is only approved for 해양관측)
  - Open-Meteo             : rainfall (KMA 단기예보/지상관측 key approval is still pending)
"""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen
import json
import math
import os
import threading
import time

ROOT = Path(__file__).resolve().parent

KMA_SEA_OBS_URL = 'https://apihub.kma.go.kr/api/typ01/url/sea_obs.php'
FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'
MARINE_URL = 'https://marine-api.open-meteo.com/v1/marine'

SEA_OBS_TTL = 300
WEATHER_TTL = 300
MAX_STATION_DISTANCE_KM = 80
HTTP_TIMEOUT = 15

_cache = {}
_cache_lock = threading.Lock()


def load_env():
    env_path = ROOT / '.env'
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            key, value = line.split('=', 1)
            os.environ.setdefault(key.strip(), value.strip())


load_env()


def fetch_bytes(url, timeout=HTTP_TIMEOUT):
    request = Request(url, headers={'User-Agent': 'busan-breakwater-dashboard/1.0'})
    with urlopen(request, timeout=timeout) as response:
        return response.read()


def fetch_json(url, timeout=HTTP_TIMEOUT):
    return json.loads(fetch_bytes(url, timeout).decode('utf-8'))


def cached(key, ttl, producer):
    now = time.time()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < ttl:
            return hit[1]
    value = producer()
    with _cache_lock:
        _cache[key] = (time.time(), value)
    return value


def number(value):
    """KMA uses -99 / -99.0 as the missing-value marker."""
    try:
        parsed = float(str(value).strip())
    except (TypeError, ValueError):
        return None
    return None if parsed <= -90 else round(parsed, 2)


def kma_time(value):
    stamp = str(value).strip()
    if len(stamp) != 12 or not stamp.isdigit():
        return None
    return f'{stamp[:4]}-{stamp[4:6]}-{stamp[6:8]}T{stamp[8:10]}:{stamp[10:12]}:00+09:00'


def decode_sea_obs(raw):
    for encoding in ('utf-8', 'cp949', 'euc-kr'):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode('utf-8', errors='replace')


def parse_sea_obs(text):
    stations = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        cells = [cell.strip() for cell in line.split(',')]
        if len(cells) < 14:
            continue
        try:
            lat, lng = float(cells[5]), float(cells[4])
        except ValueError:
            continue
        stations.append({
            'id': cells[2],
            'name': cells[3],
            'kind': cells[0],
            'lat': lat,
            'lng': lng,
            'observedAt': kma_time(cells[1]),
            'wave': number(cells[6]),
            'windDir': number(cells[7]),
            'wind': number(cells[8]),
            'gust': number(cells[9]),
            'waterTemp': number(cells[10]),
            'airTemp': number(cells[11]),
        })
    return stations


def sea_stations():
    def load():
        key = os.getenv('KMA_API_KEY')
        if not key:
            raise RuntimeError('KMA_API_KEY is not configured')
        text = decode_sea_obs(fetch_bytes(f'{KMA_SEA_OBS_URL}?{urlencode({"authKey": key})}'))
        if text.lstrip().startswith('{'):
            raise RuntimeError(f'KMA rejected the request: {text.strip()[:160]}')
        stations = parse_sea_obs(text)
        if not stations:
            raise RuntimeError('KMA returned no marine observations')
        return stations

    return cached('sea_obs', SEA_OBS_TTL, load)


def haversine(lat1, lng1, lat2, lng2):
    radius = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(a))


def nearest(stations, lat, lng, field):
    best = None
    for station in stations:
        if station.get(field) is None:
            continue
        distance = haversine(lat, lng, station['lat'], station['lng'])
        if distance > MAX_STATION_DISTANCE_KM:
            continue
        if best is None or distance < best[1]:
            best = (station, distance)
    return best


def open_meteo_weather(lat, lng):
    def load():
        query = urlencode({
            'latitude': lat,
            'longitude': lng,
            'current': 'precipitation,rain,wind_speed_10m,wind_direction_10m',
            'wind_speed_unit': 'ms',
            'timezone': 'Asia/Seoul',
        })
        current = fetch_json(f'{FORECAST_URL}?{query}').get('current', {})
        return {
            'observedAt': current.get('time'),
            'rain': number(current.get('precipitation')),
            'wind': number(current.get('wind_speed_10m')),
            'windDir': number(current.get('wind_direction_10m')),
        }

    return cached(f'om:{round(lat, 3)}:{round(lng, 3)}', WEATHER_TTL, load)


def open_meteo_wave(lat, lng):
    def load():
        query = urlencode({'latitude': lat, 'longitude': lng, 'current': 'wave_height'})
        current = fetch_json(f'{MARINE_URL}?{query}').get('current', {})
        return {'observedAt': current.get('time'), 'wave': number(current.get('wave_height'))}

    return cached(f'omw:{round(lat, 3)}:{round(lng, 3)}', WEATHER_TTL, load)


def build_weather(lat, lng):
    result = {
        'ok': False,
        'lat': lat,
        'lng': lng,
        'fetchedAt': time.strftime('%Y-%m-%dT%H:%M:%S+09:00'),
        'sources': [],
        'marine': {},
        'rain': None,
        'errors': [],
    }

    stations = None
    try:
        stations = sea_stations()
        result['sources'].append('kma.sea_obs')
    except Exception as error:
        result['errors'].append(f'sea_obs: {error}')

    if stations:
        wave = nearest(stations, lat, lng, 'wave')
        if wave:
            station, distance = wave
            result['marine']['wave'] = {
                'value': station['wave'], 'unit': 'm', 'station': station['name'],
                'stationId': station['id'], 'distanceKm': round(distance, 1),
                'observedAt': station['observedAt'],
            }
        wind = nearest(stations, lat, lng, 'wind')
        if wind:
            station, distance = wind
            result['marine']['wind'] = {
                'value': station['wind'], 'gust': station['gust'], 'dir': station['windDir'],
                'unit': 'm/s', 'station': station['name'], 'stationId': station['id'],
                'distanceKm': round(distance, 1), 'observedAt': station['observedAt'],
            }

    open_meteo = None
    try:
        open_meteo = open_meteo_weather(lat, lng)
        result['sources'].append('open-meteo')
        result['rain'] = {
            'value': open_meteo['rain'], 'unit': 'mm', 'window': '1h',
            'observedAt': open_meteo['observedAt'],
        }
    except Exception as error:
        result['errors'].append(f'open-meteo: {error}')

    if 'wave' not in result['marine']:
        try:
            model = open_meteo_wave(lat, lng)
            result['marine']['wave'] = {
                'value': model['wave'], 'unit': 'm', 'station': 'Open-Meteo 해양모델',
                'stationId': None, 'distanceKm': 0, 'observedAt': model['observedAt'],
                'modelled': True,
            }
            result['errors'].append('wave: KMA 파고 관측 없음 → 모델값 대체')
        except Exception as error:
            result['errors'].append(f'open-meteo-marine: {error}')

    if 'wind' not in result['marine'] and open_meteo and open_meteo['wind'] is not None:
        result['marine']['wind'] = {
            'value': open_meteo['wind'], 'gust': None, 'dir': open_meteo['windDir'],
            'unit': 'm/s', 'station': 'Open-Meteo 10m', 'stationId': None,
            'distanceKm': 0, 'observedAt': open_meteo['observedAt'],
            'modelled': True,
        }

    result['ok'] = bool(result['marine'] or result['rain'])
    return result


class Handler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        target = (ROOT / urlparse(path).path.lstrip('/')).resolve()
        if not target.is_relative_to(ROOT):
            return str(ROOT / 'index.html')
        return str(target)

    def send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def query(self):
        return parse_qs(urlparse(self.path).query)

    @staticmethod
    def first(query, name):
        return query.get(name, [''])[0]

    def do_GET(self):
        url = urlparse(self.path)
        print(f"DEBUG do_GET: path={self.path!r}, parsed={url.path!r}", flush=True)
        if url.path == '/api/config':
            return self.send_json({'kakaoMapAppKey': os.getenv('KAKAO_MAP_APP_KEY') or None})

        if url.path == '/api/marine-obs':
            try:
                stations = sea_stations()
            except Exception as error:
                return self.send_json({'error': 'KMA sea observation failed', 'detail': str(error)}, 502)
            return self.send_json({'source': 'kma.sea_obs', 'count': len(stations), 'stations': stations})

        if url.path == '/api/weather':
            query = self.query()
            try:
                lat = float(self.first(query, 'lat'))
                lng = float(self.first(query, 'lng'))
            except ValueError:
                return self.send_json({'error': 'lat and lng are required numbers'}, 400)
            try:
                return self.send_json(build_weather(lat, lng))
            except Exception as error:
                return self.send_json({'error': 'weather aggregation failed', 'detail': str(error)}, 502)

        if url.path == '/api/marine-status':
            station_id = self.first(self.query(), 'station').strip()
            if not station_id:
                return self.send_json({'error': 'station is required'}, 400)
            try:
                stations = sea_stations()
            except Exception as error:
                return self.send_json({'error': 'KMA sea observation failed', 'detail': str(error)}, 502)
            match = next((s for s in stations if s['id'] == station_id), None)
            if match is None:
                return self.send_json({'error': 'unknown station', 'station': station_id}, 404)
            return self.send_json({'source': 'kma.sea_obs', 'station': station_id, 'observation': match})


        if url.path == '/api/busan-cctv':
            try:
                result = get_busan_cctv(page=1, rows=100)
                content = result.get('content', {})
                items = content.get('items', [])
                if isinstance(items, dict):
                    items = [items]

                return self.send_json({
                    'source': 'Busan ITS CCTV',
                    'count': len(items),
                    'totalCount': content.get('totalCount', len(items)),
                    'cctv': items
                })
            except Exception as error:
                return self.send_json({
                    'error': 'Busan CCTV API failed',
                    'detail': str(error)
                }, 502)
        return super().do_GET()

    def log_message(self, fmt, *args):
        if getattr(self, 'path', '').startswith('/api/'):
            super().log_message(fmt, *args)

# 부산시 CCTV 목록 API

BUSAN_CCTV_API_URL = "https://apis.data.go.kr/6260000/BusanITSCCTV/CCTVList" 
def get_busan_cctv(page=1, rows=100): 
    from urllib.parse import urlencode 
    from urllib.request import Request, urlopen 
# API 인증키는 환경변수에서 읽기 
    key = os.getenv("BUSAN_CCTV_API_KEY") 
    if not key: 
        raise RuntimeError("BUSAN_CCTV_API_KEY가 설정되지 않았습니다.") 
    params = urlencode({ 
        "serviceKey": key, 
        "pageNo": page, 
        "numOfRows": rows, 
        "resultType": 
        "json", 
        }) 
    url = f"{BUSAN_CCTV_API_URL}?{params}" 
    with urlopen(Request(url), timeout=15) as response: 
        return json.loads(response.read().decode("utf-8"))

if __name__ == '__main__':
    port = int(os.getenv('PORT', '3000'))
    print(f'Dashboard: http://localhost:{port}')
    ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
