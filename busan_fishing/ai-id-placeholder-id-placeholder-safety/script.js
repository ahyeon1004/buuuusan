const loginPage = document.getElementById('loginPage');
const dashboardPage = document.getElementById('dashboardPage');
const loginForm = document.getElementById('loginForm');
const loginError = document.getElementById('loginError');
const loginId = document.getElementById('loginId');
const loginPassword = document.getElementById('loginPassword');
const themeButton = document.getElementById('themeButton');

const RISK_LABEL = { danger: '위험', caution: '주의', warning: '관심', safe: '정상', none: '데이터 없음' };
const RISK_FILL = { safe: 25, warning: 50, caution: 75, danger: 100 };
const DIRECTIONS = ['북', '북동', '동', '남동', '남', '남서', '서', '북서'];
const CCTV_COUNT = '04';
const REFRESH_MS = 60000;
// Keep the demo count consistent with the three people shown in the mock CCTV scene.
const DEMO_OCCUPANCY_COUNT = 3; // 데모 CCTV의 고정 인원값; 실제 분석 연동 시 교체
const PIER_OCCUPANCY = Object.fromEntries(window.BUSAN_AREAS.flatMap(area => area.piers.map(pier => [pier.id, DEMO_OCCUPANCY_COUNT])));

let currentArea = window.BUSAN_AREAS.find(a => a.name === '영도구');
let currentPier = currentArea.piers[0];
let weatherRequest = 0;
let activeCctv = 1;
let mapStarted = false;

function startMapWhenVisible() {
  if (mapStarted) { refreshKakaoMapLayout(); return; }
  mapStarted = true;
  initializeKakaoMap();
}

function renderLocations() {
  const root = document.getElementById('districtList');
  root.innerHTML = window.BUSAN_AREAS.map(area => {
    const active = area.name === currentArea.name;
    const noPiers = !area.piers.length;
    return `<div><button class="district ${active ? 'active' : ''} ${noPiers ? 'unavailable' : ''}" data-area="${area.name}">${area.name}${noPiers ? '<span class="dash">—</span>' : '<span class="chev"></span>'}</button>${active && !noPiers ? `<div class="pier-list">${area.piers.map(pier => `<button class="pier ${pier.id === currentPier.id ? 'active' : ''}" data-pier="${pier.id}"><i></i>${pier.name}</button>`).join('')}</div>` : ''}</div>`;
  }).join('');
  root.querySelectorAll('.district:not(.unavailable)').forEach(button => {
    button.onclick = () => {
      currentArea = window.BUSAN_AREAS.find(a => a.name === button.dataset.area);
      currentPier = currentArea.piers[0];
      renderLocations();
      updateDashboard();
      playBusanCctv();
    };
  });
  root.querySelectorAll('.pier').forEach(button => {
    button.onclick = () => {
      currentPier = currentArea.piers.find(p => p.id === button.dataset.pier);
      renderLocations();
      updateDashboard();
      playBusanCctv();
    };
  });
}

function occupancyLevel(count) {
  if (count >= 10) return 'danger';
  if (count >= 4) return 'caution';
  if (count >= 1) return 'warning';
  return 'safe';
}

function selectedRisk(weatherRisk) {
  const peopleRisk = occupancyLevel(PIER_OCCUPANCY[currentPier.id] ?? 0);
  const rank = { safe:0, warning:1, caution:2, danger:3 };
  return rank[peopleRisk] > rank[weatherRisk] ? peopleRisk : weatherRisk;
}


function renderRisk(result) {
  const chip = document.querySelector(".risk-chip");
  const score = result?.totalScore;
  const available = result?.available === true;

  const gradeClass = {
    "안전": "safe",
    "관심": "warning",
    "주의": "caution",
    "경계": "danger",
    "심각": "danger",
  };

  const grade = available ? result.grade : "산정 불가";
  const risk = available ? gradeClass[grade] : "none";

  chip.className = `risk-chip risk-${risk}`;
  document.getElementById("riskValue").textContent = grade;

  const fill = document.getElementById("totalFill");
  fill.style.width = available ? `${score}%` : "0";
  fill.style.background = available
    ? `var(--${{
        safe: "green",
        warning: "yellow",
        caution: "orange",
        danger: "red",
      }[risk]})`
    : "";

  document.getElementById("totalValue").textContent =
    available ? `${score} / 100점` : "산정 불가";

  document.getElementById("totalBadge").textContent =
    available ? "계산 완료" : "데이터 확인 필요";

  document.getElementById("totalNote").textContent =
    available
      ? result.criteriaNotice
      : "필수 관측값 또는 관측 시각을 확인하세요";
}

function updateCctvPanel() {
  const count = PIER_OCCUPANCY[currentPier.id] ?? 0;
  document.getElementById('occupancyCount').textContent = count > 0 ? `${count}명` : '—';
  document.getElementById('occupancyStatus').textContent = count > 0 ? '정상 인원 감지' : '데이터 없음';
  const location = document.getElementById('cctvLocation');
  if (location) location.textContent = `${currentPier.name} · 입구 방향`;
}

function setKpi(valueId, noteId, value, unit, note, max) {
  const target = document.getElementById(valueId);
  const card = target.closest('.kpi');
  const has = value !== null && value !== undefined;
  target.innerHTML = `${has ? value : '—'}<em>${unit}</em>`;
  card.classList.toggle('live', has);
  card.querySelector('.pill').textContent = has ? '실시간' : '데이터 없음';
  card.querySelector('.fill').style.width = has ? `${Math.min(100, (Number(value) / max) * 100)}%` : '0';
  if (noteId) document.getElementById(noteId).textContent = note;
}


function calculateDashboardRisk(data) {
  if (!data) {
    return {
      available: false,
      totalScore: null,
      grade: "산정 불가",
      itemScores: null,
      statuses: {},
    };
  }

  return window.RiskCalculator.calculate(data);
}

function waveLabel(value) {
  if (value === null || value === undefined) return '관측 대기';
  if (value < 0.5) return '낮음';
  if (value < 1.5) return '보통';
  if (value < 3) return '높음';
  return '매우 높음';
}

function windNote(marine) {
  const wind = marine?.wind;
  if (!wind || wind.value === null) return '관측 대기';
  const direction = wind.dir === null || wind.dir === undefined ? null : DIRECTIONS[Math.round(wind.dir / 45) % 8];
  const base = direction ? `${direction}풍` : '풍향 관측 없음';
  return wind.gust === null || wind.gust === undefined ? base : `${base} · 순간 ${wind.gust.toFixed(1)} m/s`;
}

function sourceLine(data) {
  const parts = [];
  const wave = data.marine?.wave;
  const wind = data.marine?.wind;
  if (wave?.station) parts.push(`파고 기상청 ${wave.station}`);
  if (wind?.station && wind.station !== wave?.station) parts.push(`바람 기상청 ${wind.station}`);
  if (data.rain) parts.push('강수 Open-Meteo');
  if (data.errors?.length) parts.push('일부 대체값');
  const observed = wave?.observedAt || data.rain?.observedAt;
  const time = observed ? observed.slice(11, 16) : data.fetchedAt?.slice(11, 16);
  return `${parts.join(' · ') || '연결 대기'}${time ? ` · ${time} 갱신` : ''}`;
}

function updateDashboard() {
  document.getElementById('districtName').textContent = currentArea.name;
  document.getElementById('crumbPier').textContent = currentPier.name;
  document.getElementById('pierName').textContent = currentPier.name;
  document.getElementById('pierLocation').textContent = `${currentPier.location.split(' ').slice(0, 2).join(' ')} · 관제 구역`;
  document.getElementById('mapPierLabel').textContent = currentPier.name;
  updateCctvPanel();
  applyWeather(weatherCache[currentPier.id] || null, { silent: true });
  loadWeather();
  updateKakaoMap();
}

function applyWeather(data, { silent = false } = {}) {
  if (!data) {
    renderRisk(null);

    setKpi(
      'rainValue', 'rainNote', null, 'mm',
      silent ? '센서 연동 전' : '불러오는 중', 20
    );
    setKpi(
      'windValue', 'windNote', null, 'm/s',
      silent ? '센서 연동 전' : '불러오는 중', 20
    );
    setKpi(
      'waveValue', 'waveNote', null, 'm',
      silent ? '센서 연동 전' : '불러오는 중', 3
    );

    document.getElementById('dataSource').textContent =
      silent
        ? '기상 데이터 연동 전 · 갱신 시각 없음'
        : '관측 데이터 불러오는 중';

    return;
  }

  const { rain, marine } = data;
  const wave = marine?.wave;
  const wind = marine?.wind;

  const riskResult = calculateDashboardRisk(data);

  liveRisk[currentPier.id] = riskResult.available
    ? riskResult.grade
    : undefined;

  renderRisk(riskResult);

  const val = (v, d = 1) =>
    v === null || v === undefined || !Number.isFinite(Number(v))
      ? null
      : Number(v).toFixed(d);

  // 강수량 표시
  setKpi(
    'rainValue',
    'rainNote',
    val(rain?.value),
    'mm',
    rain ? '지난 1시간' : '강수 관측 없음',
    20
  );

  // 풍속 표시
  setKpi(
    'windValue',
    'windNote',
    val(wind?.value),
    'm/s',
    windNote(marine),
    20
  );

  // 파고 표시
  setKpi(
    'waveValue',
    'waveNote',
    val(wave?.value),
    'm',
    waveLabel(wave?.value),
    3
  );

  // 개별 항목 위험도 안내
  const scores = riskResult.available
    ? riskResult.itemScores
    : null;

  document.getElementById('rainNote').textContent = scores
    ? `지난 1시간 · 위험도 ${scores.rainfall}점`
    : `위험도 산정 불가 · ${riskResult.statuses?.rainfall || '데이터 확인 필요'}`;

  document.getElementById('windNote').textContent = scores
    ? `위험도 ${scores.windSpeed}점 · ${windNote(marine)}`
    : `위험도 산정 불가 · ${riskResult.statuses?.windSpeed || '데이터 확인 필요'}`;

  document.getElementById('waveNote').textContent = scores
    ? `위험도 ${scores.waveHeight}점 · ${waveLabel(wave?.value)}`
    : `위험도 산정 불가 · ${riskResult.statuses?.waveHeight || '데이터 확인 필요'}`;

  document.getElementById('dataSource').textContent =
    sourceLine(data);

  renderAlerts(data);
  updateKakaoMap(false);
}

const weatherCache = {};

async function loadWeather() {
  const requestId = ++weatherRequest;
  const pier = currentPier;
  try {
    const response = await fetch(`/api/weather?lat=${encodeURIComponent(pier.lat)}&lng=${encodeURIComponent(pier.lng)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!data.ok) throw new Error(data.errors?.join('; ') || 'empty payload');
    weatherCache[pier.id] = data;
    if (requestId === weatherRequest && pier.id === currentPier.id) applyWeather(data);
  } 
  catch (error) {
    console.warn("Coastal weather unavailable", error);

    if (requestId === weatherRequest && pier.id === currentPier.id) {
    // 실패한 요청의 데이터는 최신 데이터로 취급하지 않음
      delete weatherCache[pier.id];

      applyWeather(null, { silent: true });

      document.getElementById("dataSource").textContent =
        `최신 기상 데이터 연결 실패 · ${error.message}`;

      renderAlerts(null, error);
    }
  }
}

function renderAlerts(data, error) {
  const list = document.getElementById('alertList');
  list.innerHTML = error
    ? `<div class="alert danger"><div class="alert-top"><b>기상 관측 연결 실패</b><time>오류</time></div><p>${error.message}</p></div>`
    : '<div class="alert-empty">현재 감지된 이벤트가 없습니다</div>';
}

function showDashboard() {
  loginPage.classList.add('fade-out');
  setTimeout(() => {
    loginPage.classList.add('hidden');
    loginPage.classList.remove('fade-out');
    dashboardPage.classList.remove('hidden');
    dashboardPage.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 450, easing: 'ease-out' });
    // Kakao maps must be constructed after the hidden dashboard becomes visible.
    // Initializing while display:none produces the blank white tile strip seen in the map panel.
    setTimeout(startMapWhenVisible, 50);
  }, 430);
}

function showLogin() {
  localStorage.removeItem('breakwaterLoggedIn');
  dashboardPage.classList.add('hidden');
  loginId.value = '';
  loginPassword.value = '';
  loginError.textContent = '';
  loginPage.classList.remove('hidden');
  loginPage.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 350 });
  loginId.focus();
}

loginForm.addEventListener('submit', event => {
  event.preventDefault();
  if (loginId.value === 'admin' && loginPassword.value === '1234') {
    localStorage.setItem('breakwaterLoggedIn', 'true');
    showDashboard();
  }
  else {
    loginError.textContent = 'ID 또는 비밀번호가 올바르지 않습니다.';
    loginForm.classList.remove('shake');
    void loginForm.offsetWidth;
    loginForm.classList.add('shake');
  }
});

document.getElementById('userMenuButton').onclick = () => {
  const menu = document.getElementById('userMenu');
  const button = document.getElementById('userMenuButton');
  menu.classList.toggle('hidden');
  button.setAttribute('aria-expanded', String(!menu.classList.contains('hidden')));
};
document.getElementById('logoutButton').onclick = showLogin;
function applyTheme(theme) {
  const dark = theme === 'dark';
  document.body.classList.toggle('dark-theme', dark);
  themeButton.textContent = dark ? '라이트 모드' : '다크 모드';
  localStorage.setItem('breakwaterTheme2', theme);
  setTimeout(refreshKakaoMapLayout, 50);
}
themeButton.onclick = () => applyTheme(document.body.classList.contains('dark-theme') ? 'light' : 'dark');
function playAlarm() {
  try {
    const context = new (window.AudioContext || window.webkitAudioContext)();
    [0, .42, .84, 1.26].forEach((delay, index) => setTimeout(() => {
      const oscillator = context.createOscillator(); const gain = context.createGain();
      oscillator.type = 'sawtooth'; oscillator.frequency.value = index % 2 ? 640 : 900;
      gain.gain.setValueAtTime(.10, context.currentTime); gain.gain.exponentialRampToValueAtTime(.001, context.currentTime + .34);
      oscillator.connect(gain).connect(context.destination); oscillator.start(); oscillator.stop(context.currentTime + .34);
    }, delay));
  } catch { /* audio can be blocked until the user interacts; visual alert still works */ }
}
function speakWarning(text) {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const speech = new SpeechSynthesisUtterance(text);
  speech.lang = 'ko-KR'; speech.rate = .83; speech.pitch = .9; speech.volume = 1;
  window.speechSynthesis.speak(speech);
}
function openEmergency(type) {
  const overlay = document.getElementById('emergencyOverlay');
  const title = document.getElementById('emergencyTitle');
  const message = document.getElementById('emergencyMessage');
  if (type === 'fall') {
    title.textContent = 'AI 추락 위험 감지';
    message.textContent = `${currentPier.name} 끝단에서 추락 위험 행동이 감지되었습니다. 즉시 현장을 확인하십시오.`;
  } else if (type === 'dispatch') {
    title.textContent = '안전요원 출동 요청';
    message.textContent = `${currentPier.name} 현장 안전 확인을 위한 출동 요청이 접수되었습니다.`;
  } else {
    title.textContent = '위험구역 안내방송';
    message.textContent = `위험 구역입니다. 즉시 방파제 끝단에서 물러나 안전한 장소로 이동하십시오.`;
  }
  overlay.classList.remove('hidden'); playAlarm(); speakWarning(message.textContent);
}
document.getElementById('broadcastButton').onclick = () => openEmergency('broadcast');
document.getElementById('dispatchButton').onclick = () => openEmergency('dispatch');
document.getElementById('closeEmergencyButton').onclick = () => document.getElementById('emergencyOverlay').classList.add('hidden');
document.addEventListener('click', event => {
  if (!event.target.closest('.user-area')) document.getElementById('userMenu').classList.add('hidden');
});

function tick() {
  const now = new Date();
  document.getElementById('clock').textContent = now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const stamp = document.getElementById('cctvTimestamp');
  if (stamp) stamp.textContent = now.toLocaleString('sv-SE', { timeZone:'Asia/Seoul', hour12:false }).replace('T', ' ');
}

tick();
setInterval(tick, 1000);
setInterval(loadWeather, REFRESH_MS);
renderLocations();
renderAlerts(null);
updateDashboard();
applyTheme(localStorage.getItem('breakwaterTheme2') || 'light');
if (localStorage.getItem('breakwaterLoggedIn') === 'true') showDashboard();




async function loadBusanCctv() {
  try {
    const response = await fetch('/api/busan-cctv');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    window.BUSAN_CCTV_LIST = data.cctv || [];

    console.log(
      '[부산 CCTV] 불러온 카메라:',
      window.BUSAN_CCTV_LIST.length
    );
  } catch (error) {
    console.error('[부산 CCTV] 목록을 불러오지 못했습니다.', error);
    window.BUSAN_CCTV_LIST = [];
  }
}

loadBusanCctv();

// 실제 부산 CCTV 스트림 재생
async function playBusanCctv() {
  const video = document.getElementById('cctvVideo');
  const status = document.getElementById('cctvStreamStatus');
  const cameraName = document.getElementById('cctvCameraName');

  if (!video || !status) return;

  try {
    if (!window.BUSAN_CCTV_LIST?.length) {
      await loadBusanCctv();
    }

    const cameras = (window.BUSAN_CCTV_LIST || []).filter(c =>
      c.hlsAddr && Number.isFinite(Number(c.lat)) &&
      Number.isFinite(Number(c.lot))
    );

    const pier = currentPier;
    const rad = value => value * Math.PI / 180;

    function distanceKm(a, b) {
      const dLat = rad(Number(b.lat) - Number(a.lat));
      const dLon = rad(Number(b.lot) - Number(a.lng));
      const h = Math.sin(dLat / 2) ** 2 +
        Math.cos(rad(Number(a.lat))) * Math.cos(rad(Number(b.lat))) *
        Math.sin(dLon / 2) ** 2;
      return 6371 * 2 * Math.asin(Math.sqrt(h));
    }

    const ranked = cameras
      .map(c => ({ camera: c, distance: distanceKm(pier, c) }))
      .sort((a, b) => a.distance - b.distance);

    const nearest = ranked[0];

    if (!nearest || nearest.distance > 2) {
      status.textContent = '근처 CCTV 없음 (2km 이내)';
      document.getElementById('cctvLocation').textContent =
        `${pier.name} · 연결 가능한 근거리 카메라 없음`;
      cameraName.textContent = '카메라 미확인';
      if (window.busanCctvPlayer) {
        window.busanCctvPlayer.destroy();
        window.busanCctvPlayer = null;
      }
      video.pause();
      video.removeAttribute('src');
      video.load();
      return;
    }

    const camera = nearest.camera;

    cameraName.textContent = camera.instlPos || '부산 CCTV';
    document.getElementById('cctvLocation').textContent =
      `${pier.name} · 가까운 CCTV: ${camera.instlPos || '위치 미상'} (${nearest.distance.toFixed(2)}km)`;

    if (window.Hls && Hls.isSupported()) {
      if (window.busanCctvPlayer) window.busanCctvPlayer.destroy();

      const player = new Hls();
      window.busanCctvPlayer = player;
      player.loadSource(camera.hlsAddr);
      player.attachMedia(video);

      player.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {
          status.textContent = '재생 버튼을 눌러 주세요';
        });
      });

      player.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) status.textContent = '스트림 재생 실패';
      });

      status.textContent = '스트림 연결 중';
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = camera.hlsAddr;
      status.textContent = '스트림 연결 중';
    } else {
      status.textContent = '이 브라우저는 HLS 재생을 지원하지 않아요';
    }
  } catch (error) {
    console.error('[CCTV 재생 오류]', error);
    status.textContent = 'CCTV 연결 실패';
  }
}

playBusanCctv();
