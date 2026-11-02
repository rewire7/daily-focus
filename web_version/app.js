// ===== Supabase 설정 =====
// Supabase 대시보드 → Project Settings → API(또는 Data API) 화면에서 복사해 넣는다.
// anon(public) key는 브라우저에 공개돼도 되는 키다. 실제 데이터 보호는 DB의 RLS 정책이 맡는다.
const SUPABASE_URL = 'https://hsiwgiszezheoqcvnhht.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhzaXdnaXN6ZXpoZW9xY3ZuaGh0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM2MDkxODYsImV4cCI6MjEwOTE4NTE4Nn0.RBl8KxW1b29bgq9uLxmQ8W4TQfJ_IcF8IiacPz3tniI';
const SUPABASE_CONFIGURED = SUPABASE_URL.startsWith('https://');
const TODO_TABLE = 'todo_docs';
const TOKEN_REFRESH_MARGIN_SEC = 60; // 토큰 만료 60초 전이면 미리 갱신한다.

// ===== 상수 =====
const STORAGE_KEY = 'dailyfocus.todos.v1'; // 이 기기의 임시 캐시(빠른 첫 화면 + 오프라인 대비)
const STORAGE_VERSION = 1;
const SESSION_STORAGE_KEY = 'dailyfocus.session.v1';
const FILTERS_STORAGE_KEY = 'dailyfocus.filters.v1';
const THEME_STORAGE_KEY = 'dailyfocus.theme.v1';
const VALID_THEMES = ['light', 'dark'];
const UNDO_DURATION_MS = 3000;

const CATEGORIES = [
  { value: 'work', label: '업무', color: '#3B82F6' },
  { value: 'personal', label: '개인', color: '#10B981' },
  { value: 'study', label: '공부', color: '#F59E0B' },
];
const CATEGORY_ORDER = CATEGORIES.map((c) => c.value);

// 제목에 아래 키워드가 포함되면 해당 카테고리로 자동 분류를 제안한다.
const CATEGORY_KEYWORDS = {
  work: ['회의', '보고서', '업무', '미팅', '프로젝트', '메일', '발표', '출근', '회사', '클라이언트'],
  personal: ['운동', '병원', '장보기', '집안일', '가족', '약속', '여행', '청소', '빨래', '개인'],
  study: ['공부', '시험', '강의', '숙제', '과제', '독서', '수업', '자격증', '스터디'],
};

const VALID_CATEGORY_FILTERS = ['all', ...CATEGORY_ORDER];
const VALID_STATUS_FILTERS = ['all', 'active', 'completed'];
const STATUS_FILTER_LABELS = { all: '전체', active: '미완료', completed: '완료' };
const REQUIRED_TODO_FIELDS = ['id', 'title', 'category', 'completed', 'createdAt', 'completedAt'];

// ===== 전역 상태 =====
let state = {
  todos: [],
  filters: {
    category: 'all',
    status: 'all',
  },
  editingId: null, // 인라인 편집 중인 항목 id. 동시에 하나만 편집 가능하다.
  theme: 'light', // 'light' | 'dark'. 실제 초기값은 loadTheme()에서 저장된 값/시스템 설정으로 덮어써진다.
  user: null, // 로그인한 사용자 { id, email }. null이면 로그인 화면을 보여준다.
};

// 삭제 취소(Undo) 대기 정보. 토스트가 떠 있는 동안만 값이 존재한다.
let pendingDelete = null;

// 방금 체크 토글된 항목 id. 체크 애니메이션을 이번 렌더링에서만 재생하기 위한 임시 표시.
let lastToggledId = null;

// 로그인 토큰. 화면 상태가 아니라 통신용 비밀값이라 state 밖에 둔다.
let session = null;

// 토큰 갱신이 동시에 여러 번 일어나지 않도록 진행 중인 갱신 Promise를 공유한다.
let refreshPromise = null;

// 클라우드 저장을 순서대로 처리하기 위한 대기열. 늦게 시작한 저장이 먼저 끝나 덮어쓰는 일을 막는다.
let saveQueue = Promise.resolve();

// 마지막 클라우드 저장이 실패해 아직 올라가지 않은 변경이 있는지 여부.
let hasUnsyncedChanges = false;

// ===== id 생성 =====
// 생성시각 + 랜덤 4자리 문자열로 고유 id를 만든다.
function generateId() {
  const random = Math.random().toString(36).slice(2, 6);
  return `${Date.now()}-${random}`;
}

// ===== 카테고리 =====
// 카테고리 값(work/personal/study)에 해당하는 라벨·색상 정보를 반환한다.
function getCategoryInfo(value) {
  return CATEGORIES.find((c) => c.value === value) || CATEGORIES[0];
}

// 제목에 포함된 키워드를 기준으로 카테고리를 추정한다. 일치하는 키워드가 없으면 null을 반환한다.
function detectCategoryByKeyword(title) {
  const lowerTitle = title.toLowerCase();
  for (const category of CATEGORY_ORDER) {
    const matched = CATEGORY_KEYWORDS[category].some((keyword) =>
      lowerTitle.includes(keyword.toLowerCase())
    );
    if (matched) return category;
  }
  return null;
}

// ===== 기기 캐시 (localStorage) =====
// 클라우드가 원본이고, localStorage는 빠른 첫 화면과 오프라인 대비용 사본이다.
// 다른 사람이 같은 기기에서 로그인해도 섞이지 않도록 userId를 함께 저장한다.
function readLocalCache() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && Array.isArray(parsed.todos) ? parsed : null;
  } catch (err) {
    console.error('기기에 저장된 데이터를 불러오지 못했습니다.', err);
    return null;
  }
}

// 현재 사용자의 캐시가 있으면 state.todos로 복원한다.
function loadCachedTodos() {
  const cache = readLocalCache();
  if (cache && state.user && cache.userId === state.user.id) {
    state.todos = cache.todos;
  }
}

// 로그인 기능 도입 이전에 이 기기에만 저장돼 있던 할 일(userId 없음)을 반환한다.
function readLegacyLocalTodos() {
  const cache = readLocalCache();
  if (!cache || cache.userId) return [];
  return validateImportedData({ version: STORAGE_VERSION, todos: cache.todos }) ? [] : cache.todos;
}

// 현재 데이터를 기기 캐시에 저장한다. 실패해도 클라우드 저장에는 영향이 없어 로그만 남긴다.
function writeLocalCache(payload) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...payload, userId: state.user.id }));
  } catch (err) {
    console.error('기기 캐시에 저장하지 못했습니다.', err);
  }
}

// 로그아웃 시 이 기기에 남은 할 일 사본을 지운다.
function clearLocalCache() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (err) {
    console.error('기기 캐시를 지우지 못했습니다.', err);
  }
}

// ===== 저장 =====
// state → 기기 캐시 + 클라우드에 저장.
// 호출부는 await 없이 saveState()만 호출한다(fire-and-forget). 실패해도 이 함수 안에서 배너로 알린다.
function saveState() {
  if (!state.user) return Promise.resolve();

  // 대기열에서 기다리는 동안 state가 바뀌어도 이 시점 내용이 저장되도록 사본을 만든다.
  const payload = JSON.parse(JSON.stringify({ version: STORAGE_VERSION, todos: state.todos }));
  writeLocalCache(payload);
  saveQueue = saveQueue.then(() => pushToCloud(payload));
  return saveQueue;
}

// 클라우드에 한 번 저장을 시도하고 결과를 배너로 알린다.
async function pushToCloud(payload) {
  if (!state.user) return;
  try {
    await upsertRemoteDoc(payload);
    hasUnsyncedChanges = false;
    hideStorageWarning();
  } catch (err) {
    console.error('클라우드에 저장하지 못했습니다.', err);
    hasUnsyncedChanges = true;
    showStorageWarning('클라우드에 저장하지 못했습니다. 인터넷 연결을 확인해주세요. (이 기기에는 임시 저장됨)');
  }
}

// localStorage → state.filters 복원. 값이 유효하지 않으면 기본값을 유지한다.
function loadFilters() {
  try {
    const raw = localStorage.getItem(FILTERS_STORAGE_KEY);
    if (!raw) return;

    const parsed = JSON.parse(raw);
    if (parsed && VALID_CATEGORY_FILTERS.includes(parsed.category)) {
      state.filters.category = parsed.category;
    }
    if (parsed && VALID_STATUS_FILTERS.includes(parsed.status)) {
      state.filters.status = parsed.status;
    }
  } catch (err) {
    console.error('저장된 필터를 불러오지 못했습니다. 기본값으로 시작합니다.', err);
  }
}

// state.filters → localStorage 저장. 필터는 기기별 화면 설정이라 클라우드에 올리지 않는다.
function saveFilters() {
  try {
    localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(state.filters));
  } catch (err) {
    console.error('필터를 저장하지 못했습니다.', err);
  }
}

// ===== 세션 (로그인 토큰) =====
// localStorage에 저장된 세션을 불러온다. 없거나 깨졌으면 null.
function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && parsed.refreshToken && parsed.user ? parsed : null;
  } catch (err) {
    console.error('로그인 정보를 불러오지 못했습니다.', err);
    return null;
  }
}

// 세션을 메모리·localStorage·state.user에 함께 반영한다. null이면 로그아웃 상태가 된다.
function storeSession(newSession) {
  session = newSession;
  state.user = newSession ? newSession.user : null;
  try {
    if (newSession) {
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(newSession));
    } else {
      localStorage.removeItem(SESSION_STORAGE_KEY);
    }
  } catch (err) {
    console.error('로그인 정보를 저장하지 못했습니다.', err);
  }
}

// Supabase Auth 응답을 앱에서 쓰는 세션 형태로 바꾼다.
function toSession(data) {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_at || nowSec + data.expires_in,
    user: { id: data.user.id, email: data.user.email },
  };
}

// ===== Supabase Auth (REST) =====
// Supabase Auth 오류 응답을 사용자에게 보여줄 한국어 문장으로 바꾼다.
function translateAuthError(data) {
  const code = data.error_code || data.code || data.error;
  const messages = {
    invalid_credentials: '이메일 또는 비밀번호가 올바르지 않습니다.',
    invalid_grant: '이메일 또는 비밀번호가 올바르지 않습니다.',
    email_not_confirmed: '이메일 인증이 아직 안 됐습니다. 메일함의 인증 링크를 먼저 눌러주세요.',
    user_already_exists: '이미 가입된 이메일입니다. 로그인해주세요.',
    weak_password: '비밀번호는 6자 이상이어야 합니다.',
    signup_disabled: '현재 신규 가입이 막혀 있습니다. 관리자에게 문의하세요.',
    over_email_send_rate_limit: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.',
    over_request_rate_limit: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.',
  };
  return messages[code] || data.msg || data.error_description || '요청을 처리하지 못했습니다.';
}

// Supabase Auth 엔드포인트에 POST 요청을 보내고, 실패하면 한국어 메시지로 예외를 던진다.
async function authRequest(path, body, accessToken) {
  const headers = { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const res = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(translateAuthError(data));
    error.status = res.status;
    throw error;
  }
  return data;
}

// 이메일·비밀번호로 로그인한다.
async function signIn(email, password) {
  const data = await authRequest('token?grant_type=password', { email, password });
  storeSession(toSession(data));
}

// 회원가입한다. 이메일 인증이 꺼져 있으면 바로 로그인되어 true, 인증 메일을 보냈으면 false를 반환한다.
async function signUp(email, password) {
  const data = await authRequest('signup', { email, password });
  if (data.access_token) {
    storeSession(toSession(data));
    return true;
  }
  return false;
}

// refresh token으로 새 access token을 받는다. 동시에 여러 번 불려도 실제 요청은 한 번만 보낸다.
function refreshSession() {
  if (!refreshPromise) {
    refreshPromise = authRequest('token?grant_type=refresh_token', { refresh_token: session.refreshToken })
      .then((data) => storeSession(toSession(data)))
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

// 만료가 임박했으면 갱신한 뒤 사용 가능한 access token을 반환한다.
async function getValidAccessToken() {
  const nowSec = Math.floor(Date.now() / 1000);
  if (session.expiresAt - TOKEN_REFRESH_MARGIN_SEC <= nowSec) {
    await refreshSession();
  }
  return session.accessToken;
}

// 이메일 인증 링크를 눌러 돌아온 경우, 주소 # 뒤에 담긴 토큰으로 바로 로그인 처리한다.
async function consumeAuthRedirect() {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  if (!accessToken || !refreshToken) return false;

  // 토큰이 주소창·방문 기록에 남지 않도록 # 부분을 지운다.
  history.replaceState(null, '', window.location.pathname + window.location.search);

  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return false;
  const user = await res.json();
  storeSession(
    toSession({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: Number(params.get('expires_in')) || 3600,
      expires_at: Number(params.get('expires_at')) || null,
      user,
    })
  );
  return true;
}

// ===== Supabase DB (REST) =====
// 로그인 토큰을 붙여 DB REST API를 호출한다. 401이면 토큰을 한 번 갱신해 재시도한다.
async function dbRequest(path, options = {}, isRetry = false) {
  let token;
  try {
    token = await getValidAccessToken();
  } catch (err) {
    handleSessionExpired();
    throw err;
  }

  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (res.status === 401 && !isRetry) {
    session.expiresAt = 0; // 강제로 갱신하도록 만료 처리
    return dbRequest(path, options, true);
  }
  if (!res.ok) {
    throw new Error(`DB 요청 실패 (${res.status})`);
  }
  return res;
}

// 내 할 일 문서(사용자당 1행)를 가져온다. 아직 없으면 null.
async function fetchRemoteDoc() {
  const userId = encodeURIComponent(state.user.id);
  const res = await dbRequest(`${TODO_TABLE}?select=data&user_id=eq.${userId}`);
  const rows = await res.json();
  return rows.length > 0 ? rows[0].data : null;
}

// 내 할 일 문서를 통째로 저장한다(없으면 생성, 있으면 덮어쓰기).
async function upsertRemoteDoc(payload) {
  await dbRequest(TODO_TABLE, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ user_id: state.user.id, data: payload, updated_at: new Date().toISOString() }),
  });
}

// ===== 로그인 이후 데이터 동기화 =====
// 클라우드 데이터를 불러와 화면에 반영한다. 첫 로그인이면 이 기기에 있던 기존 데이터를 옮길지 묻는다.
async function loadFromCloud() {
  let remote;
  try {
    remote = await fetchRemoteDoc();
  } catch (err) {
    console.error('클라우드 데이터를 불러오지 못했습니다.', err);
    if (state.user) {
      showStorageWarning('클라우드에 연결하지 못해 이 기기에 저장된 사본을 보여주고 있습니다.');
    }
    return;
  }

  if (remote && !validateImportedData(remote)) {
    state.todos = remote.todos;
    writeLocalCache({ version: STORAGE_VERSION, todos: state.todos });
  } else {
    state.todos = askLegacyMigration();
    await saveState();
  }
  hideStorageWarning();
  render();
}

// 로그인 기능 도입 전 이 기기에만 있던 할 일을 계정으로 옮길지 묻고, 옮길 목록을 반환한다.
function askLegacyMigration() {
  const legacyTodos = readLegacyLocalTodos();
  if (legacyTodos.length === 0) return [];

  const confirmed = confirm(
    `이 기기에 저장돼 있던 할 일 ${legacyTodos.length}개를 내 계정으로 옮길까요?\n` +
      `(옮기면 다른 컴퓨터에서도 보입니다)`
  );
  return confirmed ? legacyTodos : [];
}

// 다른 기기에서 바뀐 내용을 가져온다. 창으로 돌아올 때 호출된다.
// 편집 중이거나 삭제 취소 대기 중이면 사용자의 작업을 방해하지 않도록 건너뛴다.
async function syncFromCloud() {
  if (!state.user || state.editingId || pendingDelete) return;

  await saveQueue;
  if (hasUnsyncedChanges) {
    saveState(); // 못 올린 변경이 있으면 받아오기 전에 먼저 올린다.
    return;
  }

  try {
    const remote = await fetchRemoteDoc();
    if (!remote || validateImportedData(remote)) return;
    if (JSON.stringify(remote.todos) === JSON.stringify(state.todos)) return;

    state.todos = remote.todos;
    writeLocalCache({ version: STORAGE_VERSION, todos: state.todos });
    render();
  } catch (err) {
    console.error('클라우드 데이터를 다시 불러오지 못했습니다.', err);
  }
}

// ===== 로그인 / 로그아웃 처리 =====
// 로그인 성공 직후: 화면을 앱으로 전환하고 클라우드 데이터를 불러온다.
async function startUserSession() {
  state.todos = [];
  loadCachedTodos();
  renderAuthView();
  render();
  await loadFromCloud();
}

// 로그아웃: 서버 세션을 끊고 이 기기의 토큰·데이터 사본을 지운 뒤 로그인 화면으로 돌아간다.
async function signOut() {
  await saveQueue; // 저장 중인 변경이 있으면 끝날 때까지 기다린다.
  if (hasUnsyncedChanges) {
    const confirmed = confirm('아직 클라우드에 올라가지 않은 변경이 있습니다. 그래도 로그아웃할까요?');
    if (!confirmed) return;
  }

  if (session) {
    authRequest('logout', {}, session.accessToken).catch((err) => console.error('로그아웃 요청 실패', err));
  }
  resetToLoggedOut();
}

// 토큰 갱신에 실패한 경우(오래 접속하지 않았거나 다른 곳에서 로그아웃): 다시 로그인하게 한다.
function handleSessionExpired() {
  if (!state.user) return;
  resetToLoggedOut();
  showAuthMessage('로그인이 만료되었습니다. 다시 로그인해주세요.', true);
}

// 메모리·기기에 남은 사용자 데이터를 모두 지우고 로그인 화면을 보여준다.
function resetToLoggedOut() {
  finalizePendingDelete();
  storeSession(null);
  clearLocalCache();
  state.todos = [];
  state.editingId = null;
  hasUnsyncedChanges = false;
  hideStorageWarning();
  renderAuthView();
  render();
}

// ===== 로그인 화면 =====
// 로그인 여부에 따라 로그인 화면과 앱 화면 중 하나만 보여주고, 계정 표시줄을 갱신한다.
// innerHTML을 쓰지 않고 요소 생성 + textContent만 사용해 XSS를 차단한다.
function renderAuthView() {
  const isLoggedIn = Boolean(state.user);
  document.getElementById('auth-screen').classList.toggle('hidden', isLoggedIn);
  document.getElementById('app').classList.toggle('hidden', !isLoggedIn);

  const statusEl = document.getElementById('account-status');
  statusEl.textContent = '';
  if (!isLoggedIn) return;

  const textEl = document.createElement('span');
  textEl.textContent = `☁️ ${state.user.email} · 어느 기기에서든 같은 목록이 보입니다`;
  statusEl.appendChild(textEl);

  const logoutBtnEl = document.createElement('button');
  logoutBtnEl.type = 'button';
  logoutBtnEl.className = 'account-action-btn';
  logoutBtnEl.textContent = '로그아웃';
  logoutBtnEl.dataset.action = 'logout';
  statusEl.appendChild(logoutBtnEl);
}

// 로그인 화면 아래에 안내/오류 문구를 표시한다.
function showAuthMessage(message, isError) {
  const messageEl = document.getElementById('auth-message');
  messageEl.textContent = message;
  messageEl.classList.toggle('is-error', Boolean(isError));
  messageEl.classList.remove('hidden');
}

// 로그인 요청이 진행 중인 동안 버튼을 잠가 중복 클릭을 막는다.
function setAuthBusy(isBusy) {
  document.getElementById('auth-login-btn').disabled = isBusy;
  document.getElementById('auth-signup-btn').disabled = isBusy;
}

// 이메일·비밀번호 입력값을 읽고 기본 형식을 검사한다. 문제가 있으면 null.
function readAuthInputs() {
  const email = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  if (!email || !password) {
    showAuthMessage('이메일과 비밀번호를 모두 입력해주세요.', true);
    return null;
  }
  if (password.length < 6) {
    showAuthMessage('비밀번호는 6자 이상이어야 합니다.', true);
    return null;
  }
  return { email, password };
}

// 로그인 버튼(폼 제출) 처리.
async function handleLogin() {
  const inputs = readAuthInputs();
  if (!inputs) return;

  setAuthBusy(true);
  try {
    await signIn(inputs.email, inputs.password);
    document.getElementById('auth-password').value = '';
    document.getElementById('auth-message').classList.add('hidden');
    await startUserSession();
  } catch (err) {
    showAuthMessage(err.message || '로그인하지 못했습니다. 인터넷 연결을 확인해주세요.', true);
  } finally {
    setAuthBusy(false);
  }
}

// 회원가입 버튼 처리.
async function handleSignup() {
  const inputs = readAuthInputs();
  if (!inputs) return;

  setAuthBusy(true);
  try {
    const loggedIn = await signUp(inputs.email, inputs.password);
    document.getElementById('auth-password').value = '';
    if (loggedIn) {
      document.getElementById('auth-message').classList.add('hidden');
      await startUserSession();
    } else {
      showAuthMessage('인증 메일을 보냈습니다. 메일의 링크를 누른 뒤 다시 로그인해주세요.', false);
    }
  } catch (err) {
    showAuthMessage(err.message || '가입하지 못했습니다. 인터넷 연결을 확인해주세요.', true);
  } finally {
    setAuthBusy(false);
  }
}

// 로그인 폼·회원가입·로그아웃 버튼과 창 복귀 시 동기화 이벤트를 연결한다.
function setupAuthEvents() {
  document.getElementById('auth-form').addEventListener('submit', (event) => {
    event.preventDefault();
    handleLogin();
  });
  document.getElementById('auth-signup-btn').addEventListener('click', handleSignup);

  document.getElementById('account-status').addEventListener('click', (event) => {
    const btnEl = event.target.closest('[data-action="logout"]');
    if (btnEl) signOut();
  });

  // 다른 기기에서 수정한 내용을 반영하기 위해, 이 창으로 돌아올 때마다 클라우드를 다시 확인한다.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncFromCloud();
  });
  // 인터넷이 다시 연결되면 못 올린 변경을 올린다.
  window.addEventListener('online', () => {
    if (hasUnsyncedChanges) saveState();
  });
}

// ===== 다크 모드 =====
// localStorage → state.theme 복원. 저장된 값이 없으면 시스템(OS) 다크 모드 설정을 따른다.
function loadTheme() {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (raw && VALID_THEMES.includes(raw)) {
      state.theme = raw;
      return;
    }
  } catch (err) {
    console.error('저장된 테마를 불러오지 못했습니다. 시스템 설정을 따릅니다.', err);
  }

  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  state.theme = prefersDark ? 'dark' : 'light';
}

// state.theme → localStorage 저장. 실패해도 앱은 계속 동작하되 사용자에게 배너로 알린다.
function saveTheme() {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, state.theme);
    hideStorageWarning();
  } catch (err) {
    console.error('테마를 저장하지 못했습니다.', err);
    showStorageWarning('저장 공간이 가득 찼거나 접근할 수 없어 테마 설정이 저장되지 않았습니다.');
  }
}

// 현재 state.theme을 문서에 반영한다. 목록 전체를 다시 그리는 render()와는 무관한 전역 스타일이라 분리한다.
function applyTheme() {
  document.documentElement.dataset.theme = state.theme;

  const toggleBtnEl = document.getElementById('theme-toggle-btn');
  const isDark = state.theme === 'dark';
  toggleBtnEl.textContent = isDark ? '☀️' : '🌙';
  toggleBtnEl.setAttribute('aria-label', isDark ? '라이트 모드로 전환' : '다크 모드로 전환');
  toggleBtnEl.setAttribute('aria-pressed', String(isDark));
}

// 라이트/다크 모드를 전환한다.
function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  saveTheme();
  applyTheme();
}

// ===== 저장 실패 안내 배너 =====
// 저장(클라우드/기기)이 실패할 때만 노출하고, 다음 저장이 성공하면 자동으로 숨긴다.
function showStorageWarning(message) {
  const warningEl = document.getElementById('storage-warning');
  warningEl.textContent = message;
  warningEl.classList.remove('hidden');
}

// 저장 경고 배너를 숨긴다.
function hideStorageWarning() {
  const warningEl = document.getElementById('storage-warning');
  warningEl.classList.add('hidden');
}

// ===== JSON 내보내기 =====
// Date 객체를 "YYYYMMDD" 형식 문자열로 바꾼다.
function formatDateYYYYMMDD(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

// 현재 할 일 데이터를 JSON 파일(todos-YYYYMMDD.json)로 다운로드한다.
function exportTodos() {
  const payload = { version: STORAGE_VERSION, todos: state.todos };
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const linkEl = document.createElement('a');
  linkEl.href = url;
  linkEl.download = `todos-${formatDateYYYYMMDD(new Date())}.json`;
  document.body.appendChild(linkEl);
  linkEl.click();
  document.body.removeChild(linkEl);

  // 다운로드가 시작된 뒤(현재 호출 스택이 끝난 뒤) 안전하게 해제한다.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// ===== JSON 가져오기 =====
// 스키마가 올바르면 null을, 문제가 있으면 사용자에게 보여줄 에러 메시지를 반환한다.
function validateImportedData(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return '데이터 형식이 올바르지 않습니다.';
  }
  if (typeof parsed.version !== 'number') {
    return 'version 필드가 없거나 올바르지 않습니다.';
  }
  if (!Array.isArray(parsed.todos)) {
    return 'todos가 배열이 아닙니다.';
  }
  for (const todo of parsed.todos) {
    if (!todo || typeof todo !== 'object') {
      return '할 일 항목의 형식이 올바르지 않습니다.';
    }
    for (const field of REQUIRED_TODO_FIELDS) {
      if (!(field in todo)) {
        return `할 일 항목에 "${field}" 필드가 없습니다.`;
      }
    }
    if (!CATEGORY_ORDER.includes(todo.category)) {
      return `알 수 없는 카테고리 값입니다: ${todo.category}`;
    }
  }
  return null;
}

// 검증과 사용자 확인을 통과한 뒤에만 기존 데이터를 교체한다.
function importTodos(parsed) {
  const currentCount = state.todos.length;
  const newCount = parsed.todos.length;
  const confirmed = confirm(
    `기존 데이터 ${currentCount}개가 삭제되고 ${newCount}개로 대체됩니다. 진행할까요?`
  );
  if (!confirmed) return;

  finalizePendingDelete();
  state.todos = parsed.todos;
  state.editingId = null;
  saveState();
  render();
}

// 파일을 읽어 JSON 파싱 → 스키마 검증 → 가져오기 순으로 처리한다.
function handleImportFile(file) {
  const reader = new FileReader();

  reader.onload = () => {
    let parsed;
    try {
      parsed = JSON.parse(reader.result);
    } catch (err) {
      console.error('가져오기 파일의 JSON 파싱에 실패했습니다.', err);
      alert('올바른 JSON 파일이 아닙니다. 가져오기를 취소합니다.');
      return;
    }

    const validationError = validateImportedData(parsed);
    if (validationError) {
      alert(`가져오기 실패: ${validationError}`);
      return;
    }

    importTodos(parsed);
  };

  reader.onerror = () => {
    console.error('파일을 읽는 중 오류가 발생했습니다.', reader.error);
    alert('파일을 읽는 중 오류가 발생했습니다.');
  };

  reader.readAsText(file);
}

// ===== 할 일 추가 =====
// 새 할 일을 생성해 배열 맨 앞에 추가한다.
function addTodo(title, category) {
  const todo = {
    id: generateId(),
    title,
    category,
    completed: false,
    createdAt: Date.now(),
    completedAt: null,
  };
  state.todos.unshift(todo);
  saveState();
  render();
}

// 완료 여부를 반전시키고 completedAt을 기록/해제한다.
function toggleTodo(id) {
  const todo = state.todos.find((t) => t.id === id);
  if (!todo) return;

  todo.completed = !todo.completed;
  todo.completedAt = todo.completed ? Date.now() : null;
  lastToggledId = id;
  saveState();
  render();
}

// ===== 카테고리 순환 변경 =====
// work → personal → study → work 순으로 배지를 클릭할 때마다 다음 카테고리로 바뀐다.
function cycleCategory(id) {
  const todo = state.todos.find((t) => t.id === id);
  if (!todo) return;

  const currentIndex = CATEGORY_ORDER.indexOf(todo.category);
  const nextIndex = (currentIndex + 1) % CATEGORY_ORDER.length;
  todo.category = CATEGORY_ORDER[nextIndex];
  saveState();
  render();
}

// ===== 인라인 수정 =====
// 한 번에 하나의 항목만 편집 모드에 들어갈 수 있다.
function startEditing(id) {
  const todo = state.todos.find((t) => t.id === id);
  if (!todo) return;

  state.editingId = id;
  render();
}

// 저장 없이 편집을 취소하고 원래 값으로 되돌린다.
function cancelEditing() {
  state.editingId = null;
  render();
}

// 편집 내용을 저장한다. 빈 값이면 원래 제목을 그대로 유지한다.
function commitEdit(id, rawTitle) {
  const todo = state.todos.find((t) => t.id === id);
  if (todo) {
    const trimmed = rawTitle.trim();
    if (trimmed.length > 0) {
      todo.title = trimmed;
    }
  }

  state.editingId = null;
  saveState();
  render();
}

// ===== 삭제 (Undo 지원) =====
// 클릭 즉시 배열에서 제거하고, 3초짜리 실행 취소 토스트를 띄운다.
function deleteTodo(id) {
  const index = state.todos.findIndex((t) => t.id === id);
  if (index === -1) return;

  // 이전 삭제가 아직 대기 중이었다면 이번 삭제로 확정(취소 불가)한다.
  finalizePendingDelete();

  const [removedTodo] = state.todos.splice(index, 1);
  saveState();
  render();
  showUndoToast(removedTodo, index);
}

// 완료된 항목 전체 삭제. 되돌릴 필요가 적은 일괄 작업이라 confirm()으로 확인만 받는다.
function clearCompletedTodos() {
  const hasCompleted = state.todos.some((t) => t.completed);
  if (!hasCompleted) return;

  const confirmed = confirm('완료된 항목을 모두 삭제할까요?');
  if (!confirmed) return;

  finalizePendingDelete();
  state.todos = state.todos.filter((t) => !t.completed);
  saveState();
  render();
}

// 대기 중인 Undo를 취소하고 삭제를 확정한다. (이미 배열에서는 제거된 상태)
function finalizePendingDelete() {
  if (!pendingDelete) return;
  clearTimeout(pendingDelete.timeoutId);
  pendingDelete = null;
  hideToast();
}

// 대기 중인 Undo를 실행해 삭제된 항목을 원래 위치에 복원한다.
function undoDelete() {
  if (!pendingDelete) return;

  clearTimeout(pendingDelete.timeoutId);
  state.todos.splice(pendingDelete.index, 0, pendingDelete.todo);
  pendingDelete = null;

  saveState();
  render();
  hideToast();
}

// ===== 필터링 / 정렬 / 진행률 계산 =====
// 카테고리 필터와 상태 필터를 교집합(AND)으로 적용한다.
function getFilteredTodos() {
  return state.todos.filter((todo) => {
    const matchesCategory =
      state.filters.category === 'all' || todo.category === state.filters.category;
    const matchesStatus =
      state.filters.status === 'all' ||
      (state.filters.status === 'active' && !todo.completed) ||
      (state.filters.status === 'completed' && todo.completed);
    return matchesCategory && matchesStatus;
  });
}

// 원본 배열(state.todos)은 생성 순서를 유지하고, 화면에 보여줄 때만 정렬한다.
function sortTodos(todos) {
  return [...todos].sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    return b.createdAt - a.createdAt;
  });
}

// 완료/전체 개수와 백분율(0으로 나누기 방지 포함)을 계산한다.
function calcProgress(todos) {
  const total = todos.length;
  const done = todos.filter((t) => t.completed).length;
  const percent = total === 0 ? 0 : Math.floor((done / total) * 100);
  return { total, done, percent };
}

// 카테고리 필터 탭에 표시할 개수. 항상 전체 데이터 기준(현재 필터와 무관)이다.
function getCategoryCounts() {
  const counts = { all: state.todos.length };
  for (const cat of CATEGORIES) {
    counts[cat.value] = state.todos.filter((t) => t.category === cat.value).length;
  }
  return counts;
}

// 카테고리별 진행률(완료/전체/백분율). 필터와 무관하게 항상 전체 데이터 기준으로 계산한다.
function calcCategoryBreakdown() {
  return CATEGORIES.map((cat) => {
    const todosInCategory = state.todos.filter((t) => t.category === cat.value);
    const total = todosInCategory.length;
    const done = todosInCategory.filter((t) => t.completed).length;
    const percent = total === 0 ? 0 : Math.floor((done / total) * 100);
    return { ...cat, total, done, percent };
  });
}

// ===== 렌더링 =====
// 전체 진행률은 필터와 무관하게 항상 state.todos(전체 데이터) 기준으로 계산한다.
function renderProgress() {
  const { total, done, percent } = calcProgress(state.todos);

  const barEl = document.getElementById('progress-bar');
  const fillEl = document.getElementById('progress-fill');
  const textEl = document.getElementById('progress-text');
  const celebrateEl = document.getElementById('progress-celebrate');

  fillEl.style.width = `${percent}%`;
  barEl.setAttribute('aria-valuenow', String(percent));
  textEl.textContent = `완료 ${done} / 전체 ${total} (${percent}%)`;
  celebrateEl.classList.toggle('hidden', !(total > 0 && percent === 100));

  renderCategoryProgress();
}

// 카테고리별 진행률을 가로 막대 차트 형태(라벨·개수·퍼센트 + 막대)로 그린다.
// innerHTML을 쓰지 않고 요소 생성 + textContent만 사용해 XSS를 차단한다.
function renderCategoryProgress() {
  const listEl = document.getElementById('category-progress-list');
  listEl.textContent = '';

  for (const cat of calcCategoryBreakdown()) {
    const itemEl = document.createElement('div');
    itemEl.className = 'category-progress-item';

    const rowEl = document.createElement('div');
    rowEl.className = 'category-progress-row';

    const dotEl = document.createElement('span');
    dotEl.className = 'category-progress-dot';
    dotEl.style.backgroundColor = cat.color;
    rowEl.appendChild(dotEl);

    const labelEl = document.createElement('span');
    labelEl.className = 'category-progress-label';
    labelEl.textContent = cat.label;
    rowEl.appendChild(labelEl);

    const countEl = document.createElement('span');
    countEl.className = 'category-progress-count';
    countEl.textContent = `${cat.done}/${cat.total}`;
    rowEl.appendChild(countEl);

    const percentEl = document.createElement('span');
    percentEl.className = 'category-progress-percent';
    percentEl.textContent = `${cat.percent}%`;
    rowEl.appendChild(percentEl);

    itemEl.appendChild(rowEl);

    const barEl = document.createElement('div');
    barEl.className = 'category-progress-bar';
    barEl.setAttribute('role', 'progressbar');
    barEl.setAttribute('aria-label', `${cat.label} 진행률`);
    barEl.setAttribute('aria-valuemin', '0');
    barEl.setAttribute('aria-valuemax', '100');
    barEl.setAttribute('aria-valuenow', String(cat.percent));

    const barFillEl = document.createElement('div');
    barFillEl.className = 'category-progress-fill';
    barFillEl.style.width = `${cat.percent}%`;
    barFillEl.style.backgroundColor = cat.color;
    barEl.appendChild(barFillEl);

    itemEl.appendChild(barEl);
    listEl.appendChild(itemEl);
  }
}

// 상태 필터 탭에 표시할 개수. 카테고리 필터와 무관하게 항상 전체 데이터 기준이다.
function getStatusCounts() {
  const done = state.todos.filter((t) => t.completed).length;
  return { all: state.todos.length, active: state.todos.length - done, completed: done };
}

// 필터 버튼 내부(카테고리 점 · 라벨 · 개수 배지)를 DOM으로 조립한다.
// innerHTML을 쓰지 않고 요소 생성 + textContent만 사용해 XSS를 차단한다.
function renderFilterBtnContent(btnEl, label, count, dotColor) {
  btnEl.textContent = '';

  if (dotColor) {
    const dotEl = document.createElement('span');
    dotEl.className = 'filter-btn-dot';
    dotEl.style.backgroundColor = dotColor;
    btnEl.appendChild(dotEl);
  }

  const labelEl = document.createElement('span');
  labelEl.className = 'filter-btn-label';
  labelEl.textContent = label;
  btnEl.appendChild(labelEl);

  const countEl = document.createElement('span');
  countEl.className = 'filter-btn-count';
  countEl.textContent = String(count);
  btnEl.appendChild(countEl);
}

// 필터 탭의 활성 상태와 카테고리별 개수를 갱신한다. (탭 자체는 고정 마크업이라 재생성하지 않는다)
function renderFilters() {
  const counts = getCategoryCounts();
  const statusCounts = getStatusCounts();

  const categoryGroupEl = document.getElementById('category-filters');
  for (const btnEl of categoryGroupEl.querySelectorAll('.filter-btn')) {
    const value = btnEl.dataset.value;
    const label = value === 'all' ? '전체' : getCategoryInfo(value).label;
    const dotColor = value === 'all' ? null : getCategoryInfo(value).color;
    renderFilterBtnContent(btnEl, label, counts[value], dotColor);
    btnEl.classList.toggle('active', state.filters.category === value);
    btnEl.classList.toggle('is-empty', counts[value] === 0);
  }

  const statusGroupEl = document.getElementById('status-filters');
  for (const btnEl of statusGroupEl.querySelectorAll('.filter-btn')) {
    const value = btnEl.dataset.value;
    renderFilterBtnContent(btnEl, STATUS_FILTER_LABELS[value], statusCounts[value], null);
    btnEl.classList.toggle('active', state.filters.status === value);
    btnEl.classList.toggle('is-empty', statusCounts[value] === 0);
  }
}

// 할 일 한 항목의 DOM 요소(체크박스/제목·수정입력/배지/수정·삭제 버튼)를 만든다.
function renderTodoItem(todo) {
  const itemEl = document.createElement('li');
  itemEl.className = 'todo-item';
  itemEl.dataset.id = todo.id;

  // 체크박스 자체는 작게 유지하되, label로 감싸 터치 타겟을 44x44로 확보한다.
  const checkboxWrapEl = document.createElement('label');
  checkboxWrapEl.className = 'todo-checkbox-wrap';
  if (todo.id === lastToggledId) {
    checkboxWrapEl.classList.add('just-toggled'); // 방금 토글된 항목만 체크 애니메이션 재생
  }

  const checkboxEl = document.createElement('input');
  checkboxEl.type = 'checkbox';
  checkboxEl.className = 'todo-checkbox';
  checkboxEl.checked = todo.completed;
  checkboxEl.dataset.action = 'toggle';
  checkboxEl.dataset.id = todo.id;
  checkboxEl.setAttribute('aria-label', '완료 체크');
  checkboxWrapEl.appendChild(checkboxEl);

  const isEditing = todo.id === state.editingId;
  let titleAreaEl;

  if (isEditing) {
    titleAreaEl = document.createElement('input');
    titleAreaEl.type = 'text';
    titleAreaEl.className = 'todo-edit-input';
    titleAreaEl.value = todo.title;
    titleAreaEl.maxLength = 200;
    titleAreaEl.dataset.id = todo.id;
  } else {
    titleAreaEl = document.createElement('span');
    titleAreaEl.className = todo.completed ? 'todo-title completed' : 'todo-title';
    titleAreaEl.textContent = todo.title;
  }

  const categoryInfo = getCategoryInfo(todo.category);
  const badgeEl = document.createElement('button');
  badgeEl.type = 'button';
  badgeEl.className = 'category-badge';
  badgeEl.textContent = categoryInfo.label;
  badgeEl.style.backgroundColor = categoryInfo.color;
  badgeEl.dataset.action = 'cycle-category';
  badgeEl.dataset.id = todo.id;
  badgeEl.setAttribute('aria-label', `카테고리: ${categoryInfo.label} (클릭하여 변경)`);

  const editEl = document.createElement('button');
  editEl.type = 'button';
  editEl.className = 'edit-btn';
  editEl.textContent = '✏️';
  editEl.dataset.action = 'edit';
  editEl.dataset.id = todo.id;
  editEl.setAttribute('aria-label', '수정');

  const deleteEl = document.createElement('button');
  deleteEl.type = 'button';
  deleteEl.className = 'delete-btn';
  deleteEl.textContent = '🗑';
  deleteEl.dataset.action = 'delete';
  deleteEl.dataset.id = todo.id;
  deleteEl.setAttribute('aria-label', '삭제');

  itemEl.append(checkboxWrapEl, titleAreaEl, badgeEl, editEl, deleteEl);
  return itemEl;
}

// 목록이 비었을 때(또는 필터 결과가 없을 때) 안내 문구 한 줄을 추가한다.
function renderEmptyMessage(listEl, message) {
  const emptyEl = document.createElement('li');
  emptyEl.className = 'empty-message';
  emptyEl.textContent = message;
  listEl.appendChild(emptyEl);
}

// 목록 영역(getFilteredTodos()의 결과) 전체를 매번 통째로 다시 그린다.
function renderList() {
  const listEl = document.getElementById('todo-list');
  listEl.textContent = '';

  if (state.todos.length === 0) {
    renderEmptyMessage(listEl, '할 일이 없습니다. 새로운 할 일을 추가해보세요.');
    return;
  }

  const visibleTodos = sortTodos(getFilteredTodos());

  if (visibleTodos.length === 0) {
    renderEmptyMessage(listEl, '조건에 맞는 할 일이 없습니다.');
    return;
  }

  for (const todo of visibleTodos) {
    listEl.appendChild(renderTodoItem(todo));
  }

  if (state.editingId) {
    const editInputEl = listEl.querySelector('.todo-edit-input');
    if (editInputEl) {
      editInputEl.focus();
      editInputEl.select();
    }
  }
}

// 진행률·필터·목록을 이 순서로 전부 다시 그리는 유일한 렌더링 진입점이다.
function render() {
  renderProgress();
  renderFilters();
  renderList();
  lastToggledId = null; // 체크 애니메이션은 한 번만 재생되도록 매 렌더 후 초기화한다.
}

// ===== 삭제 취소 토스트 =====
// 삭제된 항목을 3초 동안 복원 가능한 상태로 표시하며 토스트를 띄운다.
function showUndoToast(todo, index) {
  const timeoutId = setTimeout(() => {
    pendingDelete = null;
    hideToast();
  }, UNDO_DURATION_MS);

  pendingDelete = { todo, index, timeoutId };

  const toastEl = document.getElementById('toast');
  const messageEl = document.getElementById('toast-message');
  messageEl.textContent = '삭제되었습니다.';
  toastEl.classList.remove('hidden');
}

// 삭제 취소 토스트를 숨긴다.
function hideToast() {
  const toastEl = document.getElementById('toast');
  toastEl.classList.add('hidden');
}

// ===== 입력 유효성 검사 =====
// 공백만 있거나 비어있지 않고, 200자 이하인지 검사한다.
function isValidTitle(title) {
  return title.trim().length > 0 && title.length <= 200;
}

// 잘못된 입력 시 입력창에 시각적 피드백(테두리 색 변화 + 흔들림)을 준다.
function showInputError(inputEl) {
  inputEl.classList.add('input-error');
  setTimeout(() => {
    inputEl.classList.remove('input-error');
  }, 300);
}

// ===== 이벤트 등록 =====
// 추가 폼 제출(Enter 또는 버튼 클릭)을 처리한다.
function setupAddFormEvents() {
  const formEl = document.getElementById('add-form');
  const inputEl = document.getElementById('add-input');
  const categorySelectEl = document.getElementById('add-category');

  // 사용자가 카테고리를 직접 바꾸면, 자동 분류가 그 선택을 덮어쓰지 않도록 막는다.
  let isCategoryManuallySet = false;
  categorySelectEl.addEventListener('change', () => {
    isCategoryManuallySet = true;
  });

  // 입력하는 동안 키워드가 감지되면 카테고리를 자동으로 맞춰준다.
  inputEl.addEventListener('input', () => {
    if (isCategoryManuallySet) return;

    const detected = detectCategoryByKeyword(inputEl.value);
    if (detected) {
      categorySelectEl.value = detected;
    }
  });

  formEl.addEventListener('submit', (event) => {
    event.preventDefault();

    const title = inputEl.value;
    if (!isValidTitle(title)) {
      showInputError(inputEl);
      return;
    }

    addTodo(title.trim(), categorySelectEl.value || 'work');
    inputEl.value = '';
    inputEl.focus();
    isCategoryManuallySet = false; // 다음 입력을 위해 자동 분류를 다시 활성화한다.
    // categorySelectEl 값은 초기화하지 않는다 → 같은 카테고리 연속 입력 대응
  });
}

// 목록 컨테이너 하나에만 리스너를 걸고, data-action/data-id로 분기하는 이벤트 위임.
function setupListEvents() {
  const listEl = document.getElementById('todo-list');

  listEl.addEventListener('click', (event) => {
    const targetEl = event.target.closest('[data-action]');
    if (!targetEl) return;

    const { action, id } = targetEl.dataset;
    if (action === 'toggle') {
      toggleTodo(id);
    } else if (action === 'delete') {
      deleteTodo(id);
    } else if (action === 'cycle-category') {
      cycleCategory(id);
    } else if (action === 'edit') {
      startEditing(id);
    }
  });

  // 제목을 더블클릭하면 편집 모드로 진입한다.
  listEl.addEventListener('dblclick', (event) => {
    const titleEl = event.target.closest('.todo-title');
    if (!titleEl) return;

    const itemEl = titleEl.closest('.todo-item');
    startEditing(itemEl.dataset.id);
  });

  // 편집 중 Enter → 저장, Esc → 취소.
  listEl.addEventListener('keydown', (event) => {
    const inputEl = event.target.closest('.todo-edit-input');
    if (!inputEl) return;

    if (event.key === 'Enter') {
      event.preventDefault();
      commitEdit(inputEl.dataset.id, inputEl.value);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelEditing();
    }
  });

  // 편집 중 다른 곳을 클릭(blur)하면 자동 저장한다.
  // editingId가 이미 바뀌었다면(Enter/Esc로 이미 처리됨) 중복 저장을 건너뛴다.
  listEl.addEventListener('focusout', (event) => {
    const inputEl = event.target.closest('.todo-edit-input');
    if (!inputEl) return;
    if (state.editingId !== inputEl.dataset.id) return;

    commitEdit(inputEl.dataset.id, inputEl.value);
  });
}

// 필터 그룹 전체에 리스너 하나만 걸고, data-filter-type/data-value로 분기하는 이벤트 위임.
function setupFilterEvents() {
  const filtersEl = document.getElementById('filters');

  filtersEl.addEventListener('click', (event) => {
    const btnEl = event.target.closest('.filter-btn');
    if (!btnEl) return;

    const groupEl = btnEl.closest('[data-filter-type]');
    const filterType = groupEl.dataset.filterType;
    state.filters[filterType] = btnEl.dataset.value;
    saveFilters();
    render();
  });
}

// 내보내기/가져오기 버튼과 숨겨진 파일 입력의 이벤트를 연결한다.
function setupImportExportEvents() {
  document.getElementById('export-btn').addEventListener('click', exportTodos);

  const importBtnEl = document.getElementById('import-btn');
  const importFileInputEl = document.getElementById('import-file-input');

  importBtnEl.addEventListener('click', () => {
    // 같은 파일을 연속으로 선택해도 change 이벤트가 발생하도록 매번 값을 비운다.
    importFileInputEl.value = '';
    importFileInputEl.click();
  });

  importFileInputEl.addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (!file) return;
    handleImportFile(file);
  });
}

// "완료된 항목 삭제" 버튼에 리스너를 등록한다.
function setupClearCompletedEvents() {
  const clearBtnEl = document.getElementById('clear-completed-btn');
  clearBtnEl.addEventListener('click', clearCompletedTodos);
}

// 토스트의 "실행 취소" 버튼에 리스너를 등록한다.
function setupToastEvents() {
  const undoBtnEl = document.getElementById('toast-undo-btn');
  undoBtnEl.addEventListener('click', undoDelete);
}

// 다크 모드 토글 버튼에 리스너를 등록한다.
function setupThemeEvents() {
  document.getElementById('theme-toggle-btn').addEventListener('click', toggleTheme);
}

// 위에서 정의한 모든 이벤트 등록 함수를 한 번씩 호출한다.
function setupEvents() {
  setupAddFormEvents();
  setupListEvents();
  setupClearCompletedEvents();
  setupToastEvents();
  setupFilterEvents();
  setupImportExportEvents();
  setupThemeEvents();
  setupAuthEvents();
}

// ===== 초기화 =====
// 필터·테마를 복원하고 이벤트를 등록한 뒤, 로그인 상태에 맞는 화면을 보여준다.
function init() {
  loadFilters();
  loadTheme();
  applyTheme();
  setupEvents();

  if (!SUPABASE_CONFIGURED) {
    renderAuthView();
    showAuthMessage('app.js 맨 위의 SUPABASE_URL과 SUPABASE_ANON_KEY를 먼저 입력해야 합니다.', true);
    setAuthBusy(true);
    return;
  }

  // 저장된 로그인 정보가 있으면 기기 캐시로 먼저 그린 뒤 클라우드 데이터로 갱신한다.
  storeSession(loadSession());
  loadCachedTodos();
  renderAuthView();
  render();
  restoreSession(); // 네트워크 작업이라 await 없이 fire-and-forget으로 실행한다.
}

// 이메일 인증 링크로 돌아왔는지 확인하고, 로그인 상태면 클라우드 데이터를 불러온다.
async function restoreSession() {
  try {
    if (await consumeAuthRedirect()) {
      await startUserSession();
      return;
    }
  } catch (err) {
    console.error('인증 링크 처리에 실패했습니다.', err);
  }
  if (state.user) await loadFromCloud();
}

init();
