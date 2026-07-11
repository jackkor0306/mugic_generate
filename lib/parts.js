'use strict';
/*
 * 전체 멀티보이스 ABC 스코어에서 특정 보이스들만 뽑아 악기별 파트 악보를 만든다.
 * (AI가 파트 악보를 중복 생성하지 않아도 되므로 생성 시간이 크게 준다)
 */

function buildPartAbc(fullAbc, voiceIds, instrument) {
  const want = new Set(voiceIds);
  const lines = fullAbc.split('\n');

  const header = [];        // V: 선언 전의 헤더 라인들 (%%score 제외)
  const decls = new Map();  // voiceId -> [선언 + %%MIDI 라인들]
  const music = [];         // 선택된 보이스의 음악 라인들 (원본 순서)

  let mode = 'header';      // header | decl | music
  let declVoice = null;     // 현재 V: 선언 대상
  let musicVoice = null;    // 현재 음악 라인의 보이스 ([V:x] 또는 본문 V:x 전환)
  let lastWasWanted = false;

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    const inlineV = line.match(/^\[V:\s*([^\]\s]+)\s*\]/);
    const declV = !inlineV && line.match(/^V:\s*(\S+)/);

    if (inlineV) {
      mode = 'music';
      musicVoice = inlineV[1];
      lastWasWanted = want.has(musicVoice);
      if (lastWasWanted) music.push(line);
      continue;
    }
    if (declV) {
      if (mode === 'music') { // 본문 중 보이스 전환 스타일 (V:x 단독 라인)
        musicVoice = declV[1];
        lastWasWanted = want.has(musicVoice);
        continue;
      }
      mode = 'decl';
      declVoice = declV[1];
      if (!decls.has(declVoice)) decls.set(declVoice, []);
      decls.get(declVoice).push(line);
      continue;
    }
    if (mode === 'header') {
      if (line.startsWith('%%score')) continue; // 새로 만든다
      header.push(line);
      continue;
    }
    if (mode === 'decl') {
      if (line.startsWith('%%') || line.startsWith('%')) {
        decls.get(declVoice).push(line);
      } else if (line.startsWith('K:') || line.trim() === '') {
        header.push(line);
      } else {
        // 선언부가 끝나고 음악 본문 시작 (보이스 표기 없는 라인)
        mode = 'music';
        if (lastWasWanted || want.has(musicVoice)) music.push(line);
      }
      continue;
    }
    // mode === 'music' : w: 가사 등 후속 라인은 직전 음악 라인의 보이스를 따른다
    if (line.startsWith('w:') || line.startsWith('W:')) {
      if (lastWasWanted) music.push(line);
      continue;
    }
    if (line.trim() === '') continue;
    if (lastWasWanted) music.push(line);
  }

  // 헤더 재구성: T: 에 악기명 붙이고, K: 직전에 %%score 삽입
  const ids = voiceIds.filter(v => decls.has(v));
  const useIds = ids.length ? ids : voiceIds;
  const score = useIds.length >= 2
    ? '%%score {' + useIds.map(v => '(' + v + ')').join(' ') + '}'
    : '%%score (' + useIds[0] + ')';

  const out = [];
  let scoreInserted = false;
  for (const h of header) {
    if (h.startsWith('K:') && !scoreInserted) { out.push(score); scoreInserted = true; }
    if (h.startsWith('T:')) out.push(h + ' — ' + instrument);
    else out.push(h);
  }
  if (!scoreInserted) out.push(score);
  for (const v of useIds) {
    if (decls.has(v)) out.push(...decls.get(v));
  }
  out.push(...music);
  const abc = out.join('\n').replace(/\n{3,}/g, '\n\n');
  if (!music.length) throw new Error(`보이스 [${voiceIds.join(',')}] 의 음악 라인을 찾지 못했습니다.`);
  return abc;
}

module.exports = { buildPartAbc };
