'use strict';
/* 음악 스튜디오 프론트엔드 (SPA) */

const $app = document.getElementById('app');
let pollTimer = null;
let currentSynthControl = null;

document.getElementById('logo').onclick = () => { location.hash = '#/'; };

// ---------------- 공통 유틸 ----------------

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function toast(msg, isErr) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = ''; }, isErr ? 5000 : 2600);
}

async function api(method, url, body) {
  const opt = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opt.body = JSON.stringify(body);
  const res = await fetch(url, opt);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('요청 실패 (' + res.status + ')'));
  return data;
}

function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

function statusBadges(song) {
  let html = '';
  if (song.running_job || (song.last_job && song.last_job.status === 'running')) {
    const t = song.running_job || song.last_job.type;
    html += `<span class="badge working">⏳ ${t === 'lyrics' ? '작사 중' : '작곡 중'}</span>`;
  }
  if (song.has_lyrics || (song.lyrics && song.lyrics.trim())) html += '<span class="badge lyrics">가사</span>';
  if (song.has_score || (song.abc && song.abc.trim())) html += '<span class="badge score">악보</span>';
  if (!html) html = '<span class="badge draft">초안</span>';
  return html;
}

const INSTRUMENTS = ['피아노(메인)', '세컨 피아노', '일렉 기타', '드럼', '베이스', '어쿠스틱 기타', '스트링(현악)', '바이올린', '첼로', '플루트', '신시사이저', '오르간', '트럼펫'];
const DEFAULT_INST_COUNT = 4; // 앞에서부터 기본 선택되는 악기 수

// ---------------- 라우터 ----------------

window.addEventListener('hashchange', route);
window.addEventListener('load', route);

function route() {
  stopPolling();
  if (currentSynthControl) { try { currentSynthControl.pause(); } catch (e) {} currentSynthControl = null; }
  const hash = location.hash || '#/';
  const m = hash.match(/^#\/song\/(\d+)/);
  if (m) return renderDetail(Number(m[1]));
  if (hash === '#/new') return renderNewForm();
  renderList();
}

// ---------------- 목록 화면 ----------------

async function renderList() {
  $app.innerHTML = '<div class="empty">불러오는 중...</div>';
  let songs;
  try { songs = await api('GET', '/api/songs'); }
  catch (e) { $app.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }

  let html = `<div class="list-head">
    <h2>작업 목록 <span style="font-size:13px;color:#8a90a5;font-weight:400">(${songs.length}곡)</span></h2>
    <button class="big" onclick="location.hash='#/new'">＋ 새 곡 만들기</button>
  </div>`;

  if (!songs.length) {
    html += `<div class="card empty">아직 만든 곡이 없습니다.<br><br>「새 곡 만들기」를 눌러 첫 곡을 시작해 보세요! 🎶</div>`;
  } else {
    for (const s of songs) {
      html += `<div class="song-item" onclick="location.hash='#/song/${s.id}'">
        <div class="num">${s.id}회차</div>
        <div class="info">
          <div class="title">${esc(s.title)} ${statusBadges(s)}</div>
          <div class="meta">${esc(s.mood || s.direction || '')} · ${esc(s.instruments)} · ${esc(s.created_at)}</div>
        </div>
        <div>›</div>
      </div>`;
    }
  }
  $app.innerHTML = html;

  // 진행 중 작업이 있으면 목록 자동 갱신
  if (songs.some(s => s.running_job)) {
    pollTimer = setInterval(async () => {
      try {
        const latest = await api('GET', '/api/songs');
        if (!latest.some(s => s.running_job)) { stopPolling(); renderList(); }
      } catch (e) {}
    }, 4000);
  }
}

// ---------------- 새 곡 화면 ----------------

function renderNewForm() {
  const instHtml = INSTRUMENTS.map((n, i) =>
    `<label><input type="checkbox" class="inst-chk" value="${esc(n)}" ${i < DEFAULT_INST_COUNT ? 'checked' : ''}> ${esc(n)}</label>`).join('');
  $app.innerHTML = `
  <div class="card">
    <h2>🎼 새 곡 만들기</h2>
    <label class="field">곡 제목 <span style="font-weight:400;color:#999">(비워두면 AI가 지어줍니다)</span>
      <input type="text" id="f-title" placeholder="예: 여름밤의 약속">
    </label>
    <label class="field">방향 / 주제 <span style="color:#c33">*</span>
      <textarea id="f-direction" rows="3" placeholder="예: 오랜 친구와의 재회를 그린 따뜻한 발라드. 1절은 추억 회상, 후렴은 벅찬 반가움."></textarea>
    </label>
    <label class="field">분위기
      <input type="text" id="f-mood" placeholder="예: 잔잔한, 따뜻한, 그리움, 어쿠스틱 감성">
    </label>
    <label class="field">편성 악기 (여러 개 선택 가능)
      <div class="inst-grid">${instHtml}</div>
      <input type="text" id="f-inst-extra" placeholder="추가 악기 직접 입력 (쉼표로 구분, 예: 하모니카, 우쿨렐레)" style="margin-top:8px">
    </label>
    <label class="field">참고 가사 / 꼭 들어갈 키워드 <span style="font-weight:400;color:#999">(선택)</span>
      <textarea id="f-lyrics-input" rows="4" placeholder="직접 쓴 가사 초안이나 꼭 넣고 싶은 문구·키워드가 있으면 적어주세요."></textarea>
    </label>
    <label style="display:flex;align-items:center;gap:8px;font-size:14px;margin-bottom:6px">
      <input type="checkbox" id="f-auto" checked> 만들자마자 바로 AI 작사 시작
    </label>
    <p class="hint" style="margin-bottom:14px">💡 기존 음악 파일이나 악보(이미지·MIDI·ABC 등)를 바탕으로 작업하려면, 곡을 만든 뒤 상세 화면의 「📎 참고 자료」에서 파일을 첨부하세요. (이 경우 위 체크를 해제하고 첨부 후 작사를 시작하는 것을 추천)</p>
    <div class="btnrow">
      <button class="big" id="btn-create">곡 만들기 🎵</button>
      <button class="secondary" onclick="location.hash='#/'">취소</button>
    </div>
  </div>`;

  document.getElementById('btn-create').onclick = async () => {
    const direction = document.getElementById('f-direction').value.trim();
    if (!direction) { toast('방향/주제를 입력해 주세요.', true); return; }
    const checked = [...document.querySelectorAll('.inst-chk:checked')].map(c => c.value);
    const extra = document.getElementById('f-inst-extra').value.split(',').map(s => s.trim()).filter(Boolean);
    const instruments = [...checked, ...extra];
    if (!instruments.length) { toast('악기를 하나 이상 선택해 주세요.', true); return; }
    const btn = document.getElementById('btn-create');
    btn.disabled = true; btn.textContent = '만드는 중...';
    try {
      const r = await api('POST', '/api/songs', {
        title: document.getElementById('f-title').value,
        direction,
        mood: document.getElementById('f-mood').value,
        instruments: instruments.join(', '),
        lyricsInput: document.getElementById('f-lyrics-input').value,
        autoLyrics: document.getElementById('f-auto').checked,
      });
      toast('곡이 생성되었습니다!');
      location.hash = '#/song/' + r.id;
    } catch (e) {
      toast(e.message, true);
      btn.disabled = false; btn.textContent = '곡 만들기 🎵';
    }
  };
}

// ---------------- 상세 화면 ----------------

async function renderDetail(id) {
  $app.innerHTML = '<div class="empty">불러오는 중...</div>';
  let song;
  try { song = await api('GET', '/api/songs/' + id); }
  catch (e) { $app.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }

  const running = song.last_job && song.last_job.status === 'running';
  const jobErr = song.last_job && song.last_job.status === 'error';
  const hasLyrics = song.lyrics && song.lyrics.trim();
  const hasScore = song.abc && song.abc.trim();

  let html = `
  <div class="detail-head">
    <button class="secondary" onclick="location.hash='#/'">← 목록</button>
    <span class="num" style="background:#efeaff;color:#5b4a9e;border-radius:8px;padding:8px 12px;font-weight:700">${id}회차</span>
    <input type="text" id="d-title" value="${esc(song.title)}">
    <button class="danger" id="btn-del">삭제</button>
  </div>`;

  if (running) {
    html += `<div class="job-banner"><div class="spinner"></div>
      <div><b>${song.last_job.type === 'lyrics' ? 'AI가 작사 중입니다...' : 'AI가 작곡·편곡 중입니다...'}</b>
      <span id="job-elapsed"></span><br>
      <span style="font-size:12px">보통 1~5분 정도 걸립니다. 완료되면 화면이 자동으로 갱신됩니다.</span></div></div>`;
  } else if (jobErr) {
    html += `<div class="job-banner error">⚠️ 마지막 작업이 실패했습니다: ${esc(song.last_job.error)}<br>
      <span style="font-size:12px">아래 버튼으로 다시 시도해 주세요.</span></div>`;
  }

  // --- 곡 정보 ---
  html += `
  <div class="card">
    <h2>📋 곡 정보</h2>
    <div class="row">
      <label class="field">방향 / 주제
        <textarea id="d-direction" rows="3">${esc(song.direction)}</textarea>
      </label>
      <label class="field">분위기
        <input type="text" id="d-mood" value="${esc(song.mood)}">
      </label>
    </div>
    <div class="row">
      <label class="field">편성 악기 (쉼표로 구분)
        <input type="text" id="d-instruments" value="${esc(song.instruments)}">
      </label>
      <label class="field">참고 가사 / 키워드
        <textarea id="d-lyrics-input" rows="3">${esc(song.lyrics_input)}</textarea>
      </label>
    </div>
    <div class="btnrow"><button class="secondary" id="btn-save-info">정보 저장</button></div>
  </div>`;

  // --- 참고 자료 첨부 ---
  const KIND_LABEL = { abc: 'ABC 악보', musicxml: 'MusicXML', midi: 'MIDI', image: '악보 이미지', audio: '오디오', text: '텍스트' };
  const atts = song.attachments || [];
  html += `
  <div class="card">
    <h2>📎 참고 자료 <span style="font-size:12px;font-weight:400;color:#8a90a5">기존 음악/악보를 첨부하면 다음 작사·작곡(재생성) 때 AI가 분석하여 반영합니다</span></h2>
    <div id="att-list">
      ${atts.map(a => {
        const meta = (() => { try { return JSON.parse(a.meta || '{}'); } catch (e) { return {}; } })();
        let extra = '';
        if (a.kind === 'audio') {
          const mi = [meta.duration ? `약 ${meta.duration}초` : '', meta.bpm ? `추정 ${meta.bpm} BPM` : ''].filter(Boolean).join(' · ');
          extra = `<div style="margin-top:6px">${mi ? `<span class="hint">${esc(mi)}</span><br>` : ''}<audio controls preload="none" src="/api/attachments/${a.id}/file" style="height:32px;max-width:280px"></audio></div>`;
        } else if (a.kind === 'image') {
          extra = `<div style="margin-top:6px"><img src="/api/attachments/${a.id}/file" alt="" style="max-height:90px;border-radius:6px;border:1px solid #e2e4ee"></div>`;
        }
        return `<div class="ver-item" style="align-items:flex-start">
          <span class="k" style="color:#5b4a9e;width:auto;white-space:nowrap">${KIND_LABEL[a.kind] || a.kind}</span>
          <span class="note"><b>${esc(a.filename)}</b>${a.note ? '<br>' + esc(a.note) : ''}${extra}</span>
          <span class="date">${esc(a.created_at)}</span>
          <button class="danger" data-att-del="${a.id}">삭제</button>
        </div>`;
      }).join('') || '<div class="hint" style="padding:4px 0 10px">첨부된 자료가 없습니다. 악보(.abc .xml .mid), 악보 이미지(.png .jpg), 오디오(.mp3 .wav) 파일을 첨부할 수 있습니다.</div>'}
    </div>
    <div class="btnrow" style="margin-top:12px">
      <input type="file" id="att-file" accept=".abc,.txt,.xml,.musicxml,.mid,.midi,.png,.jpg,.jpeg,.webp,.gif,.mp3,.wav,.ogg,.m4a,.flac" style="flex:1;min-width:200px">
      <input type="text" id="att-note" placeholder="활용 메모 (예: 이 곡의 후렴 멜로디를 참고해서 개선)" style="flex:2;min-width:220px">
      <button id="btn-att-up">📎 첨부</button>
    </div>
  </div>`;

  // --- 가사 ---
  html += `
  <div class="card">
    <h2>✍️ 가사
      <span class="spacer"></span>
      ${hasLyrics ? '<button class="secondary" id="btn-edit-lyrics">직접 수정</button>' : ''}
    </h2>
    <div id="lyrics-view">${hasLyrics ? `<pre class="lyrics-view">${esc(song.lyrics)}</pre>` : '<div class="empty" style="padding:20px 0">아직 가사가 없습니다.</div>'}</div>
    <div id="lyrics-edit" style="display:none">
      <textarea id="d-lyrics" rows="14">${esc(song.lyrics)}</textarea>
      <div class="btnrow">
        <button id="btn-save-lyrics">가사 저장</button>
        <button class="secondary" id="btn-cancel-lyrics">취소</button>
      </div>
    </div>
    <label class="field" style="margin-top:14px">AI에게 전달할 요청/피드백 (선택)
      <input type="text" id="fb-lyrics" placeholder="예: 후렴을 더 희망차게, 2절에 바다 이미지 추가">
    </label>
    <div class="btnrow">
      <button id="btn-gen-lyrics" ${running ? 'disabled' : ''}>${hasLyrics ? '🔄 가사 재생성' : '✨ AI 작사 시작'}</button>
    </div>
  </div>`;

  // --- 악보 ---
  html += `
  <div class="card">
    <h2>🎼 전체 악보
      <span class="spacer"></span>
      ${hasScore ? '<button class="secondary" id="btn-edit-abc">ABC 소스 편집</button>' : ''}
    </h2>
    ${song.arrangement_notes ? `<div class="notes">🎹 편곡 노트: ${esc(song.arrangement_notes)}</div>` : ''}
    <div id="abc-edit" style="display:none;margin-bottom:12px">
      <textarea id="d-abc" class="mono" rows="16">${esc(song.abc)}</textarea>
      <div class="btnrow">
        <button id="btn-save-abc">악보 저장 &amp; 다시 그리기</button>
        <button class="secondary" id="btn-cancel-abc">취소</button>
      </div>
    </div>
    <div id="score-main" class="score-box">${hasScore ? '' : '<div class="empty" style="padding:20px 0">아직 악보가 없습니다. 가사를 만든 뒤 작곡을 시작하세요.</div>'}</div>
    <div id="score-warnings"></div>
    <label class="field" style="margin-top:14px">AI에게 전달할 요청/피드백 (선택)
      <input type="text" id="fb-score" placeholder="예: 템포를 느리게, 간주 추가, 기타 아르페지오 위주로">
    </label>
    <div class="btnrow">
      <button id="btn-gen-score" ${running || !hasLyrics ? 'disabled' : ''}>${hasScore ? '🔄 재작곡' : '🎹 이 가사로 작곡 시작'}</button>
      ${!hasLyrics ? '<span class="hint">가사가 먼저 필요합니다.</span>' : ''}
    </div>
  </div>`;

  // --- 오디오 ---
  if (hasScore) {
    html += `
    <div class="card">
      <h2>🔊 음악 재생 &amp; 파일 만들기</h2>
      <div id="audio-widget"></div>
      <div class="audio-opts">
        <label><input type="checkbox" id="opt-fx" checked> 이펙트 적용 (리버브·컴프레서)</label>
        <label>공간감(리버브) <input type="range" id="opt-reverb" min="0" max="60" value="25"></label>
        <label>볼륨 <input type="range" id="opt-gain" min="50" max="150" value="100"></label>
        <label><input type="checkbox" id="opt-mr"> 보컬 제외 — MR 반주만 (가창 합성과 합칠 때 사용)</label>
      </div>
      <div class="btnrow">
        <button id="btn-wav">🎧 WAV 음악파일 만들기 (다운로드)</button>
        <button class="secondary" id="btn-midi">MIDI 파일 다운로드</button>
        <span class="hint">음원 생성에는 인터넷 연결이 필요합니다 (악기 사운드폰트 로딩).</span>
      </div>
      <div style="margin-top:14px;padding:12px 14px;background:#f4f8f4;border-radius:8px">
        <b style="font-size:14px">🎤 실제 목소리 가창 (OpenUTAU 연동)</b>
        <p class="hint" style="margin:6px 0 8px">내장 신디사이저는 보컬을 허밍 음색으로만 연주합니다. 실제로 가사를 부르는 음원을 만들려면 무료 가창 합성 프로그램 <b>OpenUTAU</b>(+ 한국어 DiffSinger 보이스뱅크)를 사용하세요. 아래 버튼으로 보컬 악보+가사를 UST 파일로 내보낸 뒤, OpenUTAU에서 열어 가수를 지정하고 WAV로 내보내면 됩니다. 반주는 위의 「보컬 제외(MR)」로 만들어 합치면 완성입니다. (자세한 방법은 README 참고)</p>
        <button class="secondary" id="btn-ust">🎤 보컬 UST 내보내기 (OpenUTAU용)</button>
      </div>
    </div>`;
  }

  // --- 악기별 파트 ---
  if (song.parts && song.parts.length) {
    html += `
    <div class="card">
      <h2>🎻 악기별 반주 악보</h2>
      <div class="tabs" id="part-tabs">
        ${song.parts.map((p, i) => `<button data-i="${i}" class="${i === 0 ? 'active' : ''}">${esc(p.instrument)}</button>`).join('')}
      </div>
      <div id="score-part" class="score-box"></div>
      <div id="part-warnings"></div>
      <div class="btnrow">
        <button class="secondary" id="btn-part-wav">이 파트만 WAV 만들기</button>
        <button class="secondary" id="btn-part-abc">이 파트 ABC 저장(.abc)</button>
      </div>
    </div>`;
  }

  // --- 버전 히스토리 ---
  if (song.versions && song.versions.length) {
    html += `
    <div class="card">
      <h2>🕘 버전 히스토리</h2>
      ${song.versions.map(v => `
        <div class="ver-item">
          <span class="k ${v.kind}">${v.kind === 'lyrics' ? '가사' : '악보'}</span>
          <span class="note">${esc(v.note)}</span>
          <span class="date">${esc(v.created_at)}</span>
          <button class="secondary" data-restore="${v.id}">이 버전으로 복원</button>
        </div>`).join('')}
    </div>`;
  }

  $app.innerHTML = html;

  // ---------- 이벤트 바인딩 ----------

  document.getElementById('btn-del').onclick = async () => {
    if (!confirm(`「${song.title}」(${id}회차)을 정말 삭제할까요? 되돌릴 수 없습니다.`)) return;
    await api('DELETE', '/api/songs/' + id);
    toast('삭제되었습니다.');
    location.hash = '#/';
  };

  document.getElementById('btn-save-info').onclick = async () => {
    try {
      await api('PUT', '/api/songs/' + id, {
        title: document.getElementById('d-title').value,
        direction: document.getElementById('d-direction').value,
        mood: document.getElementById('d-mood').value,
        instruments: document.getElementById('d-instruments').value,
        lyrics_input: document.getElementById('d-lyrics-input').value,
      });
      toast('저장되었습니다.');
    } catch (e) { toast(e.message, true); }
  };

  // 첨부 업로드/삭제
  document.getElementById('btn-att-up').onclick = async () => {
    const fileInput = document.getElementById('att-file');
    const file = fileInput.files && fileInput.files[0];
    if (!file) { toast('첨부할 파일을 선택해 주세요.', true); return; }
    if (file.size > 40 * 1024 * 1024) { toast('파일이 너무 큽니다 (최대 40MB).', true); return; }
    const btn = document.getElementById('btn-att-up');
    btn.disabled = true; btn.textContent = '업로드 중...';
    try {
      let meta = {};
      if (/\.(mp3|wav|ogg|m4a|flac)$/i.test(file.name)) {
        btn.textContent = '오디오 분석 중...';
        try { meta = await analyzeAudio(await file.arrayBuffer()); } catch (e) { meta = {}; }
      }
      const dataBase64 = await fileToBase64(file);
      await api('POST', `/api/songs/${id}/attachments`, {
        filename: file.name,
        dataBase64,
        note: document.getElementById('att-note').value,
        meta,
      });
      toast('첨부되었습니다. 다음 생성부터 AI가 참고합니다.');
      renderDetail(id);
    } catch (e) {
      toast(e.message, true);
      btn.disabled = false; btn.textContent = '📎 첨부';
    }
  };
  document.querySelectorAll('[data-att-del]').forEach(btn => {
    btn.onclick = async () => {
      if (!confirm('이 첨부 자료를 삭제할까요?')) return;
      await api('DELETE', '/api/attachments/' + btn.dataset.attDel);
      toast('삭제되었습니다.');
      renderDetail(id);
    };
  });

  // 가사 편집 토글
  const lyricsEditBtn = document.getElementById('btn-edit-lyrics');
  if (lyricsEditBtn) lyricsEditBtn.onclick = () => {
    document.getElementById('lyrics-view').style.display = 'none';
    document.getElementById('lyrics-edit').style.display = '';
  };
  const cancelLyrics = document.getElementById('btn-cancel-lyrics');
  if (cancelLyrics) cancelLyrics.onclick = () => {
    document.getElementById('lyrics-view').style.display = '';
    document.getElementById('lyrics-edit').style.display = 'none';
  };
  const saveLyrics = document.getElementById('btn-save-lyrics');
  if (saveLyrics) saveLyrics.onclick = async () => {
    try {
      await api('PUT', '/api/songs/' + id, { lyrics: document.getElementById('d-lyrics').value });
      toast('가사가 저장되었습니다.');
      renderDetail(id);
    } catch (e) { toast(e.message, true); }
  };

  document.getElementById('btn-gen-lyrics').onclick = () => startGeneration(id, 'lyrics', document.getElementById('fb-lyrics').value, hasLyrics);

  // 악보 편집 토글
  const abcEditBtn = document.getElementById('btn-edit-abc');
  if (abcEditBtn) abcEditBtn.onclick = () => {
    const box = document.getElementById('abc-edit');
    box.style.display = box.style.display === 'none' ? '' : 'none';
  };
  const cancelAbc = document.getElementById('btn-cancel-abc');
  if (cancelAbc) cancelAbc.onclick = () => { document.getElementById('abc-edit').style.display = 'none'; };
  const saveAbc = document.getElementById('btn-save-abc');
  if (saveAbc) saveAbc.onclick = async () => {
    try {
      await api('PUT', '/api/songs/' + id, { abc: document.getElementById('d-abc').value });
      toast('악보가 저장되었습니다.');
      renderDetail(id);
    } catch (e) { toast(e.message, true); }
  };

  document.getElementById('btn-gen-score').onclick = () => startGeneration(id, 'score', document.getElementById('fb-score').value, hasScore);

  // 버전 복원
  document.querySelectorAll('[data-restore]').forEach(btn => {
    btn.onclick = async () => {
      if (!confirm('이 버전으로 복원할까요? (현재 내용은 히스토리에 남습니다)')) return;
      try {
        await api('POST', `/api/songs/${id}/restore/${btn.dataset.restore}`);
        toast('복원되었습니다.');
        renderDetail(id);
      } catch (e) { toast(e.message, true); }
    };
  });

  // ---------- 악보 렌더링 ----------
  let mainVisual = null;
  if (hasScore) {
    mainVisual = renderScore('score-main', 'score-warnings', song.abc);
    setupAudioWidget(mainVisual, song);
  }

  // 파트 탭
  if (song.parts && song.parts.length) {
    let currentPart = 0;
    const showPart = (i) => {
      currentPart = i;
      document.querySelectorAll('#part-tabs button').forEach(b => b.classList.toggle('active', Number(b.dataset.i) === i));
      renderScore('score-part', 'part-warnings', song.parts[i].abc);
    };
    document.querySelectorAll('#part-tabs button').forEach(b => { b.onclick = () => showPart(Number(b.dataset.i)); });
    showPart(0);

    document.getElementById('btn-part-wav').onclick = () =>
      makeWav(song.parts[currentPart].abc, `${song.title}_${song.parts[currentPart].instrument}`, 'btn-part-wav');
    document.getElementById('btn-part-abc').onclick = () => {
      const p = song.parts[currentPart];
      downloadBlob(new Blob([p.abc], { type: 'text/plain;charset=utf-8' }), `${song.title}_${p.instrument}.abc`);
    };
  }

  // ---------- 작업 폴링 ----------
  if (running) {
    const started = Date.now();
    pollTimer = setInterval(async () => {
      const el = document.getElementById('job-elapsed');
      if (el) el.textContent = ` (${Math.round((Date.now() - started) / 1000)}초 경과)`;
      try {
        const job = await api('GET', `/api/songs/${id}/job`);
        if (job && job.status !== 'running') {
          stopPolling();
          toast(job.status === 'done' ? '✅ 작업이 완료되었습니다!' : '작업이 실패했습니다.', job.status !== 'done');
          renderDetail(id);
        }
      } catch (e) {}
    }, 3000);
  }
}

async function startGeneration(id, type, feedback, isRegen) {
  const label = type === 'lyrics' ? '작사' : '작곡';
  if (isRegen && !confirm(`${label}를 다시 진행합니다. 현재 내용은 버전 히스토리에 보관됩니다. 계속할까요?`)) return;
  try {
    await api('POST', `/api/songs/${id}/generate/${type}`, { feedback });
    toast(`AI ${label}를 시작했습니다. 잠시만 기다려 주세요...`);
    renderDetail(id);
  } catch (e) { toast(e.message, true); }
}

// ---------------- 악보 렌더링 ----------------

function renderScore(divId, warnDivId, abc) {
  const el = document.getElementById(divId);
  const warnEl = document.getElementById(warnDivId);
  el.innerHTML = '';
  if (warnEl) warnEl.innerHTML = '';
  try {
    const visual = ABCJS.renderAbc(el, abc, { responsive: 'resize', add_classes: true })[0];
    if (visual && visual.warnings && visual.warnings.length && warnEl) {
      warnEl.innerHTML = `<div class="warnings">⚠️ 악보 표기 경고 (재생성 또는 ABC 편집으로 해결 가능):\n${esc(visual.warnings.slice(0, 8).join('\n'))}</div>`;
    }
    return visual;
  } catch (e) {
    el.innerHTML = `<div class="warnings">악보를 그리지 못했습니다: ${esc(e.message)}<br>「재작곡」을 눌러 다시 생성해 보세요.</div>`;
    return null;
  }
}

// ---------------- 오디오 ----------------

function setupAudioWidget(visualObj, song) {
  if (!visualObj) return;
  if (!ABCJS.synth.supportsAudio()) {
    document.getElementById('audio-widget').innerHTML = '<div class="warnings">이 브라우저는 오디오 재생을 지원하지 않습니다.</div>';
    return;
  }
  currentSynthControl = new ABCJS.synth.SynthController();
  currentSynthControl.load('#audio-widget', null, {
    displayLoop: true, displayRestart: true, displayPlay: true, displayProgress: true, displayWarp: true,
  });
  currentSynthControl.setTune(visualObj, false, { chordsOff: false }).catch(e => {
    document.getElementById('audio-widget').innerHTML = `<div class="warnings">오디오 준비 실패: ${esc(e.message || e)}</div>`;
  });

  document.getElementById('btn-wav').onclick = () => {
    const mr = document.getElementById('opt-mr').checked;
    makeWav(song.abc, song.title + (mr ? '_MR반주' : ''), 'btn-wav', { mr });
  };
  document.getElementById('btn-ust').onclick = () => {
    window.location.href = `/api/songs/${song.id}/ust`;
  };
  document.getElementById('btn-midi').onclick = () => {
    try {
      let midi = ABCJS.synth.getMidiFile(song.abc, { midiOutputType: 'binary' });
      if (Array.isArray(midi)) midi = midi[0];
      downloadBlob(new Blob([midi], { type: 'audio/midi' }), sanitize(song.title) + '.mid');
    } catch (e) { toast('MIDI 생성 실패: ' + e.message, true); }
  };
}

async function makeWav(abc, name, btnId, extra) {
  const btn = document.getElementById(btnId);
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = '🎧 음원 생성 중... (수십 초 걸릴 수 있어요)';
  try {
    const tmp = document.createElement('div');
    tmp.style.cssText = 'position:absolute;left:-9999px;width:800px';
    document.body.appendChild(tmp);
    const visual = ABCJS.renderAbc(tmp, abc, {})[0];
    const synth = new ABCJS.synth.CreateSynth();
    const synthOptions = {};
    if (extra && extra.mr) synthOptions.voicesOff = [0]; // 첫 번째 보이스(보컬) 음소거
    await synth.init({ visualObj: visual, options: synthOptions });
    await synth.prime();
    let buffer = synth.getAudioBuffer();
    tmp.remove();
    if (!buffer) throw new Error('오디오 버퍼를 만들지 못했습니다.');

    const useFx = document.getElementById('opt-fx') ? document.getElementById('opt-fx').checked : true;
    const reverb = document.getElementById('opt-reverb') ? Number(document.getElementById('opt-reverb').value) / 100 : 0.25;
    const gain = document.getElementById('opt-gain') ? Number(document.getElementById('opt-gain').value) / 100 : 1;
    if (useFx) buffer = await applyEffects(buffer, reverb, gain);

    downloadBlob(encodeWav(buffer), sanitize(name) + '.wav');
    toast('🎉 WAV 음악파일이 다운로드되었습니다!');
  } catch (e) {
    console.error(e);
    toast('음원 생성 실패: ' + (e.message || e) + ' (인터넷 연결을 확인해 주세요)', true);
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

/* 리버브 임펄스 응답 생성 (지수 감쇠 스테레오 노이즈) */
function makeImpulse(ctx, seconds, decay) {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const impulse = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return impulse;
}

/* 컴프레서 + 리버브 + 마스터 게인 이펙트 체인 (오프라인 렌더링) */
async function applyEffects(buffer, reverbAmount, gain) {
  const rate = 44100;
  const tail = 2.5;
  const ctx = new OfflineAudioContext(2, Math.ceil((buffer.duration + tail) * rate), rate);

  const src = ctx.createBufferSource();
  src.buffer = buffer;

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -18; comp.knee.value = 20; comp.ratio.value = 3;
  comp.attack.value = 0.01; comp.release.value = 0.25;

  const lowShelf = ctx.createBiquadFilter();
  lowShelf.type = 'lowshelf'; lowShelf.frequency.value = 200; lowShelf.gain.value = 2;

  const dry = ctx.createGain(); dry.gain.value = 1 - reverbAmount * 0.4;
  const wet = ctx.createGain(); wet.gain.value = reverbAmount;
  const conv = ctx.createConvolver();
  conv.buffer = makeImpulse(ctx, 2.2, 2.8);

  const master = ctx.createGain(); master.gain.value = gain * 0.95;

  src.connect(comp);
  comp.connect(lowShelf);
  lowShelf.connect(dry); dry.connect(master);
  lowShelf.connect(conv); conv.connect(wet); wet.connect(master);
  master.connect(ctx.destination);

  src.start();
  return ctx.startRendering();
}

/* AudioBuffer → 16bit PCM WAV Blob */
function encodeWav(buffer) {
  const numCh = Math.min(2, buffer.numberOfChannels);
  const rate = buffer.sampleRate;
  const frames = buffer.length;
  const dataLen = frames * numCh * 2;
  const ab = new ArrayBuffer(44 + dataLen);
  const dv = new DataView(ab);
  let p = 0;
  const wStr = (s) => { for (let i = 0; i < s.length; i++) dv.setUint8(p++, s.charCodeAt(i)); };
  const w32 = (v) => { dv.setUint32(p, v, true); p += 4; };
  const w16 = (v) => { dv.setUint16(p, v, true); p += 2; };
  wStr('RIFF'); w32(36 + dataLen); wStr('WAVE');
  wStr('fmt '); w32(16); w16(1); w16(numCh); w32(rate); w32(rate * numCh * 2); w16(numCh * 2); w16(16);
  wStr('data'); w32(dataLen);
  const chans = [];
  for (let c = 0; c < numCh; c++) chans.push(buffer.getChannelData(c));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numCh; c++) {
      let v = Math.max(-1, Math.min(1, chans[c][i]));
      dv.setInt16(p, v < 0 ? v * 0x8000 : v * 0x7FFF, true);
      p += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

// ---------------- 첨부 파일 유틸 ----------------

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(new Error('파일을 읽지 못했습니다.'));
    r.readAsDataURL(file);
  });
}

/* 오디오 파일 분석: 길이 + 추정 BPM (온셋 에너지 자기상관) */
async function analyzeAudio(arrayBuffer) {
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  let buf;
  try {
    buf = await ac.decodeAudioData(arrayBuffer);
  } finally {
    ac.close().catch(() => {});
  }
  const data = buf.getChannelData(0);
  // 최대 90초 구간만 분석 (속도)
  const maxSamples = Math.min(data.length, buf.sampleRate * 90);
  const hop = 512;
  const n = Math.floor(maxSamples / hop);
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < hop; j++) { const v = data[i * hop + j]; s += v * v; }
    env[i] = Math.sqrt(s / hop);
  }
  const nov = new Float32Array(n);
  for (let i = 1; i < n; i++) nov[i] = Math.max(0, env[i] - env[i - 1]);
  const fps = buf.sampleRate / hop;
  let best = 0, bestBpm = 0;
  for (let bpm = 60; bpm <= 180; bpm++) {
    const lag = Math.round(fps * 60 / bpm);
    let s = 0;
    for (let i = lag; i < n; i++) s += nov[i] * nov[i - lag];
    if (s > best) { best = s; bestBpm = bpm; }
  }
  return { duration: Math.round(buf.duration * 10) / 10, bpm: bestBpm || undefined };
}

function sanitize(name) {
  return String(name || 'song').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 2000);
}
