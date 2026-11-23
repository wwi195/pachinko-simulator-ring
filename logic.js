'use strict';

// 最恐1/399 の確率・振り分け。DOMに依存しない純粋なロジックだけを置く。
// 数値の出典と決め方は docs/spec.md を参照。

// ---- 遊技条件 ----
// 等価（4円/玉）固定。1000円=250玉。
const YEN_PER_BALL = 4;
const SPIN_RATE_OPTIONS = [12, 15, 17.3, 19, 21];
const DEFAULT_SPIN_RATE = 17.3; // ボーダー（docs/spec.md）

function calcSpinCost(spinRate) {
  return 250 / spinRate;
}

// 表示出玉 → 実際の獲得球。15個賞球×10カウントなので、1カウントあたり14個だけ増える（表示×14/15）。
// 1500→1400、3000→2800、6000→5600、300→280
function toActualBalls(nominal) {
  return nominal - nominal / 15;
}

// ---- 通常時 ----
// 図柄揃い 1/399.7 ＋ チャージ 1/2723.4 ＝ 合算 約1/348.6
const P_ZUGARA = 1 / 399.7;
const P_CHARGE = 1 / 2723.4;
const P_TOTAL_HIT = P_ZUGARA + P_CHARGE;
const P_NORMAL_HIT = P_TOTAL_HIT;

// 先ローリング：図柄揃いは必ず先ローリングから来る（チャージは先ローリングなしでそのまま出る）。
// モードで当選率（信頼度）を選べる：紫 10%／赤 40%（初期値）／金 99%
const FLASH_OPTIONS = ['10', '40', '99'];
const DEFAULT_FLASH = '40';
const FLASH_MODE_NAMES = { '10': '紫', '40': '赤', '99': '金' };

function flashConfidence(option) {
  return Number(option);
}

// 外れなのに先ローリングが出る確率（図柄揃い ÷ 先ローリング が当選率になるように）
function falseFlashProbability(option) {
  const c = flashConfidence(option);
  return P_ZUGARA * ((100 - c) / c);
}

// 通常時1回転：'hit' / 'false_flash' / 'miss'
function spinNormal(flashOption) {
  const r = Math.random();
  if (r < P_NORMAL_HIT) return 'hit';
  if (r < P_NORMAL_HIT + falseFlashProbability(flashOption)) return 'false_flash';
  return 'miss';
}

// 当たりの種類：'zugara'（図柄揃い 1500個）/ 'charge'（300個 → 通常へ）
function rollNormalHitType() {
  return Math.random() < P_ZUGARA / P_TOTAL_HIT ? 'zugara' : 'charge';
}

// ---- 図柄揃い（10R 1500個） ----
// 57.4% でラッシュ（ST75回）へ、42.6% で通常へ（時短なし）
const ZUGARA_BALLS = 1500;
const CHARGE_BALLS = 300;
const ZUGARA_RUSH = 0.574;

function rollZugaraRush() {
  return Math.random() < ZUGARA_RUSH;
}

// ---- ラッシュ（ST75回＝前半5回＋後半70回） ----
// 前半5回：1/8 → 6000 or 3000個（半々）
// 後半70回：1/129.7 → 1500個
// どちらで当たっても次はまた前半5回から。75回スルーで通常へ
const RUSH_FIRST_SPINS = 5;
const RUSH_SECOND_SPINS = 70;
const RUSH_ST = RUSH_FIRST_SPINS + RUSH_SECOND_SPINS;
const P_RUSH_FIRST = 1 / 8;
const P_RUSH_SECOND = 1 / 129.7;

// ST何回転目（1〜75）が前半か
function isRushFirstHalf(spinNo) {
  return spinNo <= RUSH_FIRST_SPINS;
}

function spinRush(spinNo) {
  const p = isRushFirstHalf(spinNo) ? P_RUSH_FIRST : P_RUSH_SECOND;
  return Math.random() < p ? 'hit' : 'miss';
}

// 前半の当たり：6000 or 3000個（半々）。後半の当たり：1500個
function rollRushBonus(spinNo) {
  if (isRushFirstHalf(spinNo)) {
    const balls = Math.random() < 0.5 ? 6000 : 3000;
    return { first: true, big: balls === 6000, balls };
  }
  return { first: false, big: false, balls: 1500 };
}

// 前半5回で当たる確率（約48.7%）
function rushFirstHitProbability() {
  return 1 - Math.pow(1 - P_RUSH_FIRST, RUSH_FIRST_SPINS);
}

// 後半70回で当たる確率（約41.8%）
function rushSecondHitProbability() {
  return 1 - Math.pow(1 - P_RUSH_SECOND, RUSH_SECOND_SPINS);
}

// 継続率（約70%）
function rushContinueProbability() {
  return 1 - (1 - rushFirstHitProbability()) * (1 - rushSecondHitProbability());
}

// 初当たり1回がラッシュに入る確率（約50%）。チャージはラッシュに入らない
function rushEntryProbability() {
  return (P_ZUGARA / P_TOTAL_HIT) * ZUGARA_RUSH;
}

// 初当たり1回がラッシュに入らずに終わる確率
const P_NO_RUSH_FROM_HIT = 1 - rushEntryProbability();

// 初当たりまでの回転数の確率
function hitIntervalProbability(n) {
  return {
    atLeast: Math.pow(1 - P_NORMAL_HIT, n - 1),
    within: 1 - Math.pow(1 - P_NORMAL_HIT, n),
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    YEN_PER_BALL,
    SPIN_RATE_OPTIONS,
    DEFAULT_SPIN_RATE,
    calcSpinCost,
    toActualBalls,
    P_ZUGARA,
    P_CHARGE,
    P_TOTAL_HIT,
    P_NORMAL_HIT,
    FLASH_OPTIONS,
    DEFAULT_FLASH,
    FLASH_MODE_NAMES,
    flashConfidence,
    falseFlashProbability,
    spinNormal,
    rollNormalHitType,
    ZUGARA_BALLS,
    CHARGE_BALLS,
    ZUGARA_RUSH,
    rollZugaraRush,
    RUSH_FIRST_SPINS,
    RUSH_SECOND_SPINS,
    RUSH_ST,
    P_RUSH_FIRST,
    P_RUSH_SECOND,
    isRushFirstHalf,
    spinRush,
    rollRushBonus,
    rushFirstHitProbability,
    rushSecondHitProbability,
    rushContinueProbability,
    rushEntryProbability,
    P_NO_RUSH_FROM_HIT,
    hitIntervalProbability,
  };
}
