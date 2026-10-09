const loginPage = document.getElementById('loginPage');
const dashboardPage = document.getElementById('dashboardPage');
const loginForm = document.getElementById('loginForm');
const loginError = document.getElementById('loginError');
const loginId = document.getElementById('loginId');
const loginPassword = document.getElementById('loginPassword');
const themeButton = document.getElementById('themeButton');

const RISK_LABEL = { danger: '위험', caution: '주의', warning: '보통', safe: '낮음' };
const DIRECTIONS = ['북', '북동', '동', '남동', '남', '남서', '서', '북서'];
const CCTV_COUNT = '04';
const REFRESH_MS = 60000;
// Keep the demo count consistent with the three people shown in the mock CCTV scene.
const DEMO_OCCUPANCY_COUNT = 3;
const PIER_OCCUPANCY = Object.fromEntries(window.BUSAN_AREAS.flatMap(area => area.piers.map(pier => [pier.id, DEMO_OCCUPANCY_COUNT])));

let currentArea = window.BUSAN_AREAS.find(a => a.name === '영도구');
let currentPier = currentArea.piers[0];
let weatherRequest = 0;
let activeCctv = 1;

function renderLocations() {
  const root = document.getElementById('districtList');
  root.innerHTML = window.BUSAN_AREAS.map(area => {
    const active = area.name === currentArea.name;
    const noPiers = !area.piers.length;
    return `<div><button class="district ${active ? 'active' : ''} ${noPiers ? 'unavailable' : ''}" data-area="${area.name}">${area.name}<span>${noPiers ? '—' : active ? '⌃' : '⌄'}</span></button>${active && !noPiers ? `<div class="pier-list">${area.piers.map(pier => `<button class="pier ${pier.id === currentPier.id ? 'active' : ''}" data-pier="${pier.id}">● ${pier.name}</button>`).join('')}</div>` : ''}</div>`;
  }).join('');
  root.querySelectorAll('.district:not(.unavailable)').forEach(button => {
    button.onclick = () => {
      currentArea = window.BUSAN_AREAS.find(a => a.name === button.dataset.area);
      currentPier = currentArea.piers[0];
      renderLocations();
      updateDashboard();
    };
  });
  root.querySelectorAll('.pier').forEach(button => {
    button.onclick = () => {
      currentPier = currentArea.piers.find(p => p.id === button.dataset.pier);
      renderLocations();
      updateDashboard();
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

function renderRisk(risk) {
  const chip = document.querySelector('.risk-chip');
  chip.className = `risk-chip risk-${risk}`;
  document.getElementById('riskValue').textContent = RISK_LABEL[risk];
}

function updateCctvPanel() {
  const count = PIER_OCCUPANCY[currentPier.id] ?? 0;
  const level = occupancyLevel(count);
  const status = count === 0 ? '현장 인원 없음' : count >= 10 ? '혼잡 감지 · 즉시 확인 필요' : count >= 4 ? '인원 증가 · 주의 관찰' : '정상 인원 감지';
  const badge = document.getElementById('occupancyBadge');
  badge.className = `occupancy ${level}`;
  document.getElementById('occupancyCount').textContent = count;
  document.getElementById('occupancyStatus').textContent = status;
  document.getElementById('cctvLocation').textContent = `${currentPier.name} · ${activeCctv === 1 ? '입구 방향' : '끝단 방향'}`;
  const label = document.getElementById('cctvCameraLabel');
  const pager = document.getElementById('cctvPager');
  const meta = document.getElementById('cctvMeta');
  const cameraArea = { '영도구':'YOUNGDO', '해운대구':'HAEUNDAE', '서구':'SEO', '사하구':'SAHA', '기장군':'GIJANG' }[currentArea.name] || 'BUSAN';
  if (label) label.textContent = `CAM-0${activeCctv}-${cameraArea}`;
  if (pager) pager.textContent = `${activeCctv} / 2`;
  if (meta) meta.textContent = `데모 장면 · ${DEMO_OCCUPANCY_COUNT}명 고정 · ${activeCctv === 1 ? '방파제 입구 방향' : '방파제 끝단 방향'}`;
}

function setKpi(valueId, noteId, value, unit, note) {
  const target = document.getElementById(valueId);
  target.innerHTML = value === null || value === undefined
    ? `— <em>${unit}</em>`
    : `${value} <em>${unit}</em>`;
  if (noteId) document.getElementById(noteId).textContent = note;
}

function riskFrom(marine, rain) {
  const wave = marine?.wave?.value;
  const wind = marine?.wind?.value;
  const mm = rain?.value;
  if (wave === null && wind === null && mm === null) return null;
  if ((wave ?? 0) >= 2 || (wind ?? 0) >= 14 || (mm ?? 0) >= 10) return 'danger';
  if ((wave ?? 0) >= 1 || (wind ?? 0) >= 9 || (mm ?? 0) >= 5) return 'caution';
  if ((wave ?? 0) >= 0.5 || (wind ?? 0) >= 6 || (mm ?? 0) >= 1) return 'warning';
  return 'safe';
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
  document.getElementById('pierName').textContent = currentPier.name;
  document.getElementById('pierLocation').textContent = currentPier.location;
  document.getElementById('mapPierLabel').textContent = currentPier.name;
  document.getElementById('cctvValue').innerHTML = `${CCTV_COUNT} <em>/ ${CCTV_COUNT}</em>`;
  updateCctvPanel();

  const cached = weatherCache[currentPier.id];
  if (cached) applyWeather(cached, { silent: true });
  else applyWeather(null, { silent: true });

  document.getElementById('zoneTitle').textContent = '공식 통제 정보 확인 대기';
  document.getElementById('zoneText').textContent = '낚시 금지·출입 통제는 관할 기관의 최신 고시 데이터를 등록한 뒤 표시됩니다.';
  document.getElementById('zoneBadge').textContent = '검증 대기';

  loadWeather();
  updateKakaoMap();
}

function applyWeather(data, { silent = false } = {}) {
  const risk = data ? riskFrom(data.marine, data.rain) : null;
  renderRisk(selectedRisk(risk || demoRisk[currentPier.id] || 'safe'));
  liveRisk[currentPier.id] = risk || undefined;

  if (!data) {
    setKpi('rainValue', 'rainNote', null, 'mm', silent ? '연결 대기' : '불러오는 중');
    setKpi('windValue', 'windNote', null, 'm/s', silent ? '연결 대기' : '불러오는 중');
    setKpi('waveValue', 'waveNote', null, 'm', silent ? '연결 대기' : '불러오는 중');
    document.getElementById('dataSource').textContent = silent ? '이전 관측 대기' : '관측 데이터 불러오는 중';
    return;
  }

  const rain = data.rain;
  const wave = data.marine?.wave;
  const wind = data.marine?.wind;
  setKpi('rainValue', 'rainNote', rain?.value === null || rain?.value === undefined ? null : rain.value.toFixed(1), 'mm', rain ? '지난 1시간' : '강수 관측 없음');
  setKpi('windValue', 'windNote', wind?.value === null || wind?.value === undefined ? null : wind.value.toFixed(1), 'm/s', windNote(data.marine));
  setKpi('waveValue', 'waveNote', wave?.value === null || wave?.value === undefined ? null : wave.value.toFixed(1), 'm', waveLabel(wave?.value));
  document.getElementById('dataSource').textContent = sourceLine(data);
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
  } catch (error) {
    console.warn('Coastal weather unavailable', error);
    if (requestId === weatherRequest && pier.id === currentPier.id) {
      document.getElementById('dataSource').textContent = `관측 데이터 연결 실패 · ${error.message}`;
      renderAlerts(null, error);
    }
  }
}

function renderAlerts(data, error) {
  const weatherAlert = data
    ? ['info', '기상 관측 연결', sourceLine(data), '실시간']
    : error
      ? ['danger', '기상 관측 연결 실패', error.message, '오류']
      : ['info', '기상 관측 연결', '관측 데이터를 불러오는 중입니다.', '연결 대기'];
  const items = [
    ['warning', '안전모 미착용 감지', 'CCTV 기반 AI 감지는 연결 후 활성화됩니다.', '연결 대기'],
    weatherAlert,
    ['danger', '통제구역 데이터', '공식 고시 데이터 등록 전에는 안전 판단에 사용하지 마세요.', '안내'],
  ];
  document.getElementById('alertList').innerHTML = items.map(([type, title, text, time]) => `<div class="alert ${type}"><div class="alert-top"><b>${title}</b><time>${time}</time></div><p>${text}</p></div>`).join('');
}

function showDashboard() {
  loginPage.classList.add('fade-out');
  setTimeout(() => {
    loginPage.classList.add('hidden');
    loginPage.classList.remove('fade-out');
    dashboardPage.classList.remove('hidden');
    dashboardPage.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 450, easing: 'ease-out' });
    setTimeout(refreshKakaoMapLayout, 50);
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
  const light = theme === 'light';
  document.body.classList.toggle('light-theme', light);
  themeButton.innerHTML = light ? '☾ <span>다크 모드</span>' : '☀ <span>라이트 모드</span>';
  themeButton.setAttribute('aria-label', light ? '다크 모드로 전환' : '라이트 모드로 전환');
  localStorage.setItem('breakwaterTheme', theme);
  if (typeof updateMapTheme === 'function') updateMapTheme(theme);
  setTimeout(refreshKakaoMapLayout, 50);
}
themeButton.onclick = () => applyTheme(document.body.classList.contains('light-theme') ? 'dark' : 'light');
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
function changeCctv(direction) { activeCctv = activeCctv + direction; if (activeCctv < 1) activeCctv = 2; if (activeCctv > 2) activeCctv = 1; updateCctvPanel(); }
document.getElementById('prevCctvButton').onclick = () => changeCctv(-1);
document.getElementById('nextCctvButton').onclick = () => changeCctv(1);
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
initializeKakaoMap();
applyTheme(localStorage.getItem('breakwaterTheme') || 'dark');
if (localStorage.getItem('breakwaterLoggedIn') === 'true') showDashboard();
