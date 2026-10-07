let kakaoMap = null;
let kakaoMarker = null;
let pierMarkers = [];

// Fallback risk when no live observation has arrived yet.
const demoRisk = { 'busan-port':'caution', songdo:'caution', taejongdae:'danger', yongho:'caution', mipo:'warning', cheongsapo:'safe', dadaepo:'warning', gadeokdo:'safe', millak:'warning', daebyeon:'safe', ilgwang:'safe' };
const riskColor = { danger:'#ff405e', caution:'#ff9d2e', warning:'#ffc844', safe:'#4cdaa1' };
const liveRisk = {};
function riskOf(pierId) { return liveRisk[pierId] || demoRisk[pierId] || 'safe'; }
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
    const point = document.createElement('button');
    point.className = `pier-pin ${pier.id === currentPier.id ? 'selected' : ''}`;
    point.style.setProperty('--pin', riskColor[riskOf(pier.id)]);
    point.type = 'button';
    point.title = `${pier.name} · ${RISK_LABEL[riskOf(pier.id)]}`;
    point.setAttribute('aria-label', point.title);
    const marker = new window.kakao.maps.CustomOverlay({ position:new window.kakao.maps.LatLng(pier.lat, pier.lng), content:point, yAnchor:0.5, zIndex:pier.id === currentPier.id ? 3 : 1 });
    point.addEventListener('click', () => {
      const area = window.BUSAN_AREAS.find(item => item.name === pier.area);
      currentArea = area; currentPier = area.piers.find(item => item.id === pier.id);
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
  } catch (error) {
    setMapNotice('설정 서버에 연결하지 못했습니다. 지도 대체 뷰를 표시합니다.');
    return;
  }
  if (!appKey) {
    setMapNotice('KAKAO_MAP_APP_KEY 가 설정되지 않아 지도 대체 뷰를 표시합니다.');
    return;
  }
  try {
    await new Promise((resolve, reject) => { const script=document.createElement('script'); script.src=`https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(appKey)}&autoload=false`; script.onload=resolve; script.onerror=reject; document.head.append(script); });
  } catch (error) {
    setMapNotice('카카오맵 SDK를 불러오지 못했습니다. 지도 대체 뷰를 표시합니다.');
    return;
  }
  if (!window.kakao || !window.kakao.maps) {
    setMapNotice('카카오맵 API가 비활성화 상태입니다. 카카오디벨로퍼스 → 내 애플리케이션 → 제품설정 → 카카오맵을 켜세요.');
    console.warn('Kakao Maps SDK rejected the key', appKey);
    return;
  }
  window.kakao.maps.load(() => {
    kakaoMap = new window.kakao.maps.Map(document.getElementById('kakaoMap'), { center:new window.kakao.maps.LatLng(35.145,129.075), level:8 });
      document.getElementById('map').classList.add('kakao-ready');
      setMapNotice('');
      renderPierMarkers();
      setTimeout(() => refreshKakaoMapLayout(), 150);
  });
}
function updateKakaoMap(move = true) {
  if (!kakaoMap || !window.kakao) return;
  const position = new window.kakao.maps.LatLng(currentPier.lat, currentPier.lng);
  if (move) kakaoMap.panTo(position);
  renderPierMarkers();
}
function refreshKakaoMapLayout() {
  if (!kakaoMap) return;
  // Kakao Maps requires relayout() after a container goes from display:none to visible.
  kakaoMap.relayout();
  kakaoMap.setCenter(new window.kakao.maps.LatLng(currentPier.lat, currentPier.lng));
  renderPierMarkers();
}
