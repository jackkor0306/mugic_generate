'use strict';
/*
 * 보컬 파트 ABC → UST 파일 변환 (OpenUTAU 가창 합성용)
 * ABC를 MIDI로 변환해 음표(음높이/길이/쉼표)를 얻고, w: 가사 줄에서 음절을 추출해 붙인다.
 */
const abcjs = require('abcjs');
const { parseMidi } = require('./midi');

const PPQ = 480; // UST 기준 틱

function extractSyllables(abc) {
  const sylls = [];
  for (const line of abc.split('\n')) {
    const m = line.match(/^w:\s?(.*)$/);
    if (!m) continue;
    for (const tok of m[1].trim().split(/\s+/)) {
      if (!tok) continue;
      // ABC 가사 규칙: '-' 는 음절 분리(다음 음표로), '_' 는 이전 음절 연장, '*' 는 음표 건너뜀
      for (const piece of tok.split('-')) {
        if (piece === '') continue;
        sylls.push(piece);
      }
    }
  }
  return sylls;
}

function abcToUst(abc, title) {
  // ABC → MIDI
  let midi = abcjs.synth.getMidiFile(abc, { midiOutputType: 'binary' });
  if (Array.isArray(midi)) midi = midi[0];
  if (!midi || !midi.length) throw new Error('악보를 MIDI로 변환하지 못했습니다.');
  const parsed = parseMidi(Buffer.from(midi));
  if (!parsed.tracks.length) throw new Error('악보에서 음표를 찾지 못했습니다.');

  // 음표가 가장 많은 트랙을 보컬 라인으로 사용
  const track = parsed.tracks.reduce((a, b) => (b.notes.length > a.notes.length ? b : a));
  const notes = track.notes.slice().sort((a, b) => a.start - b.start || b.n - a.n);
  const scale = PPQ / (parsed.division || 480);

  const sylls = extractSyllables(abc);
  let si = 0;
  const nextLyric = () => {
    while (si < sylls.length) {
      const s = sylls[si++];
      if (s === '_' || s === '*') return '+'; // 이전 음절 연장/건너뜀
      return s.replace(/[~]/g, ' ');
    }
    return '+';
  };

  const entries = [];
  let cursor = 0;
  for (const nt of notes) {
    if (nt.start < cursor - 5) continue; // 화음 중복음은 첫 음만 사용
    const start = Math.max(nt.start, cursor);
    const gap = Math.round((start - cursor) * scale);
    if (gap >= 15) entries.push({ lyric: 'R', noteNum: 60, length: gap });
    const len = Math.max(15, Math.round(nt.dur * scale));
    entries.push({ lyric: nextLyric(), noteNum: nt.n, length: len });
    cursor = nt.start + nt.dur;
  }
  if (!entries.length) throw new Error('보컬 음표가 없습니다.');

  const lines = [];
  lines.push('[#VERSION]');
  lines.push('UST Version1.2');
  lines.push('[#SETTING]');
  lines.push('Tempo=' + (parsed.tempoBpm || 120).toFixed(2));
  lines.push('Tracks=1');
  lines.push('ProjectName=' + (title || 'song'));
  lines.push('VoiceDir=');
  lines.push('OutFile=');
  lines.push('CacheDir=');
  lines.push('Mode2=True');
  entries.forEach((e, i) => {
    lines.push('[#' + String(i).padStart(4, '0') + ']');
    lines.push('Length=' + e.length);
    lines.push('Lyric=' + e.lyric);
    lines.push('NoteNum=' + e.noteNum);
    lines.push('PreUtterance=');
    lines.push('Intensity=100');
    lines.push('Modulation=0');
  });
  lines.push('[#TRACKEND]');
  return lines.join('\r\n');
}

module.exports = { abcToUst };
