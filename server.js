'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const db = require('./lib/db');
const { startJob, getRunningJob } = require('./lib/generator');

const PORT = Number(process.env.PORT || 3789);
const app = express();

// 서버 재시작으로 끊긴 진행 중 작업 정리
db.prepare(`UPDATE jobs SET status='error', error='서버가 재시작되어 작업이 중단되었습니다. 다시 시도해 주세요.',
            finished_at = datetime('now','localtime') WHERE status='running'`).run();

app.use(express.json({ limit: '80mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/abcjs', express.static(path.join(__dirname, 'node_modules', 'abcjs', 'dist')));

// ---------------- 곡 목록/생성 ----------------

app.get('/api/songs', (req, res) => {
  const rows = db.prepare(`SELECT id, title, direction, mood, instruments, status, created_at, updated_at,
                           (lyrics <> '') AS has_lyrics, (abc <> '') AS has_score
                           FROM songs ORDER BY id DESC`).all();
  for (const r of rows) {
    const job = getRunningJob(r.id);
    r.running_job = job ? job.type : null;
  }
  res.json(rows);
});

app.post('/api/songs', (req, res) => {
  const b = req.body || {};
  const result = db.prepare(`INSERT INTO songs (title, direction, mood, instruments, lyrics_input)
                             VALUES (?, ?, ?, ?, ?)`)
    .run(String(b.title || '').trim() || '무제',
         String(b.direction || ''),
         String(b.mood || ''),
         String(b.instruments || '피아노'),
         String(b.lyricsInput || ''));
  const id = Number(result.lastInsertRowid);
  let job = null;
  if (b.autoLyrics) {
    try { job = startJob(id, 'lyrics', ''); } catch (e) { /* 무시: 상세에서 수동 시작 가능 */ }
  }
  res.json({ id, job });
});

// ---------------- 곡 상세 ----------------

function getSongDetail(id) {
  const song = db.prepare('SELECT * FROM songs WHERE id = ?').get(id);
  if (!song) return null;
  song.parts = JSON.parse(song.parts || '[]');
  song.vocal = vocal.vocalReady(id);
  song.vocal_available = vocal.installed();
  song.attachments = db.prepare(`SELECT id, filename, kind, note, meta, created_at FROM attachments WHERE song_id = ? ORDER BY id`).all(id);
  song.versions = db.prepare(`SELECT id, kind, note, created_at FROM versions WHERE song_id = ? ORDER BY id DESC`).all(id);
  const job = db.prepare(`SELECT * FROM jobs WHERE song_id = ? ORDER BY id DESC LIMIT 1`).get(id);
  song.last_job = job || null;
  return song;
}

app.get('/api/songs/:id', (req, res) => {
  const song = getSongDetail(Number(req.params.id));
  if (!song) return res.status(404).json({ error: '곡을 찾을 수 없습니다.' });
  res.json(song);
});

app.put('/api/songs/:id', (req, res) => {
  const id = Number(req.params.id);
  const song = db.prepare('SELECT * FROM songs WHERE id = ?').get(id);
  if (!song) return res.status(404).json({ error: '곡을 찾을 수 없습니다.' });
  const b = req.body || {};
  const fields = ['title', 'direction', 'mood', 'instruments', 'lyrics_input', 'lyrics', 'abc'];
  const next = {};
  for (const f of fields) next[f] = b[f] !== undefined ? String(b[f]) : song[f];
  if (b.parts !== undefined) next.parts = JSON.stringify(b.parts); else next.parts = song.parts;

  // 가사/악보를 직접 수정한 경우 버전 스냅샷 저장
  if (b.lyrics !== undefined && b.lyrics !== song.lyrics && String(b.lyrics).trim()) {
    db.prepare('INSERT INTO versions (song_id, kind, content, note) VALUES (?, ?, ?, ?)')
      .run(id, 'lyrics', String(b.lyrics), '직접 수정');
  }
  if (b.abc !== undefined && b.abc !== song.abc && String(b.abc).trim()) {
    db.prepare('INSERT INTO versions (song_id, kind, content, note) VALUES (?, ?, ?, ?)')
      .run(id, 'score', JSON.stringify({ abc: String(b.abc), parts: JSON.parse(next.parts || '[]'), notes: song.arrangement_notes }), '직접 수정');
  }

  db.prepare(`UPDATE songs SET title=?, direction=?, mood=?, instruments=?, lyrics_input=?, lyrics=?, abc=?, parts=?,
              updated_at = datetime('now','localtime') WHERE id = ?`)
    .run(next.title, next.direction, next.mood, next.instruments, next.lyrics_input, next.lyrics, next.abc, next.parts, id);
  res.json(getSongDetail(id));
});

app.delete('/api/songs/:id', (req, res) => {
  const id = Number(req.params.id);
  for (const a of db.prepare('SELECT * FROM attachments WHERE song_id = ?').all(id)) {
    try { if (a.path) fs.unlinkSync(a.path); } catch (e) {}
  }
  db.prepare('DELETE FROM attachments WHERE song_id = ?').run(id);
  db.prepare('DELETE FROM versions WHERE song_id = ?').run(id);
  db.prepare('DELETE FROM jobs WHERE song_id = ?').run(id);
  db.prepare('DELETE FROM songs WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ---------------- 첨부 자료 (기존 음악/악보 파일) ----------------

const ATT_DIR = path.join(__dirname, 'data', 'attachments');
if (!fs.existsSync(ATT_DIR)) fs.mkdirSync(ATT_DIR, { recursive: true });

const KIND_BY_EXT = {
  '.abc': 'abc', '.txt': 'text',
  '.xml': 'musicxml', '.musicxml': 'musicxml',
  '.mid': 'midi', '.midi': 'midi',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image', '.gif': 'image',
  '.mp3': 'audio', '.wav': 'audio', '.ogg': 'audio', '.m4a': 'audio', '.flac': 'audio',
};
const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.flac': 'audio/flac',
};

app.post('/api/songs/:id/attachments', (req, res) => {
  const id = Number(req.params.id);
  const song = db.prepare('SELECT id FROM songs WHERE id = ?').get(id);
  if (!song) return res.status(404).json({ error: '곡을 찾을 수 없습니다.' });
  const b = req.body || {};
  const filename = String(b.filename || 'file');
  const ext = path.extname(filename).toLowerCase();
  const kind = KIND_BY_EXT[ext];
  if (!kind) {
    return res.status(400).json({ error: `지원하지 않는 파일 형식입니다 (${ext || '확장자 없음'}). 지원: 악보(.abc .xml .musicxml .mid .txt), 악보 이미지(.png .jpg), 오디오(.mp3 .wav .ogg .m4a .flac)` });
  }
  let buf;
  try { buf = Buffer.from(String(b.dataBase64 || ''), 'base64'); } catch (e) { buf = null; }
  if (!buf || !buf.length) return res.status(400).json({ error: '파일 데이터가 비어 있습니다.' });
  if (buf.length > 40 * 1024 * 1024) return res.status(400).json({ error: '파일이 너무 큽니다 (최대 40MB).' });

  const r = db.prepare('INSERT INTO attachments (song_id, filename, kind, note, meta) VALUES (?, ?, ?, ?, ?)')
    .run(id, filename, kind, String(b.note || ''), JSON.stringify(b.meta || {}));
  const attId = Number(r.lastInsertRowid);
  const filePath = path.join(ATT_DIR, `${id}_${attId}${ext}`);
  fs.writeFileSync(filePath, buf);
  db.prepare('UPDATE attachments SET path = ? WHERE id = ?').run(filePath, attId);
  res.json(db.prepare('SELECT id, filename, kind, note, meta, created_at FROM attachments WHERE id = ?').get(attId));
});

app.get('/api/attachments/:id/file', (req, res) => {
  const a = db.prepare('SELECT * FROM attachments WHERE id = ?').get(Number(req.params.id));
  if (!a || !a.path || !fs.existsSync(a.path)) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
  const mime = MIME_BY_EXT[path.extname(a.path).toLowerCase()] || 'application/octet-stream';
  res.setHeader('Content-Type', mime);
  res.sendFile(a.path);
});

app.delete('/api/attachments/:id', (req, res) => {
  const a = db.prepare('SELECT * FROM attachments WHERE id = ?').get(Number(req.params.id));
  if (a) {
    try { if (a.path) fs.unlinkSync(a.path); } catch (e) {}
    db.prepare('DELETE FROM attachments WHERE id = ?').run(a.id);
  }
  res.json({ ok: true });
});

// ---------------- 생성 작업 ----------------

app.post('/api/songs/:id/generate/:type', (req, res) => {
  const id = Number(req.params.id);
  const type = req.params.type;
  if (!['lyrics', 'score'].includes(type)) return res.status(400).json({ error: '잘못된 작업 유형입니다.' });
  try {
    const job = startJob(id, type, (req.body && req.body.feedback) || '');
    res.json(job);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/songs/:id/job', (req, res) => {
  const job = db.prepare(`SELECT * FROM jobs WHERE song_id = ? ORDER BY id DESC LIMIT 1`).get(Number(req.params.id));
  res.json(job || null);
});

// ---------------- 원클릭 AI 가창 렌더링 ----------------

const vocal = require('./lib/vocal');

app.post('/api/songs/:id/vocal', (req, res) => {
  const song = getSongDetail(Number(req.params.id));
  if (!song) return res.status(404).json({ error: '곡을 찾을 수 없습니다.' });
  try {
    res.json(vocal.startVocalJob(song));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/songs/:id/vocal/file', (req, res) => {
  const p = vocal.vocalWavPath(Number(req.params.id));
  if (!require('fs').existsSync(p)) return res.status(404).json({ error: '가창 파일이 없습니다.' });
  res.setHeader('Content-Type', 'audio/wav');
  res.sendFile(p);
});

// ---------------- 가창(UST) 내보내기 ----------------

const { abcToUst } = require('./lib/ust');

app.get('/api/songs/:id/ust', (req, res) => {
  const song = getSongDetail(Number(req.params.id));
  if (!song) return res.status(404).json({ error: '곡을 찾을 수 없습니다.' });
  // 보컬 파트 악보 우선, 없으면 전체 악보에서 추출
  const vocalPart = (song.parts || []).find(p => /보컬|vocal/i.test(p.instrument));
  const abc = vocalPart ? vocalPart.abc : song.abc;
  if (!abc || !abc.trim()) return res.status(400).json({ error: '악보가 없습니다. 먼저 작곡을 진행해 주세요.' });
  try {
    const ust = abcToUst(abc, song.title);
    const fname = encodeURIComponent(song.title.replace(/[\\/:*?"<>|]/g, '_') + '_보컬.ust');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${fname}`);
    res.send(ust);
  } catch (e) {
    res.status(400).json({ error: 'UST 변환 실패: ' + e.message });
  }
});

// ---------------- 버전 ----------------

app.get('/api/versions/:id', (req, res) => {
  const v = db.prepare('SELECT * FROM versions WHERE id = ?').get(Number(req.params.id));
  if (!v) return res.status(404).json({ error: '버전을 찾을 수 없습니다.' });
  res.json(v);
});

app.post('/api/songs/:id/restore/:versionId', (req, res) => {
  const id = Number(req.params.id);
  const v = db.prepare('SELECT * FROM versions WHERE id = ? AND song_id = ?').get(Number(req.params.versionId), id);
  if (!v) return res.status(404).json({ error: '버전을 찾을 수 없습니다.' });
  if (v.kind === 'lyrics') {
    db.prepare(`UPDATE songs SET lyrics = ?, updated_at = datetime('now','localtime') WHERE id = ?`).run(v.content, id);
  } else {
    const data = JSON.parse(v.content);
    db.prepare(`UPDATE songs SET abc = ?, parts = ?, arrangement_notes = ?, updated_at = datetime('now','localtime') WHERE id = ?`)
      .run(data.abc || '', JSON.stringify(data.parts || []), data.notes || '', id);
  }
  res.json(getSongDetail(id));
});

// ---------------- 서버 시작 ----------------

const server = app.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log('==============================================');
  console.log('  🎵 음악 스튜디오가 실행되었습니다!');
  console.log(`  브라우저에서 ${url} 이 자동으로 열립니다.`);
  console.log('  이 창은 닫지 마세요. (닫으면 스튜디오가 종료됩니다)');
  console.log('==============================================');
  if (!process.env.NO_BROWSER) {
    spawn('cmd', ['/c', 'start', '', url], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log('이미 음악 스튜디오가 실행 중입니다. 브라우저를 엽니다.');
    spawn('cmd', ['/c', 'start', '', `http://localhost:${PORT}`], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
    setTimeout(() => process.exit(0), 1500);
  } else {
    throw err;
  }
});
