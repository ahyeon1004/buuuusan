let kakaoMap = null;
let pierMarkers = [];

const riskColor = { danger:'#d13c33', caution:'#d9742f', warning:'#e0a63a', safe:'#3f9b5a', none:'#7c879b' };
const liveRisk = {};
const riskRank = { safe:0, warning:1, caution:2, danger:3 };

function riskOf(id) {
  const weather = liveRisk[id];
  const people = typeof occupancyLevel === 'function' ? occupancyLevel(PIER_OCCUPANCY[id] ?? 0) : 'safe';
  if (!weather && people === 'safe') return 'none'; // no live data yet
  const base = weather || 'safe';
  return riskRank[people] > riskRank[base] ? people : base;
}
function setMapNotice(message) {
  const notice = document.getElementById('mapNotice');
  if (!notice) return;
  notice.textContent = message;
  notice.classList.toggle('hidden', !message);
}
function allPiers() { return window.BUSAN_AREAS.flatMap(area => area.piers.map(pier => ({ ...pier, area:area.name }))); }
function renderPierMarkers() {
  pierMarkers.forEach(marker => marker.setMap(null));
  pierMarkers = allPiers().map(pier => {
    const risk = riskOf(pier.id);
    const point = document.createElement('button');
    point.className = `pier-pin ${pier.id === currentPier.id ? 'selected' : ''}`;
    point.style.setProperty('--pin', riskColor[risk]);
    point.type = 'button';
    point.title = `${pier.name} · ${RISK_LABEL[risk]}`;
    point.setAttribute('aria-label', point.title);
    const marker = new window.kakao.maps.CustomOverlay({
      position:new window.kakao.maps.LatLng(pier.lat, pier.lng), content:point,
      yAnchor:.5, zIndex:pier.id === currentPier.id ? 3 : 1
    });
    point.addEventListener('click', () => {
      const area = window.BUSAN_AREAS.find(item => item.name === pier.area);
      currentArea = area;
      currentPier = area.piers.find(item => item.id === pier.id);
      renderLocations(); updateDashboard();
    });
    marker.setMap(kakaoMap);
    return marker;
  });
}
async function initializeKakaoMap() {
  let appKey = null;
  try {
    const response = await fetch('/api/config');
    appKey = (await response.json()).kakaoMapAppKey;
  } catch {
    setMapNotice('설정 서버에 연결하지 못했습니다. 지도 대체 뷰를 표시합니다.');
    return;
  }
  if (!appKey) {
    setMapNotice('카카오맵 키가 설정되지 않아 지도 대체 뷰를 표시합니다.');
    return;
  }
  try {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(appKey)}&autoload=false`;
      script.onload = resolve; script.onerror = reject; document.head.append(script);
    });
  } catch {
    setMapNotice('카카오맵 SDK를 불러오지 못했습니다.');
    return;
  }
  if (!window.kakao || !window.kakao.maps) {
    setMapNotice('카카오맵이 활성화되지 않았습니다. 카카오디벨로퍼스의 제품 설정에서 카카오맵을 켜고 localhost:3000을 등록하세요.');
    return;
  }
  window.kakao.maps.load(() => {
    const mapShell = document.getElementById('map');
    kakaoMap = new window.kakao.maps.Map(document.getElementById('kakaoMap'), {
      center:new window.kakao.maps.LatLng(35.145,129.075), level:8
    });
    // Do not expose a partially composed map.  Kakao first creates blank tile
    // columns; wait for its tile-complete event before replacing the fallback.
    let mapReady = false;
    const revealMap = () => {
      if (mapReady) return;
      mapReady = true;
      mapShell.classList.add('kakao-ready');
      setMapNotice(''); renderPierMarkers();
    };
    window.kakao.maps.event.addListener(kakaoMap, 'tilesloaded', revealMap);
    setTimeout(() => {
      if (!mapReady) setMapNotice('지도를 불러오는 중입니다. 잠시 후 다시 시도해 주세요.');
    }, 3500);
    setTimeout(refreshKakaoMapLayout, 150);
  });
}
function updateMapTheme() { /* Kakao's base map remains unchanged in either UI theme. */ }
function updateKakaoMap(move=true) {
  if (!kakaoMap || !window.kakao) return;
  const position = new window.kakao.maps.LatLng(currentPier.lat, currentPier.lng);
  if (move) kakaoMap.panTo(position);
  renderPierMarkers();
}
function refreshKakaoMapLayout() {
  if (!kakaoMap) return;
  kakaoMap.relayout();
  kakaoMap.setCenter(new window.kakao.maps.LatLng(currentPier.lat, currentPier.lng));
  renderPierMarkers();
}
