const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  cleanTitle,
  cleanEpisodeTitle,
  detectSeasonNumber,
  detectSeasonAndEpisode,
  groupKeyFromName,
  isTrivialTitle,
} = require('../titleParser');

test('cleanTitle remove tags de release', () => {
  assert.equal(cleanTitle('Breaking.Bad.S01E01.1080p.BluRay'), 'Breaking Bad');
  assert.equal(cleanTitle('The.Office.S03E10.HDTV.x264'), 'The Office');
});

test('cleanTitle retorna string vazia para input vazio', () => {
  assert.equal(cleanTitle(''), '');
  assert.equal(cleanTitle(null), '');
});

test('detectSeasonNumber extrai número de temporada', () => {
  assert.equal(detectSeasonNumber('Season 2'), 2);
  assert.equal(detectSeasonNumber('S03'), 3);
  assert.equal(detectSeasonNumber('S01'), 1);
  assert.equal(detectSeasonNumber('filme'), null);
});

test('detectSeasonAndEpisode extrai temporada e episódio', () => {
  const r = detectSeasonAndEpisode('S02E05.mkv');
  assert.equal(r.season, 2);
  assert.equal(r.episode, 5);
});

test('detectSeasonAndEpisode retorna null quando não encontra', () => {
  const r = detectSeasonAndEpisode('meu-filme.mp4');
  assert.equal(r.season, null);
  assert.equal(r.episode, null);
});

test('groupKeyFromName normaliza para chave estável', () => {
  const k1 = groupKeyFromName('Breaking Bad Season 1');
  const k2 = groupKeyFromName('Breaking Bad Season 2');
  assert.equal(k1, k2);
});

test('isTrivialTitle identifica títulos triviais', () => {
  assert.equal(isTrivialTitle('S01'), true);
  assert.equal(isTrivialTitle('1080p'), true);
  assert.equal(isTrivialTitle('Season 1'), true);
  assert.equal(isTrivialTitle('Breaking Bad'), false);
  assert.equal(isTrivialTitle(''), true);
});
