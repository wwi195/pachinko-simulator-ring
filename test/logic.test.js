'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const logic = require('../logic.js');

function withMockRandom(values, fn) {
  const original = Math.random;
  let i = 0;
  Math.random = () => values[Math.min(i++, values.length - 1)];
  try {
    return fn();
  } finally {
    Math.random = original;
  }
}

const close = (a, b, eps = 1e-3) => Math.abs(a - b) < eps;

test('実際の獲得球：15個賞球×10カウントは表示×14/15', () => {
  assert.equal(logic.toActualBalls(1500), 1400);
  assert.equal(logic.toActualBalls(3000), 2800);
  assert.equal(logic.toActualBalls(6000), 5600);
  assert.equal(logic.toActualBalls(300), 280);
});

test('合算 約1/348.6 ＝ 図柄揃い 1/399.7 ＋ チャージ 1/2723.4', () => {
  assert.ok(close(1 / logic.P_TOTAL_HIT, 348.6, 0.1));
  assert.equal(logic.P_NORMAL_HIT, logic.P_TOTAL_HIT);
});

test('当たりの種類：約87%が図柄揃い、残りがチャージ', () => {
  assert.equal(withMockRandom([0.86], () => logic.rollNormalHitType()), 'zugara');
  assert.equal(withMockRandom([0.88], () => logic.rollNormalHitType()), 'charge');
});

test('先ローリングの当選率：図柄揃い ÷ (図柄揃い＋外れの先ローリング) が選んだモードの当選率になる', () => {
  for (const opt of logic.FLASH_OPTIONS) {
    const p = logic.P_ZUGARA;
    const conf = p / (p + logic.falseFlashProbability(opt));
    assert.ok(close(conf, Number(opt) / 100, 1e-12), opt);
  }
  assert.deepEqual(logic.FLASH_OPTIONS, ['10', '40', '99']);
  assert.equal(logic.DEFAULT_FLASH, '40');
});

test('図柄揃い：57.4%でラッシュ', () => {
  assert.equal(withMockRandom([0.573], () => logic.rollZugaraRush()), true);
  assert.equal(withMockRandom([0.575], () => logic.rollZugaraRush()), false);
});

test('ラッシュ：1〜5回転目は1/8、6〜75回転目は1/129.7', () => {
  assert.equal(logic.RUSH_ST, 75);
  assert.equal(logic.isRushFirstHalf(5), true);
  assert.equal(logic.isRushFirstHalf(6), false);
  assert.equal(withMockRandom([0.12], () => logic.spinRush(5)), 'hit');
  assert.equal(withMockRandom([0.12], () => logic.spinRush(6)), 'miss');
  assert.equal(withMockRandom([0.0076], () => logic.spinRush(75)), 'hit');
});

test('ラッシュの当たり：前半は6000か3000（半々）、後半は1500', () => {
  assert.deepEqual(withMockRandom([0.2], () => logic.rollRushBonus(1)), { first: true, big: true, balls: 6000 });
  assert.deepEqual(withMockRandom([0.7], () => logic.rollRushBonus(5)), { first: true, big: false, balls: 3000 });
  assert.deepEqual(withMockRandom([0.2], () => logic.rollRushBonus(6)), { first: false, big: false, balls: 1500 });
});

test('継続率：前半 約48.7%・後半 約41.8%・合計 約70%', () => {
  assert.ok(close(logic.rushFirstHitProbability(), 0.487, 0.001));
  assert.ok(close(logic.rushSecondHitProbability(), 0.418, 0.001));
  assert.ok(close(logic.rushContinueProbability(), 0.70, 0.003));
});

test('初当たりのラッシュ突入率は 約50%（チャージはラッシュに入らない）', () => {
  assert.ok(close(logic.rushEntryProbability(), 0.501, 0.002));
});

test('シミュレーションでも継続率が理論値に近い', () => {
  let cont = 0;
  const N = 40000;
  for (let i = 0; i < N; i++) {
    for (let s = 1; s <= logic.RUSH_ST; s++) {
      if (logic.spinRush(s) === 'hit') { cont++; break; }
    }
  }
  assert.ok(close(cont / N, logic.rushContinueProbability(), 0.015));
});
