// ===== 상수 =====
const STORAGE_KEY = 'dailyfocus.todos.v1';
const STORAGE_VERSION = 1;
const FILTERS_STORAGE_KEY = 'dailyfocus.filters.v1';
const THEME_STORAGE_KEY = 'dailyfocus.theme.v1';
const VALID_THEMES = ['light', 'dark'];
const UNDO_DURATION_MS = 3000;

// File System Access API는 Chromium 계열(엣지/크롬)에서만 지원한다.
const FILE_SYSTEM_API_SUPPORTED = 'showSaveFilePicker' in window;
const FILE_HANDLE_DB_NAME = 'dailyfocus-filehandle-db';
const FILE_HANDLE_STORE_NAME = 'handles';
const FILE_HANDLE_KEY = 'linkedFile';

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
  storageMode: 'local', // 'local' | 'file'. saveState()/loadState()가 어디를 대상으로 할지 결정한다.
};

// 삭제 취소(Undo) 대기 정보. 토스트가 떠 있는 동안만 값이 존재한다.
let pendingDelete = null;

// 방금 체크 토글된 항목 id. 체크 애니메이션을 이번 렌더링에서만 재생하기 위한 임시 표시.
let lastToggledId = null;

// 연결된 파일 핸들/이름. FileSystemFileHandle은 직렬화 대상이 아니라 state 밖에 둔다.
let linkedFileHandle = null;
let linkedFileName = null;

// 재연결 대기 중(권한 재승인 필요) 상태에서만 값이 존재한다.
let pendingReconnectHandle = null;

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

// ===== localStorage 연동 =====
// localStorage → state 복원. 파싱 실패나 접근 불가 시 빈 배열로 시작한다.
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;

    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.todos)) {
      state.todos = parsed.todos;
    }
  } catch (err) {
    console.error('저장된 데이터를 불러오지 못했습니다. 빈 목록으로 시작합니다.', err);
    state.todos = [];
  }
}

// state → 현재 저장소(localStorage 또는 연결된 파일)에 저장.
// 호출부는 지금처럼 await 없이 saveState()만 호출한다(fire-and-forget). 실패해도 이 함수 안에서 배너로 알린다.
async function saveState() {
  const payload = {
    version: STORAGE_VERSION,
    todos: state.todos,
  };
  const json = JSON.stringify(payload);

  try {
    if (state.storageMode === 'file' && linkedFileHandle) {
      await writeToLinkedFile(json);
    } else {
      localStorage.setItem(STORAGE_KEY, json);
    }
    hideStorageWarning();
  } catch (err) {
    console.error('데이터를 저장하지 못했습니다.', err);
    const message =
      state.storageMode === 'file'
        ? '연결된 파일에 저장하지 못했습니다. OneDrive 동기화 상태를 확인해주세요.'
        : '저장 공간이 가득 찼거나 접근할 수 없어 변경사항이 저장되지 않았습니다.';
    showStorageWarning(message);
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

// state.filters → localStorage 저장. 실패해도 앱은 계속 동작하되 사용자에게 배너로 알린다.
function saveFilters() {
  try {
    localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(state.filters));
    hideStorageWarning();
  } catch (err) {
    console.error('필터를 저장하지 못했습니다.', err);
    showStorageWarning('저장 공간이 가득 찼거나 접근할 수 없어 필터 설정이 저장되지 않았습니다.');
  }
}

// ===== 파일 동기화 (File System Access API) =====
// FileSystemFileHandle은 구조화 복제가 가능해 IndexedDB에 그대로 저장할 수 있다.
// localStorage에는 객체를 저장할 수 없어, "어떤 파일에 연결했었는지" 기억하려면 IndexedDB가 필요하다.
function openHandleDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(FILE_HANDLE_DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(FILE_HANDLE_STORE_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// 연결한 파일 핸들을 IndexedDB에 저장한다.
async function saveFileHandleToDb(handle) {
  const db = await openHandleDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FILE_HANDLE_STORE_NAME, 'readwrite');
    tx.objectStore(FILE_HANDLE_STORE_NAME).put(handle, FILE_HANDLE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// IndexedDB에 저장된 파일 핸들을 불러온다. 없으면 null을 반환한다.
async function loadFileHandleFromDb() {
  const db = await openHandleDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FILE_HANDLE_STORE_NAME, 'readonly');
    const req = tx.objectStore(FILE_HANDLE_STORE_NAME).get(FILE_HANDLE_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

// 연결 해제 시 IndexedDB에 저장된 파일 핸들을 지운다.
async function clearFileHandleFromDb() {
  const db = await openHandleDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FILE_HANDLE_STORE_NAME, 'readwrite');
    tx.objectStore(FILE_HANDLE_STORE_NAME).delete(FILE_HANDLE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// 연결된 파일에 JSON 문자열을 덮어쓴다.
async function writeToLinkedFile(json) {
  const writable = await linkedFileHandle.createWritable();
  await writable.write(json);
  await writable.close();
}

// 연결된 파일의 내용을 읽어 파싱한다. 비어있거나 파싱 실패 시 null을 반환한다.
async function readLinkedFile(handle) {
  const file = await handle.getFile();
  const text = await file.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    console.error('연결된 파일의 JSON 파싱에 실패했습니다.', err);
    return null;
  }
}

// 파일 모드로 전환하고 화면/상태 표시를 갱신한다.
function activateFileMode(handle) {
  linkedFileHandle = handle;
  linkedFileName = handle.name;
  state.storageMode = 'file';
  pendingReconnectHandle = null;
  renderFileSyncStatus();
}

// 사용자가 "파일 연결" 버튼을 눌렀을 때: 파일 선택/생성 → 기존 내용과 비교 → 연결 확정.
async function connectFile() {
  let handle;
  try {
    handle = await window.showSaveFilePicker({
      suggestedName: 'daily-focus-data.json',
      types: [{ description: 'JSON 파일', accept: { 'application/json': ['.json'] } }],
    });
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('파일 선택 중 오류가 발생했습니다.', err);
    }
    return; // 사용자가 취소한 경우 포함
  }

  const parsed = await readLinkedFile(handle);
  const hasValidFileData = parsed && Array.isArray(parsed.todos);

  if (hasValidFileData && parsed.todos.length > 0) {
    const validationError = validateImportedData(parsed);
    const isSameAsCurrent = JSON.stringify(parsed.todos) === JSON.stringify(state.todos);

    if (!validationError && !isSameAsCurrent) {
      const useFileData = confirm(
        `연결한 파일에 이미 ${parsed.todos.length}개의 할 일이 있습니다. 이 파일의 내용을 불러올까요?\n` +
          `(취소하면 현재 화면의 데이터로 파일을 덮어씁니다)`
      );
      if (useFileData) {
        finalizePendingDelete();
        state.todos = parsed.todos;
        state.editingId = null;
      }
    }
  }

  activateFileMode(handle);
  await saveFileHandleToDb(handle);
  await saveState();
  render();
}

// "연결 해제" 버튼: 로컬 모드로 되돌리고 현재 데이터를 localStorage에 즉시 저장한다.
async function disconnectFile() {
  linkedFileHandle = null;
  linkedFileName = null;
  state.storageMode = 'local';
  pendingReconnectHandle = null;
  await clearFileHandleFromDb();
  await saveState();
  renderFileSyncStatus();
}

// 재연결 버튼: 저장돼있던 핸들에 다시 권한을 요청한다(사용자 제스처 필요).
async function reconnectFile() {
  if (!pendingReconnectHandle) return;
  const handle = pendingReconnectHandle;

  try {
    const permission = await handle.requestPermission({ mode: 'readwrite' });
    if (permission !== 'granted') return;
  } catch (err) {
    console.error('파일 재연결 권한 요청에 실패했습니다.', err);
    return;
  }

  const parsed = await readLinkedFile(handle);
  if (parsed && Array.isArray(parsed.todos)) {
    state.todos = parsed.todos;
  }
  activateFileMode(handle);
  render();
}

// 앱 시작 시 이전에 연결했던 파일이 있는지 확인하고, 가능하면 조용히 재연결한다.
// 동기 초기 렌더링을 막지 않도록 init()에서 await 없이 호출한다(fire-and-forget).
async function initFileSync() {
  if (!FILE_SYSTEM_API_SUPPORTED) return;

  let handle;
  try {
    handle = await loadFileHandleFromDb();
  } catch (err) {
    console.error('연결된 파일 정보를 불러오지 못했습니다.', err);
    return;
  }
  if (!handle) return;

  const permission = await handle.queryPermission({ mode: 'readwrite' });
  if (permission === 'granted') {
    const parsed = await readLinkedFile(handle);
    if (parsed && Array.isArray(parsed.todos)) {
      state.todos = parsed.todos;
    }
    activateFileMode(handle);
    render();
  } else {
    pendingReconnectHandle = handle;
    linkedFileName = handle.name;
    renderFileSyncStatus();
  }
}

// 파일 연결 상태를 헤더 아래 상태 문단에 표시한다(연결됨 / 재연결 필요 / 숨김).
// innerHTML을 쓰지 않고 요소 생성 + textContent만 사용해 XSS를 차단한다.
function renderFileSyncStatus() {
  const statusEl = document.getElementById('file-sync-status');
  statusEl.textContent = '';

  if (state.storageMode === 'file' && linkedFileHandle) {
    const textEl = document.createElement('span');
    textEl.textContent = `🔗 연결됨: ${linkedFileName}`;
    statusEl.appendChild(textEl);

    const disconnectBtnEl = document.createElement('button');
    disconnectBtnEl.type = 'button';
    disconnectBtnEl.className = 'file-sync-action-btn';
    disconnectBtnEl.textContent = '연결 해제';
    disconnectBtnEl.dataset.action = 'disconnect-file';
    statusEl.appendChild(disconnectBtnEl);

    statusEl.classList.remove('hidden');
  } else if (pendingReconnectHandle) {
    const textEl = document.createElement('span');
    textEl.textContent = `🔗 연결된 파일(${linkedFileName}) 재연결이 필요합니다`;
    statusEl.appendChild(textEl);

    const reconnectBtnEl = document.createElement('button');
    reconnectBtnEl.type = 'button';
    reconnectBtnEl.className = 'file-sync-action-btn';
    reconnectBtnEl.textContent = '재연결';
    reconnectBtnEl.dataset.action = 'reconnect-file';
    statusEl.appendChild(reconnectBtnEl);

    statusEl.classList.remove('hidden');
  } else {
    statusEl.classList.add('hidden');
  }
}

// 파일 연결/해제/재연결 버튼의 이벤트를 연결한다.
function setupFileSyncEvents() {
  if (!FILE_SYSTEM_API_SUPPORTED) {
    document.getElementById('file-link-btn').classList.add('hidden');
    return;
  }

  document.getElementById('file-link-btn').addEventListener('click', connectFile);

  document.getElementById('file-sync-status').addEventListener('click', (event) => {
    const btnEl = event.target.closest('[data-action]');
    if (!btnEl) return;

    if (btnEl.dataset.action === 'disconnect-file') {
      disconnectFile();
    } else if (btnEl.dataset.action === 'reconnect-file') {
      reconnectFile();
    }
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
// localStorage 저장이 실패할 때만 노출하고, 다음 저장이 성공하면 자동으로 숨긴다.
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
  setupFileSyncEvents();
}

// ===== 초기화 =====
// 저장된 데이터·필터·테마를 복원하고 이벤트를 등록한 뒤 최초 렌더링을 수행한다.
function init() {
  loadState();
  loadFilters();
  loadTheme();
  applyTheme();
  setupEvents();
  render();
  initFileSync(); // 파일 연결 확인은 비동기라 await 없이 fire-and-forget으로 실행한다.
}

init();
