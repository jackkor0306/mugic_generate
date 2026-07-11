'use strict';
/* 최소 MIDI 파서 — 첨부된 MIDI 파일을 AI가 참고할 수 있는 텍스트 요약으로 변환 */

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function noteName(n) {
  return NOTE_NAMES[n % 12] + (Math.floor(n / 12) - 1);
}

function parseMidi(buf) {
  let pos = 0;
  const u32 = () => { const v = buf.readUInt32BE(pos); pos += 4; return v; };
  const u16 = () => { const v = buf.readUInt16BE(pos); pos += 2; return v; };
  const u8 = () => buf[pos++];
  const vlq = () => {
    let v = 0, b;
    do { b = u8(); v = (v << 7) | (b & 0x7f); } while (b & 0x80);
    return v;
  };

  if (buf.toString('latin1', 0, 4) !== 'MThd') throw new Error('MIDI 파일이 아닙니다.');
  pos = 4;
  const hdrLen = u32();
  const format = u16();
  const ntrks = u16();
  const division = u16();
  pos = 8 + hdrLen;

  const tracks = [];
  let tempoBpm = 120;
  let timeSig = '4/4';

  for (let t = 0; t < ntrks && pos < buf.length; t++) {
    if (buf.toString('latin1', pos, pos + 4) !== 'MTrk') break;
    pos += 4;
    const len = u32();
    const end = pos + len;
    let tick = 0;
    let running = 0;
    let name = '';
    const active = {}; // note -> {start}
    const notes = [];

    while (pos < end) {
      tick += vlq();
      let status = buf[pos];
      if (status < 0x80) { status = running; } else { pos++; running = status; }

      if (status === 0xff) { // meta
        const type = u8();
        const mlen = vlq();
        if (type === 0x03) name = buf.toString('utf8', pos, pos + mlen);
        else if (type === 0x51 && mlen === 3) {
          const uspq = (buf[pos] << 16) | (buf[pos + 1] << 8) | buf[pos + 2];
          if (uspq > 0) tempoBpm = Math.round(60000000 / uspq);
        } else if (type === 0x58 && mlen >= 2) {
          timeSig = buf[pos] + '/' + Math.pow(2, buf[pos + 1]);
        }
        pos += mlen;
      } else if (status === 0xf0 || status === 0xf7) { // sysex
        const slen = vlq();
        pos += slen;
      } else {
        const hi = status & 0xf0;
        if (hi === 0x90 || hi === 0x80) {
          const note = u8();
          const vel = u8();
          if (hi === 0x90 && vel > 0) {
            active[note] = tick;
          } else if (active[note] !== undefined) {
            notes.push({ n: note, start: active[note], dur: tick - active[note] });
            delete active[note];
          }
        } else if (hi === 0xc0 || hi === 0xd0) {
          pos += 1;
        } else {
          pos += 2;
        }
      }
    }
    pos = end;
    if (notes.length) tracks.push({ name, notes });
  }
  return { format, division, tempoBpm, timeSig, tracks };
}

/* MIDI 파일 → 프롬프트용 텍스트 요약 */
function midiSummary(buf, maxNotesPerTrack = 250) {
  const m = parseMidi(buf);
  const div = m.division || 480;
  const lines = [];
  lines.push(`템포: 약 ${m.tempoBpm} BPM, 박자: ${m.timeSig}, 트랙 수: ${m.tracks.length}`);
  m.tracks.forEach((tr, i) => {
    tr.notes.sort((a, b) => a.start - b.start || a.n - b.n);
    const shown = tr.notes.slice(0, maxNotesPerTrack);
    const seq = shown.map(nt => {
      const beat = Math.round((nt.start / div) * 100) / 100;
      const dur = Math.round((nt.dur / div) * 100) / 100;
      return `${noteName(nt.n)}@${beat}(${dur})`;
    }).join(' ');
    lines.push(`[트랙 ${i + 1}${tr.name ? ' "' + tr.name + '"' : ''}] 음표 ${tr.notes.length}개 (형식: 음이름@시작박(길이박)):`);
    lines.push(seq + (tr.notes.length > maxNotesPerTrack ? ' ...(이하 생략)' : ''));
  });
  return lines.join('\n');
}

module.exports = { midiSummary, parseMidi };
