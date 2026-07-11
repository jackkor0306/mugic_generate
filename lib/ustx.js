'use strict';
/*
 * 보컬 파트 ABC → OpenUtau 프로젝트(.ustx) 생성
 * 가수(Nishiren DS)와 한국어 phonemizer를 미리 지정해 열자마자 렌더링 가능하게 한다.
 */
const abcjs = require('abcjs');
const { parseMidi } = require('./midi');

const PPQ = 480;
const SINGER_ID = 'Nishiren Diffsinger v2.0';
const PHONEMIZER = 'OpenUtau.Core.DiffSinger.DiffSingerKoreanPhonemizer';

function extractSyllables(abc) {
  const sylls = [];
  for (const line of abc.split('\n')) {
    const m = line.match(/^w:\s?(.*)$/);
    if (!m) continue;
    for (const tok of m[1].trim().split(/\s+/)) {
      if (!tok) continue;
      for (const piece of tok.split('-')) {
        if (piece === '') continue;
        sylls.push(piece);
      }
    }
  }
  return sylls;
}

function yamlStr(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function abcToUstx(abc, title) {
  let midi = abcjs.synth.getMidiFile(abc, { midiOutputType: 'binary' });
  if (Array.isArray(midi)) midi = midi[0];
  if (!midi || !midi.length) throw new Error('악보를 MIDI로 변환하지 못했습니다.');
  const parsed = parseMidi(Buffer.from(midi));
  if (!parsed.tracks.length) throw new Error('악보에서 음표를 찾지 못했습니다.');

  const track = parsed.tracks.reduce((a, b) => (b.notes.length > a.notes.length ? b : a));
  const notes = track.notes.slice().sort((a, b) => a.start - b.start || b.n - a.n);
  const scale = PPQ / (parsed.division || 480);
  const beatPerBar = Number((parsed.timeSig || '4/4').split('/')[0]) || 4;
  const beatUnit = Number((parsed.timeSig || '4/4').split('/')[1]) || 4;

  const sylls = extractSyllables(abc);
  let si = 0;
  const nextLyric = () => {
    while (si < sylls.length) {
      const s = sylls[si++];
      if (s === '_' || s === '*') return '+';
      return s.replace(/[~]/g, '');
    }
    return '+';
  };

  const noteYaml = [];
  let cursor = 0;
  for (const nt of notes) {
    if (nt.start < cursor - 5) continue; // 화음 중복음 제거
    const pos = Math.round(nt.start * scale);
    const dur = Math.max(15, Math.round(nt.dur * scale));
    const lyric = nextLyric();
    noteYaml.push(
`  - position: ${pos}
    duration: ${dur}
    tone: ${nt.n}
    lyric: ${yamlStr(lyric)}
    pitch:
      data:
      - {x: -40, y: 0, shape: io}
      - {x: 40, y: 0, shape: io}
      snap_first: true
    vibrato: {length: 0, period: 175, depth: 25, in: 10, out: 10, shift: 0, drift: 0, vol_link: 0}
    phoneme_expressions: []
    phoneme_overrides: []`);
    cursor = nt.start + nt.dur;
  }
  if (!noteYaml.length) throw new Error('보컬 음표가 없습니다.');

  return `name: ${yamlStr(title || 'song')}
comment: "Music Studio에서 자동 생성"
output_dir: Vocal
cache_dir: UCache
ustx_version: "0.6"
resolution: ${PPQ}
bpm: ${parsed.tempoBpm || 120}
beat_per_bar: ${beatPerBar}
beat_unit: ${beatUnit}
expressions:
  dyn:
    name: dynamics (curve)
    abbr: dyn
    type: Curve
    min: -240
    max: 120
    default_value: 0
    is_flag: false
    flag: ""
tracks:
- singer: ${yamlStr(SINGER_ID)}
  phonemizer: ${PHONEMIZER}
  renderer_settings:
    renderer: DIFFSINGER
  track_name: "Vocal"
  mute: false
  solo: false
  volume: 0
  pan: 0
voice_parts:
- name: "Vocal"
  comment: ""
  track_no: 0
  position: 0
  notes:
${noteYaml.join('\n')}
wave_parts: []
`;
}

module.exports = { abcToUstx, SINGER_ID };
