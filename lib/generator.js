'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const { midiSummary } = require('./midi');
const { buildPartAbc } = require('./parts');

const ROOT = path.join(__dirname, '..');
const MODEL = process.env.STUDIO_MODEL || 'claude-opus-4-8';
const TIMEOUT_MS = 25 * 60 * 1000;

function resolveClaude() {
  const candidates = [
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'claude-code', 'claude.exe'),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return { cmd: c, shell: false };
  }
  return { cmd: 'claude', shell: true };
}
const CLAUDE = resolveClaude();

function callClaude(prompt, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'json', '--model', MODEL];
    if (opts.allowRead) args.push('--allowedTools', 'Read');
    const child = spawn(CLAUDE.cmd, args, {
      shell: CLAUDE.shell,
      windowsHide: true,
      cwd: ROOT,
      env: { ...process.env },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('생성 시간이 초과되었습니다 (25분). 다시 시도해 주세요.'));
    }, TIMEOUT_MS);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch (e) {
        return reject(new Error('Claude 응답을 해석하지 못했습니다: ' + (stderr || stdout).slice(0, 500)));
      }
      if (parsed.is_error) return reject(new Error('Claude 오류: ' + String(parsed.result).slice(0, 500)));
      resolve(String(parsed.result || ''));
    });
    child.stdin.write(prompt, 'utf8');
    child.stdin.end();
  });
}

function extractJson(text) {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('응답에서 JSON을 찾지 못했습니다.');
  }
  return JSON.parse(t.slice(start, end + 1));
}

// ---------------- 첨부 자료 ----------------

/*
 * 첨부된 악보/음악 파일을 프롬프트에 넣을 텍스트로 변환.
 * - abc/musicxml/text: 파일 내용을 직접 포함
 * - midi: 음표 요약으로 변환하여 포함
 * - image: Claude가 Read 도구로 직접 열어보도록 경로 전달
 * - audio: 분석 메타데이터(길이/추정 BPM)와 사용자 메모만 포함
 */
function attachmentContext(songId, purpose) {
  const atts = db.prepare('SELECT * FROM attachments WHERE song_id = ? ORDER BY id').all(songId);
  const lines = [];
  let hasImages = false;
  for (const a of atts) {
    const head = `● 첨부 ${a.id}: "${a.filename}"` + (a.note ? ` — 사용자 메모: ${a.note}` : '');
    try {
      if (a.kind === 'image') {
        if (purpose === 'lyrics') continue;
        hasImages = true;
        const rel = path.relative(ROOT, a.path).split(path.sep).join('/');
        lines.push(head);
        lines.push(`  → 악보 이미지입니다. Read 도구로 "${rel}" 파일을 열어 악보 내용(멜로디/코드/리듬)을 파악하고 참고하세요.`);
      } else if (a.kind === 'midi') {
        if (purpose === 'lyrics') continue;
        lines.push(head);
        lines.push('  → MIDI 파일 분석 결과:');
        lines.push(midiSummary(fs.readFileSync(a.path)));
      } else if (a.kind === 'abc' || a.kind === 'musicxml' || a.kind === 'text') {
        if (purpose === 'lyrics' && a.kind !== 'text') continue;
        lines.push(head);
        lines.push('  → 파일 내용:');
        lines.push(fs.readFileSync(a.path, 'utf8').slice(0, 15000));
      } else if (a.kind === 'audio') {
        const meta = JSON.parse(a.meta || '{}');
        lines.push(head);
        const info = [];
        if (meta.duration) info.push(`길이 약 ${meta.duration}초`);
        if (meta.bpm) info.push(`추정 템포 약 ${meta.bpm} BPM`);
        lines.push(`  → 참고용 오디오 파일입니다. ${info.join(', ') || '메타데이터 없음'}. 이 곡의 느낌/템포를 참고하되 표절하지 말 것.`);
      }
    } catch (e) {
      lines.push(head + ' (읽기 실패: ' + e.message + ')');
    }
  }
  if (!lines.length) return { text: '', hasImages: false };
  return {
    text: '\n[사용자가 첨부한 참고 자료 — 아래 자료를 분석하여 개선/작업에 반영할 것]\n' + lines.join('\n') + '\n',
    hasImages,
  };
}

// ---------------- 프롬프트 ----------------

function lyricsPrompt(song, feedback) {
  const lines = [];
  lines.push('당신은 히트곡을 다수 보유한 전문 작사가입니다. 아래 조건에 맞는 노래 가사를 작성하세요.');
  lines.push('기본 언어는 한국어이며, 사용자가 다른 언어를 지정한 경우에만 해당 언어로 작성합니다.');
  lines.push('');
  lines.push('[방향/주제]');
  lines.push(song.direction || '(지정 없음 — 자유롭게 하되 대중적으로)');
  lines.push('');
  lines.push('[분위기]');
  lines.push(song.mood || '(지정 없음)');
  if (song.lyrics_input && song.lyrics_input.trim()) {
    lines.push('');
    lines.push('[사용자가 제공한 가사 초안/키워드 — 최대한 반영할 것]');
    lines.push(song.lyrics_input);
  }
  if (song.lyrics && song.lyrics.trim()) {
    lines.push('');
    lines.push('[기존 가사 — 아래 피드백에 따라 개선/재작성할 것]');
    lines.push(song.lyrics);
  }
  if (feedback && feedback.trim()) {
    lines.push('');
    lines.push('[재생성 피드백 — 반드시 반영]');
    lines.push(feedback);
  }
  if (song._attachText) lines.push(song._attachText);
  lines.push('');
  lines.push('요구사항:');
  lines.push('1. [Intro] [Verse 1] [Pre-Chorus] [Chorus] [Verse 2] [Bridge] [Outro] 등 대괄호 섹션 라벨로 구조를 명확히 표시.');
  lines.push('2. 후렴(Chorus)은 반복 시 동일 가사 유지. 노래로 부르기 좋은 음절 리듬을 고려할 것.');
  lines.push('3. 곡 제목도 함께 제안할 것.');
  lines.push('');
  lines.push('출력은 반드시 아래 JSON 형식만, 다른 설명 없이 출력하세요:');
  lines.push('{"title": "곡 제목", "lyrics": "[Verse 1]\\n첫 줄...\\n..."}');
  return lines.join('\n');
}

function scorePrompt(song, feedback, prevScore) {
  const instruments = (song.instruments || '피아노').split(',').map(s => s.trim()).filter(Boolean);
  const lines = [];
  lines.push('당신은 전문 작곡가이자 편곡가입니다. 아래 가사와 조건에 맞춰 완성도 높은 곡을 ABC notation(abc 표기법)으로 작곡·편곡하세요.');
  lines.push('');
  lines.push(`[곡 제목] ${song.title}`);
  lines.push(`[방향/주제] ${song.direction || '(지정 없음)'}`);
  lines.push(`[분위기] ${song.mood || '(지정 없음)'}`);
  lines.push(`[편성 악기] ${instruments.join(', ')} (+ 보컬 멜로디)`);
  lines.push('');
  lines.push('[가사 — 전체를 곡에 배치할 것]');
  lines.push(song.lyrics);
  if (prevScore) {
    lines.push('');
    lines.push('[기존 악보 — 아래 피드백에 따라 수정/재작성할 것]');
    lines.push(prevScore.slice(0, 20000));
  }
  if (feedback && feedback.trim()) {
    lines.push('');
    lines.push('[재작곡 피드백 — 반드시 반영]');
    lines.push(feedback);
  }
  if (song._attachText) lines.push(song._attachText);
  lines.push('');
  lines.push('요구사항 (모두 준수):');
  lines.push('1. abcjs 6.x 라이브러리에서 파싱·재생 가능한 유효한 ABC notation일 것. 지원이 불확실한 고급 문법은 피할 것.');
  lines.push('2. "abc" 필드: 보컬 멜로디 + 모든 편성 악기를 각각 V: 보이스로 포함한 전체 스코어 하나.');
  lines.push('   - 헤더: X:1, T:(제목), M:(박자), L:(기본음길이), Q:(템포), K:(조성) 및 %%score 지시문으로 보이스 배치.');
  lines.push('   - 각 보이스는 V:이름 clef=... name="악기명" 으로 선언하고, 선언 직후 %%MIDI program <GM번호> 로 음색 지정.');
  lines.push('   - 피아노류 악기는 반드시 오른손(clef=treble)과 왼손(clef=bass) 두 보이스로 나누어 작성하고, %%score에서 중괄호 { }로 묶어 그랜드 스태프(큰보표)로 표시할 것. 예: %%score (V1) {(P1R) (P1L)} (V3)');
  lines.push('   - "세컨 피아노"가 편성되면 메인 피아노와 역할·음역을 분리할 것: 메인 피아노는 코드 보이싱+리듬 중심, 세컨 피아노는 고음역 아르페지오/패드/카운터라인 등 보조 질감. 두 악기가 같은 음역에서 겹치지 않게 할 것.');
  lines.push('   - 보컬 보이스에는 각 소절 음표 줄 바로 아래 w: 줄로 가사를 배치. 음표 수와 음절 수를 일치시킬 것 (멜리스마는 - 와 * 사용). 보컬 음색은 %%MIDI program 53(Voice Oohs) 또는 분위기에 맞는 리드 음색.');
  lines.push('   - 반주 보이스에는 "Am7" "Fmaj7" 같은 코드 심볼을 표기.');
  lines.push('   - 드럼/퍼커션이 편성에 있으면 해당 보이스에 %%MIDI channel 10 을 사용하고 K:perc 없이 그루브 패턴(킥/스네어/하이햇)과 섹션 전환 필인을 작성.');
  lines.push('3. 편곡 품질 (매우 중요 — 단순하거나 구식으로 들리는 편곡 금지):');
  lines.push('   - 단순 3화음 블록코드의 기계적 반복을 금지. 7th/9th/sus4/add9 등 텐션 코드, 전위(inversion), 세련된 보이싱을 적극 사용할 것.');
  lines.push('   - 싱커페이션, 16분음표 그루브, 셈여림 변화 등 리듬을 다채롭게 하고, 벌스/프리코러스/코러스 간 질감·에너지 대비를 뚜렷하게 만들 것.');
  lines.push('   - 카운터멜로디, 필인, 인트로 훅(hook) 등 현대 대중음악다운 디테일을 넣을 것.');
  lines.push('   - 베이스는 루트 반복이 아니라 리듬감 있는 라인(옥타브, 경과음, 싱커페이션)으로 작성할 것.');
  lines.push('4. 협화 규칙 (반드시 검증): 같은 순간에 함께 울리는 보컬 멜로디 음과 반주 성부의 음이 단2도·장2도(반음/온음) 간격으로 충돌하지 않도록 할 것. 단9도 충돌도 피할 것. 충돌이 생기면 반주 쪽 음을 코드 내 다른 음으로 바꾸거나 전위/생략으로 회피할 것. 경과음 등 비화성음은 약박에서 짧게만 사용. 작성 후 마디별로 멜로디-반주 수직 간격을 점검할 것.');
  lines.push('5. 곡 구성: 인트로-벌스-코러스 등 가사 전체를 커버하는 완전한 곡. 32~64마디 내에서 완결. 마디 단위로 박자가 정확히 맞을 것.');
  lines.push('6. "parts" 필드: 각 악기(보컬 포함)가 전체 스코어의 어느 보이스 ID에 해당하는지만 지정할 것 (파트 악보는 시스템이 자동 추출함). 예: [{"instrument": "보컬", "voices": ["V1"]}, {"instrument": "피아노(메인)", "voices": ["P1R", "P1L"]}]');
  lines.push('7. 다이내믹(!p!, !mf!, !f!, !crescendo(! 등)을 적절히 표기.');
  lines.push('8. 음악 본문에서 보이스 표기는 반드시 [V:보이스ID] 형식을 각 줄 맨 앞에 사용할 것.');
  lines.push('');
  lines.push('멀티보이스 형식 예시 (형식 참고용 — 피아노 그랜드 스태프 포함):');
  lines.push('X:1');
  lines.push('T:예시곡');
  lines.push('M:4/4');
  lines.push('L:1/8');
  lines.push('Q:1/4=90');
  lines.push('%%score (V1) {(P1R) (P1L)} (V3)');
  lines.push('K:Am');
  lines.push('V:V1 clef=treble name="Vocal"');
  lines.push('%%MIDI program 53');
  lines.push('V:P1R clef=treble name="Piano"');
  lines.push('%%MIDI program 0');
  lines.push('V:P1L clef=bass');
  lines.push('%%MIDI program 0');
  lines.push('V:V3 clef=bass name="Bass"');
  lines.push('%%MIDI program 33');
  lines.push('[V:P1R] "Am7"z2 [CEG]2 z [CEG] z2 | "Fmaj7"z2 [CEA]2 z [CEA]2 z2 |');
  lines.push('[V:P1L] A,,2 E,2 A,2 E,2 | F,,2 C,2 F,2 C,2 |');
  lines.push('[V:V1] A2 B2 c2 d2 | e6 z2 |');
  lines.push('w: 그 대 와 나 밤~');
  lines.push('[V:V3] A,,2 z A,, E,2 z E, | F,,4 z2 C,2 |');
  lines.push('');
  lines.push('출력은 반드시 아래 JSON 형식만, 다른 설명 없이 출력하세요. ABC 안의 줄바꿈은 \\n 으로 이스케이프:');
  lines.push('{"abc": "X:1\\nT:...", "parts": [{"instrument": "보컬", "voices": ["V1"]}, {"instrument": "피아노(메인)", "voices": ["P1R", "P1L"]}], "notes": "편곡 의도 요약 2~3문장"}');
  return lines.join('\n');
}

// ---------------- 작업(Job) 실행 ----------------

function getRunningJob(songId) {
  return db.prepare(`SELECT * FROM jobs WHERE song_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1`).get(songId);
}

function startJob(songId, type, feedback) {
  const song = db.prepare('SELECT * FROM songs WHERE id = ?').get(songId);
  if (!song) throw new Error('곡을 찾을 수 없습니다.');
  if (getRunningJob(songId)) throw new Error('이미 진행 중인 작업이 있습니다. 완료를 기다려 주세요.');
  if (type === 'score' && !(song.lyrics && song.lyrics.trim())) {
    throw new Error('가사가 아직 없습니다. 먼저 작사를 진행해 주세요.');
  }
  const res = db.prepare('INSERT INTO jobs (song_id, type) VALUES (?, ?)').run(songId, type);
  const jobId = Number(res.lastInsertRowid);
  setImmediate(() => runJob(jobId, song, type, feedback || ''));
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
}

async function runJob(jobId, song, type, feedback) {
  try {
    const attach = attachmentContext(song.id, type);
    song._attachText = attach.text;
    const claudeOpts = { allowRead: attach.hasImages };
    if (type === 'lyrics') {
      const raw = await callClaude(lyricsPrompt(song, feedback), claudeOpts);
      const data = extractJson(raw);
      if (!data.lyrics || !String(data.lyrics).trim()) throw new Error('가사가 비어 있습니다.');
      const newTitle = (!song.title || song.title === '무제') && data.title ? String(data.title) : song.title;
      db.prepare(`UPDATE songs SET lyrics = ?, title = ?,
                  status = CASE WHEN status = 'draft' THEN 'lyrics_done' ELSE status END,
                  updated_at = datetime('now','localtime') WHERE id = ?`)
        .run(String(data.lyrics), newTitle, song.id);
      db.prepare('INSERT INTO versions (song_id, kind, content, note) VALUES (?, ?, ?, ?)')
        .run(song.id, 'lyrics', String(data.lyrics), feedback ? '재생성: ' + feedback.slice(0, 200) : 'AI 작사');
    } else if (type === 'score') {
      const raw = await callClaude(scorePrompt(song, feedback, song.abc && song.abc.trim() ? song.abc : null), claudeOpts);
      const data = extractJson(raw);
      if (!data.abc || !String(data.abc).trim()) throw new Error('악보(abc)가 비어 있습니다.');
      const fullAbc = String(data.abc);
      const parts = [];
      if (Array.isArray(data.parts)) {
        for (const p of data.parts) {
          if (!p || !p.instrument) continue;
          if (p.abc) { parts.push({ instrument: String(p.instrument), abc: String(p.abc) }); continue; }
          if (Array.isArray(p.voices) && p.voices.length) {
            try {
              parts.push({ instrument: String(p.instrument), abc: buildPartAbc(fullAbc, p.voices.map(String), String(p.instrument)) });
            } catch (e) { /* 해당 파트 추출 실패 시 건너뜀 */ }
          }
        }
      }
      db.prepare(`UPDATE songs SET abc = ?, parts = ?, arrangement_notes = ?, status = 'score_done',
                  updated_at = datetime('now','localtime') WHERE id = ?`)
        .run(String(data.abc), JSON.stringify(parts), String(data.notes || ''), song.id);
      db.prepare('INSERT INTO versions (song_id, kind, content, note) VALUES (?, ?, ?, ?)')
        .run(song.id, 'score', JSON.stringify({ abc: String(data.abc), parts, notes: String(data.notes || '') }),
             feedback ? '재작곡: ' + feedback.slice(0, 200) : 'AI 작곡');
    } else {
      throw new Error('알 수 없는 작업 유형: ' + type);
    }
    db.prepare(`UPDATE jobs SET status = 'done', finished_at = datetime('now','localtime') WHERE id = ?`).run(jobId);
  } catch (err) {
    db.prepare(`UPDATE jobs SET status = 'error', error = ?, finished_at = datetime('now','localtime') WHERE id = ?`)
      .run(String(err && err.message || err).slice(0, 1000), jobId);
  }
}

module.exports = { startJob, getRunningJob, callClaude, attachmentContext };
