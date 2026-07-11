'use strict';
/*
 * 원클릭 AI 가창 렌더링:
 * 보컬 파트 ABC → USTX 생성 → OuRender(OpenUtau 헤드리스)로 WAV 렌더링
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const { abcToUstx } = require('./ustx');

const ROOT = path.join(__dirname, '..');
const OU_DIR = path.join(ROOT, 'tools', 'OpenUtau');
const RENDER_EXE = path.join(OU_DIR, 'OuRender.exe');
const DOTNET_ROOT = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'dotnet');
const TIMEOUT_MS = 30 * 60 * 1000;

function vocalDir(songId) {
  return path.join(ROOT, 'data', 'vocal', String(songId));
}
function vocalWavPath(songId) {
  return path.join(vocalDir(songId), 'vocal.wav');
}
function vocalReady(songId) {
  const p = vocalWavPath(songId);
  if (!fs.existsSync(p)) return null;
  const st = fs.statSync(p);
  return { size: st.size, mtime: st.mtime.toISOString() };
}
function installed() {
  return fs.existsSync(RENDER_EXE) && fs.existsSync(path.join(OU_DIR, 'OpenUtau.Core.dll'));
}

function startVocalJob(song) {
  if (!installed()) throw new Error('가창 렌더러(OpenUtau)가 설치되어 있지 않습니다.');
  const running = db.prepare(`SELECT id FROM jobs WHERE song_id = ? AND status = 'running'`).get(song.id);
  if (running) throw new Error('이미 진행 중인 작업이 있습니다. 완료를 기다려 주세요.');
  const parts = typeof song.parts === 'string' ? JSON.parse(song.parts || '[]') : (song.parts || []);
  const vocalPart = parts.find(p => /보컬|vocal/i.test(p.instrument));
  const abc = vocalPart ? vocalPart.abc : song.abc;
  if (!abc || !abc.trim()) throw new Error('악보가 없습니다. 먼저 작곡을 진행해 주세요.');

  const dir = vocalDir(song.id);
  fs.mkdirSync(dir, { recursive: true });
  const ustxPath = path.join(dir, 'vocal.ustx');
  const wavPath = vocalWavPath(song.id);
  fs.writeFileSync(ustxPath, abcToUstx(abc, song.title), 'utf8');
  try { if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath); } catch (e) {}

  const res = db.prepare(`INSERT INTO jobs (song_id, type, progress) VALUES (?, 'vocal', 'AI 가수 준비 중...')`).run(song.id);
  const jobId = Number(res.lastInsertRowid);

  const child = spawn(RENDER_EXE, [ustxPath, wavPath], {
    cwd: OU_DIR,
    windowsHide: true,
    env: { ...process.env, DOTNET_ROOT },
  });
  let stderrTail = '';
  const timer = setTimeout(() => { try { child.kill(); } catch (e) {} }, TIMEOUT_MS);
  const setProgress = (msg) => {
    try { db.prepare('UPDATE jobs SET progress = ? WHERE id = ?').run(msg.slice(0, 300), jobId); } catch (e) {}
  };
  let lineBuf = '';
  child.stdout.on('data', (d) => {
    lineBuf += d.toString('utf8');
    let idx;
    while ((idx = lineBuf.indexOf('\n')) >= 0) {
      const line = lineBuf.slice(0, idx).trim();
      lineBuf = lineBuf.slice(idx + 1);
      if (line.startsWith('PROGRESS|')) {
        const [, pct, info] = line.split('|');
        setProgress(`노래 렌더링 중... ${pct && pct !== '0' ? pct + '% ' : ''}${info || ''}`);
      }
    }
  });
  child.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString('utf8')).slice(-1000); });
  child.on('error', (err) => {
    clearTimeout(timer);
    db.prepare(`UPDATE jobs SET status='error', error=?, finished_at=datetime('now','localtime') WHERE id=?`)
      .run('렌더러 실행 실패: ' + err.message, jobId);
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    if (code === 0 && fs.existsSync(wavPath) && fs.statSync(wavPath).size > 1000) {
      db.prepare(`UPDATE jobs SET status='done', progress='완료', finished_at=datetime('now','localtime') WHERE id=?`).run(jobId);
    } else {
      db.prepare(`UPDATE jobs SET status='error', error=?, finished_at=datetime('now','localtime') WHERE id=?`)
        .run(('가창 렌더링 실패. ' + stderrTail).slice(0, 900), jobId);
    }
  });
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
}

module.exports = { startVocalJob, vocalReady, vocalWavPath, installed };
