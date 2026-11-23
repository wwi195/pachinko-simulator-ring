'use strict';

// 最恐1/399 シミュレーター（画面と状態遷移）。確率は logic.js。
// 流れ：通常時 →（先ローリング）→ 大当たり
//   ├ 図柄揃い（1500個）→ 57.4%でラッシュ ／ 42.6%で通常へ
//   └ チャージ（300個）→ そのまま通常へ
// ラッシュ：ST75回（前半5回 1/8 → 6000 or 3000個 ／ 後半70回 1/129.7 → 1500個）。
//   当たれば前半5回からやり直し、75回スルーで通常へ

const game = {
  state: 'normal_idle',
  mode: 'normal', // normal / rush
  spinRate: DEFAULT_SPIN_RATE,
  flash: DEFAULT_FLASH,
  mochiDama: 0,
  toushi: 0,
  totalSpins: 0,   // 通常時（玉を使う回転）
  normalSpins: 0,  // 通常時だけ
  currentSpins: 0,
  lastHitSpins: 0, // 最後に通常時へ戻ったときの normalSpins
  normalHitCount: 0,
  rushEntryCount: 0,
  noRushStreak: 0,   // 初当たりでラッシュに入れなかった連続回数
  lastRushSpins: 0,  // 最後に初当たりからラッシュに入ったときの通常時回転数
  rushAllStats: { totalSpins: 0, hits: 0, big: 0, ends: 0 },
  session: null, // 初当たりから通常に戻るまで { hits, nominalBalls, actualBalls, everRush }
  stRemaining: 0,
  pending: {},
  eigyoAlertShown: false,
  detailsExpanded: false,
  shareOpen: false, // 「当たったときの振り分け」タブを開いているか（開閉は覚えておく）
  lastRankResult: null,
  hitHistory: [], // [{games, chain}]（新しい順。chain=null は結果待ち、0はラッシュなし）
  slump: [{ x: 0, y: 0 }],
  log: [],
};

function addLog(text, type = '') {
  game.log.unshift({ text, type });
  if (game.log.length > 50) game.log.pop();
  renderLog();
}

// ---- ランキング ----

const RANK_KEY = 'ringRankingV1';

function loadRanking() {
  try {
    const raw = localStorage.getItem(RANK_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

function saveRanking(list) {
  try {
    localStorage.setItem(RANK_KEY, JSON.stringify(list));
  } catch (e) {}
}

function recordRanking(balls, renchan) {
  const list = loadRanking();
  const d = new Date();
  const entry = { balls, renchan, date: `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}` };
  list.push(entry);
  list.sort((a, b) => b.balls - a.balls);
  const trimmed = list.slice(0, 10);
  saveRanking(trimmed);
  return { list: trimmed, entry, madeList: trimmed.includes(entry) };
}

function renderRankingList(list, highlightEntry) {
  if (list.length === 0) return `<div class="rr-label" style="text-align:center;">まだ記録がありません</div>`;
  return list.map((r, i) => {
    const isNew = r === highlightEntry;
    return `<div class="result-row${isNew ? ' rank-new' : ''}">
      <span class="rr-label">${i + 1}位${isNew ? ' 🆕' : ''}</span>
      <span class="rr-val${isNew ? ' gold' : ''}">${r.balls.toLocaleString()}球（${r.renchan}連）<span class="rank-date">${r.date}</span></span>
    </div>`;
  }).join('');
}

function handleShowRanking() {
  setState('ranking_view');
}

function handleRankingBack() {
  setState('normal_idle');
}

// ---- 設定 ----

function handleSpinRateChange(value) {
  game.spinRate = Number(value);
  render();
}

function handleFlashChange(value) {
  game.flash = value;
  render();
}

// ---- 球数・投資（等価：1000円=250玉） ----

function consumeSpinCost() {
  const cost = calcSpinCost(game.spinRate);
  if (game.mochiDama >= cost) {
    game.mochiDama -= cost;
  } else {
    const shortfall = cost - game.mochiDama;
    const perThousand = 1000 / YEN_PER_BALL;
    const units = Math.ceil(shortfall / perThousand);
    game.toushi += units * 1000;
    game.mochiDama = units * perThousand - shortfall;
  }
  recordSlump();
}

function award(nominal) {
  const actual = toActualBalls(nominal);
  game.mochiDama += actual;
  if (game.session) {
    game.session.nominalBalls += nominal;
    game.session.actualBalls += actual;
  }
  return actual;
}

// ---- 通常時 ----

function checkEigyoAlert() {
  if (!game.eigyoAlertShown && game.totalSpins >= 2000) {
    game.eigyoAlertShown = true;
    setState('eigyo_alert');
    return true;
  }
  return false;
}

// 1回転処理。画面が変わるとき true を返す（外れは何も起きず回転数だけ進む）
function runNormalSpin() {
  game.totalSpins++;
  game.normalSpins++;
  game.currentSpins++;
  consumeSpinCost();
  const outcome = spinNormal(game.flash);
  if (outcome === 'miss') return false;

  const interval = game.normalSpins - game.lastHitSpins;
  if (outcome === 'false_flash') {
    game.pending = { isHit: false, interval };
    addLog(`${interval}回転で先ローリング！`);
    setState('flash');
    return true;
  }
  const type = rollNormalHitType();
  if (type === 'charge') {
    // チャージは先ローリングなし。そのままチャージと出して終わる
    game.pending = { isHit: true, interval, type };
    startSession(interval);
    const actual = award(CHARGE_BALLS);
    finishSingle();
    addLog(`${interval}回転でチャージ ＋${actual}球`, 'win');
    setState('charge_hit');
    return true;
  }
  game.pending = { isHit: true, interval, type, toRush: rollZugaraRush() };
  addLog(`${interval}回転で先ローリング！`);
  setState('flash');
  return true;
}

function handleStart() {
  if (checkEigyoAlert()) return;
  if (!runNormalSpin()) setState('normal_idle');
}

function autoSpin(count) {
  for (let i = 0; i < count; i++) {
    if (checkEigyoAlert()) return;
    if (runNormalSpin()) return;
  }
  setState('normal_idle');
}

function startSession(interval) {
  game.normalHitCount++;
  game.hitHistory.unshift({ games: interval, chain: null });
  game.currentSpins = 0;
  game.session = { hits: 1, nominalBalls: 0, actualBalls: 0, everRush: false };
}

// チャージ・ラッシュに入らない図柄揃いは単発で終わる：履歴を確定して、ラッシュ非突入の連続を数える
function finishSingle() {
  const last = game.hitHistory[0];
  if (last && last.chain === null) last.chain = 0;
  game.noRushStreak++;
}

function handleFlashJudge() {
  const p = game.pending;
  if (!p.isHit) {
    addLog('はずれ');
    setState('flash_miss');
    return;
  }
  startSession(p.interval);
  const actual = award(ZUGARA_BALLS);
  addLog(`${p.interval}回転で大当たり！ 図柄揃い ＋${actual.toLocaleString()}球`, 'win');
  setState('zugara_hit');
}

function backToNormal() {
  game.mode = 'normal';
  setState('normal_idle');
}

// ---- 図柄揃い後のラッシュ判定（57.4%） ----

function handleRushJudge() {
  if (game.pending.toRush) {
    addLog('ラッシュ突入！', 'rush');
    setState('judge_win');
  } else {
    finishSingle();
    addLog('ラッシュ非突入 → 通常へ');
    setState('judge_lose');
  }
}

// ---- ラッシュ（ST75回＝前半5回＋後半70回） ----

function rushSpinNo() {
  return RUSH_ST - game.stRemaining;
}

function enterRush() {
  if (!game.session.everRush) {
    game.session.everRush = true;
    game.rushEntryCount++;
    game.noRushStreak = 0;
    game.lastRushSpins = game.normalSpins;
  }
  game.mode = 'rush';
  game.stRemaining = RUSH_ST;
  setState('rush_idle');
}

// 1回転処理。画面遷移が起きたら true を返す
function runRushSpin(opts = {}) {
  game.rushAllStats.totalSpins++;
  game.stRemaining--;
  const spins = rushSpinNo();
  if (spinRush(spins) === 'hit') {
    const bonus = rollRushBonus(spins);
    game.rushAllStats.hits++;
    if (bonus.big) game.rushAllStats.big++;
    game.session.hits++;
    const actual = award(bonus.balls);
    game.pending = { spins, bonus };
    addLog(`ST${spins}回転目（${bonus.first ? '前半' : '後半'}）で当選！ ${bonus.balls.toLocaleString()}個 ＋${actual.toLocaleString()}球`, 'rush');
    game.stRemaining = RUSH_ST;
    setState('rush_hit');
    return true;
  }
  if (game.stRemaining <= 0) {
    game.rushAllStats.ends++;
    endSession();
    return true;
  }
  // 前半が終わって後半に入るところでは止める
  if (opts.stopAtSecond && spins === RUSH_FIRST_SPINS) {
    setState('rush_idle');
    return true;
  }
  if (!opts.silent) {
    setState('rush_idle');
    return true;
  }
  return false;
}

function handleRushSpin() {
  runRushSpin();
}

function handleRushSpin10() {
  for (let i = 0; i < 10; i++) {
    if (runRushSpin({ silent: true })) return;
  }
  setState('rush_idle');
}

// 前半中は前半の終わりまで、後半中は当たりか、残り10回まで一気に回す
function handleRushSkip() {
  for (;;) {
    if (runRushSpin({ silent: true, stopAtSecond: true })) return;
    if (game.stRemaining <= 10) {
      setState('rush_idle');
      return;
    }
  }
}

// ラッシュが75回スルーで終わったとき
function endSession() {
  const s = game.session;
  const last = game.hitHistory[0];
  if (last && last.chain === null) last.chain = s.hits;
  game.lastRankResult = recordRanking(Math.round(s.actualBalls), s.hits);
  addLog(`ラッシュ終了 → ${s.hits}連で終了`);
  setState('session_result');
}

function handleSessionEnd() {
  game.mode = 'normal';
  game.session = null;
  game.lastHitSpins = game.normalSpins;
  setState('normal_idle');
}

// ---- 営業終了・退店 ----

function idleStateForMode() {
  if (game.mode === 'rush') return 'rush_idle';
  return 'normal_idle';
}

function handleEigyoHai() {
  setState(idleStateForMode());
}

function handleEigyoIie() {
  setState('taiten_result');
}

function handleTaiten() {
  setState('taiten_result');
}

function resetGame() {
  Object.assign(game, {
    state: 'normal_idle',
    mode: 'normal',
    spinRate: DEFAULT_SPIN_RATE,
    flash: DEFAULT_FLASH,
    mochiDama: 0,
    toushi: 0,
    totalSpins: 0,
    normalSpins: 0,
    currentSpins: 0,
    lastHitSpins: 0,
    normalHitCount: 0,
    rushEntryCount: 0,
    noRushStreak: 0,
    lastRushSpins: 0,
    rushAllStats: { totalSpins: 0, hits: 0, big: 0, ends: 0 },
    session: null,
    stRemaining: 0,
    pending: {},
    eigyoAlertShown: false,
    detailsExpanded: false,
    shareOpen: false,
    lastRankResult: null,
    hitHistory: [],
    slump: [{ x: 0, y: 0 }],
    log: [],
  });
  renderLog();
  render();
}

// ---- 状態セット & レンダリング ----

function setState(state) {
  game.state = state;
  render();
}

// ---- 大当たり履歴グラフ ----
const HIST_BLOCK = 100;
const HIST_MAX_BLOCKS = 7;
function renderHitGraph() {
  const el = document.getElementById('hist-cols');
  if (!el) return;
  const col = (cls, games, label, idx) => {
    const blocks = Math.min(HIST_MAX_BLOCKS, Math.max(1, Math.ceil(games / HIST_BLOCK)));
    const more = games >= HIST_BLOCK * HIST_MAX_BLOCKS ? '<div class="hist-more">▲</div>' : '';
    return `<div class="hist-col ${cls}">
      <div class="hist-g">${games}</div>${more}
      ${'<div class="hist-block"></div>'.repeat(blocks)}
      <div class="hist-type">${label}</div>
      <div class="hist-idx">${idx}</div>
    </div>`;
  };
  let html = col('now', game.currentSpins, '現在', '');
  game.hitHistory.forEach((h, i) => {
    let cls, label;
    if (h.chain === null) { cls = 'pending'; label = '…'; }
    else if (h.chain >= 1) { cls = h.chain >= 10 ? 'big-chain' : 'rush'; label = `${h.chain}連`; }
    else { cls = 'zugar'; label = '単発'; }
    html += col(cls, h.games, label, i + 1);
  });
  if (game.hitHistory.length === 0) html += '<div class="hist-empty">まだ大当たりがありません</div>';
  el.innerHTML = html;
}

// ---- 差玉推移グラフ ----
// 差玉 = 持ち玉 − 投資玉（投資は4円/玉で玉に換算）。横軸は玉を使った総回転数（通常時）
function currentDiffBalls() {
  return Math.round(game.mochiDama - game.toushi / YEN_PER_BALL);
}
function recordSlump() {
  if (!game.slump) game.slump = [{ x: 0, y: 0 }];
  const y = currentDiffBalls();
  const pts = game.slump;
  const last = pts[pts.length - 1];
  if (last.x === game.totalSpins && last.y === y) return;
  pts.push({ x: game.totalSpins, y });
  if (pts.length > 40000) game.slump = pts.filter((_, i) => i % 2 === 0 || i === pts.length - 1);
}
function slumpNiceStep(range) {
  const raw = range / 4;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}
function renderSlumpGraph() {
  const el = document.getElementById('slump-svg');
  if (!el) return;
  recordSlump();
  const pts = game.slump;
  const W = 360, H = 170, L = 46, R = 8, T = 10, B = 22;
  const maxX = Math.max(100, pts[pts.length - 1].x);
  let minY = 0, maxY = 0;
  pts.forEach((p) => { if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; });
  if (maxY - minY < 1000) { maxY += 500; minY -= 500; }
  const step = slumpNiceStep(maxY - minY);
  minY = Math.floor(minY / step) * step;
  maxY = Math.ceil(maxY / step) * step;
  const sx = (x) => L + (x / maxX) * (W - L - R);
  const sy = (y) => T + (1 - (y - minY) / (maxY - minY)) * (H - T - B);
  let grid = '';
  for (let v = minY; v <= maxY + 1e-9; v += step) {
    const y = sy(v).toFixed(1);
    grid += `<line x1="${L}" y1="${y}" x2="${W - R}" y2="${y}" class="${v === 0 ? 'sl-zero' : 'sl-grid'}"/>`;
    grid += `<text x="${L - 4}" y="${(+y + 3).toFixed(1)}" class="sl-ylab">${v.toLocaleString()}</text>`;
  }
  const xStep = slumpNiceStep(maxX);
  for (let v = 0; v <= maxX + 1e-9; v += xStep) {
    const anchor = sx(v) > W - R - 16 ? ' style="text-anchor:end"' : '';
    grid += `<text x="${sx(v).toFixed(1)}" y="${H - 6}" class="sl-xlab"${anchor}>${v.toLocaleString()}</text>`;
  }
  const maxPts = (W - L - R) * 2;
  const stride = Math.max(1, Math.floor(pts.length / maxPts));
  const line = pts.filter((_, i) => i % stride === 0 || i === pts.length - 1)
    .map((p) => `${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
  const cur = pts[pts.length - 1];
  const cls = cur.y >= 0 ? 'plus' : 'minus';
  const zeroOff = Math.min(1, Math.max(0, (sy(0) - T) / (H - T - B))).toFixed(4);
  el.innerHTML = `<defs><linearGradient id="sl-grad" gradientUnits="userSpaceOnUse" x1="0" y1="${T}" x2="0" y2="${H - B}">
      <stop offset="${zeroOff}" stop-color="#2e9e5e"/><stop offset="${zeroOff}" stop-color="#d64545"/>
    </linearGradient></defs>
    ${grid}
    <polyline points="${line}" class="sl-line" stroke="url(#sl-grad)"/>
    <circle cx="${sx(cur.x).toFixed(1)}" cy="${sy(cur.y).toFixed(1)}" r="3" class="sl-dot ${cls}"/>`;
  document.getElementById('slump-now').innerHTML =
    `現在 <b class="${cls}">${cur.y >= 0 ? '+' : ''}${cur.y.toLocaleString()}玉</b>（${game.totalSpins.toLocaleString()}回転）`;
}

function render() {
  renderHeader();
  renderModeBadge();
  renderMainScreen();
  renderRushStats();
  renderHitGraph();
  renderSlumpGraph();
}

function handleToggleDetails() {
  game.detailsExpanded = !game.detailsExpanded;
  render();
}

function renderHeader() {
  const mochiInt = Math.floor(game.mochiDama);
  document.getElementById('mochi-dama').textContent = mochiInt.toLocaleString();
  document.getElementById('toushi-value').textContent = game.toushi.toLocaleString();

  const shuushi = Math.round(mochiInt * YEN_PER_BALL) - game.toushi;
  const shuushiEl = document.getElementById('shuushi-value');
  shuushiEl.textContent = (shuushi >= 0 ? '+' : '') + shuushi.toLocaleString();
  shuushiEl.className = 'money-value ' + (shuushi >= 0 ? 'green' : 'red');
  document.getElementById('current-spins').textContent = game.currentSpins.toLocaleString();
  document.getElementById('total-spins-disp').textContent = game.totalSpins.toLocaleString();

  const esupLabel = document.getElementById('esup-label');
  const esupValue = document.getElementById('rush-count');
  if (game.mode === 'rush') {
    esupLabel.textContent = 'ST残り';
    esupValue.textContent = `${game.stRemaining}回`;
  } else {
    esupLabel.textContent = '残り';
    esupValue.textContent = '－';
  }

  document.getElementById('total-hit-count').textContent =
    (game.normalHitCount + game.rushAllStats.hits) + '回';
  document.getElementById('normal-first-hit').textContent = game.normalHitCount + '回';
  document.getElementById('normal-first-prob').textContent = game.normalHitCount > 0 && game.normalSpins > 0
    ? '1/' + Math.round(game.normalSpins / game.normalHitCount).toLocaleString()
    : '1/―';

  document.getElementById('rush-entry-count').textContent = game.rushEntryCount + '回';
  const rushEntryRate = game.normalHitCount > 0 ? Math.round(game.rushEntryCount / game.normalHitCount * 100) : 0;
  document.getElementById('rush-entry-info').textContent = `(突入率 ${rushEntryRate}%)`;

  document.getElementById('hrow2-detail').style.display = game.detailsExpanded ? 'flex' : 'none';
  document.getElementById('details-toggle').textContent = game.detailsExpanded ? '詳細▴' : '詳細▾';
}

function renderModeBadge() {
  const el = document.getElementById('mode-badge');
  if (game.mode === 'rush') {
    el.textContent = 'ラッシュ中';
    el.className = 'rush';
  } else {
    el.textContent = '通常時';
    el.className = '';
  }
}

function renderMainScreen() {
  document.getElementById('main-screen').innerHTML = buildScreen(game.state);
}

function tenThousandYenSpins() {
  return game.spinRate * 10;
}

function spinRateOptionsHtml() {
  return SPIN_RATE_OPTIONS.map((rate) => {
    const note = rate === DEFAULT_SPIN_RATE ? '（ボーダー）' : '';
    return `<option value="${rate}" ${rate === game.spinRate ? 'selected' : ''}>${rate}回転${note}</option>`;
  }).join('');
}

function flashOptionsHtml() {
  return FLASH_OPTIONS.map((opt) => {
    const label = `${FLASH_MODE_NAMES[opt]}（当選率${opt}%）`;
    return `<option value="${opt}" ${opt === game.flash ? 'selected' : ''}>${label}</option>`;
  }).join('');
}

// 先ローリングの表示：モードの色（紫・赤・金）の枠。画像をもらったら差し替える
const SAKI_CLASSES = { '10': 'purple', '40': 'red', '99': 'gold' };
function sakiHtml() {
  return `<div class="roll-box ${SAKI_CLASSES[game.flash]}"><span>先ローリング！</span></div>`;
}

function flashLabel() {
  return `${FLASH_MODE_NAMES[game.flash]}（当選率${game.flash}%）`;
}

// ---- 出現率の表示 ----
function pctText(prob) {
  const pct = prob * 100;
  return pct >= 1 ? pct.toFixed(1) : pct >= 0.01 ? pct.toFixed(2) : pct.toPrecision(2);
}
function rareText(prob) {
  return prob * 100 < 1 ? `<br>約${Math.round(1 / prob).toLocaleString()}回に1回の割合です` : '';
}
function rareNote(html) {
  return `<p class="rare-note">${html}</p>`;
}

// 初当たりのハマり：1000回転超・50回転以内は出現率を表示
function hitIntervalProbHtml(n) {
  if (n > 1000) {
    const p = hitIntervalProbability(n).atLeast;
    return rareNote(`${n.toLocaleString()}回転以上ハマる確率 ${pctText(p)}%${rareText(p)}`);
  }
  if (n <= 50) {
    const p = hitIntervalProbability(n).within;
    return rareNote(`${n}回転以内に当たる確率 ${pctText(p)}%${rareText(p)}`);
  }
  return '';
}

// 初当たりでラッシュに入れなかった連続（5回連続目から）
const NO_RUSH_STREAK_NOTICE_MIN = 5;
function noRushStreakNoticeHtml() {
  const n = game.noRushStreak;
  if (n < NO_RUSH_STREAK_NOTICE_MIN) return '';
  const p = Math.pow(P_NO_RUSH_FROM_HIT, n);
  const hamari = game.normalSpins - game.lastRushSpins;
  return rareNote(`ラッシュ非突入　${n}回連続中<br>発生率 ${pctText(p)}%${rareText(p)}<br>前回のラッシュ突入から ${hamari.toLocaleString()}回転ハマり`);
}

const P_NORMAL_HIT_DISPLAY = '合算 約1/348.6（図柄揃い 1/399.7・チャージ 1/2723.4）';
const pct1 = (p) => Math.round(p * 1000) / 10;
const P_RUSH_DISPLAY = `ST${RUSH_ST}回 継続率 約${pct1(rushContinueProbability())}%<br>`
  + `前半${RUSH_FIRST_SPINS}回 1/8（約${pct1(rushFirstHitProbability())}%）／後半${RUSH_SECOND_SPINS}回 1/129.7（約${pct1(rushSecondHitProbability())}%）`;
const RUSH_ENTRY_THEORY = `理論 約${Math.round(rushEntryProbability() * 100)}%`;

function rushIdleScreen() {
  const no = rushSpinNo(); // これまでに回した回数（0〜74）
  const inFirst = no < RUSH_FIRST_SPINS;
  const phase = inFirst
    ? `<p class="rush-phase first">前半 残り${RUSH_FIRST_SPINS - no}回（1/8）</p>`
    : `<p class="rush-phase second">後半 残り${game.stRemaining}回（1/129.7）</p>`;
  return `<div class="screen">
    <p class="yodel-label">ラッシュ</p>
    <p class="chain-label">${game.session.hits}連チャン中</p>
    <p class="rush-sub">獲得出玉 <span>${game.session.nominalBalls.toLocaleString()}</span> 個</p>
    ${phase}
    <p class="rush-spins">ST残り ${game.stRemaining}回</p>
    <div class="rush-spin-btns">
      <button class="btn-rush-spin" onclick="handleRushSpin()">1回転</button>
      <button class="btn-rush-spin" onclick="handleRushSpin10()">10回転</button>
      <button class="btn-rush-spin skip" ${game.stRemaining <= 10 ? 'disabled' : 'onclick="handleRushSkip()"'}>スキップ</button>
    </div>
    <p class="prob-hint">${P_RUSH_DISPLAY}</p>
    ${shareTabHtml('rush')}
    <button class="btn-taiten" onclick="handleTaiten()">退店する</button>
  </div>`;
}

// ボーナスの振り分け（そのボーナスが選ばれる割合）を表示する
function shareNote(text) {
  return `<p class="share-note">振り分け ${text}</p>`;
}
// ラッシュ：前半は6000 or 3000個（半々）、後半は1500個
function rushShareHtml(b) {
  if (!b.first) return shareNote('後半の当たり 1500個 100%');
  return shareNote(`前半の当たり ${b.balls.toLocaleString()}個 50%`);
}
const CHARGE_SHARE_HTML = shareNote(`チャージ 1/2723.4<br><small>（当たり全体の約${Math.round(P_CHARGE / P_TOTAL_HIT * 100)}%）</small>`);

// ---- 「当たったときの振り分け」タブ（タッチで開閉。普段は閉じておく） ----
const SHARE_TABLES = {
  zugara: {
    title: '図柄揃い（1500個）のあと',
    rows: [['ラッシュ突入', '57.4%'], ['通常へ（時短なし）', '42.6%']],
    note: '',
  },
  rush: {
    title: 'ラッシュ中の当たり',
    rows: [['前半5回：6000個（10R×4）', '50%'], ['前半5回：3000個（10R×2）', '50%'], ['後半70回：1500個', '100%']],
    note: 'どれも当たれば前半5回からやり直し。75回スルーで終了',
  },
};

function handleToggleShare() {
  game.shareOpen = !game.shareOpen;
  render();
}

function shareTabHtml(key) {
  const t = SHARE_TABLES[key];
  const body = game.shareOpen
    ? `<div class="share-tab-body">
        <p class="share-tab-title">${t.title}</p>
        ${t.rows.map(([k, v]) => `<div class="share-tab-row"><span>${k}</span><span>${v}</span></div>`).join('')}
        ${t.note ? `<p class="share-tab-note">${t.note}</p>` : ''}
      </div>`
    : '';
  return `<div class="share-tab">
    <button class="share-tab-btn" type="button" onclick="handleToggleShare()">${game.shareOpen ? '▲' : '▼'} 当たったときの振り分け</button>
    ${body}
  </div>`;
}

// 10R=1500個。3000以上は「10R×◯」も添える
function roundsText(nominal) {
  return nominal >= 3000 ? `<p class="judge-label">10R×${nominal / 1500}</p>` : '';
}

// 「1500ボーナス！」と大きく出し、下に小さく（実質獲得 1,400）。300個は「チャージ！」。
// label はその上に小さく出す見出し（任意）
function bonusBox(label, nominal, cls = 'standard', sub = '') {
  return `<div class="vibun-box rush-box">
    ${label ? `<p class="bonus-label">${label}</p>` : ''}
    <p class="bonus-main ${cls}">${nominal === CHARGE_BALLS ? 'チャージ！' : `${nominal}ボーナス！`}</p>
    <p class="bonus-sub">（実質獲得 ${toActualBalls(nominal).toLocaleString()}）</p>
    ${sub}
  </div>`;
}

function buildScreen(state) {
  const p = game.pending;
  switch (state) {

    case 'normal_idle':
      return `<div class="screen">
        <button class="btn-start" onclick="handleStart()">START</button>
        <p class="prob-hint">${P_NORMAL_HIT_DISPLAY}</p>
        <div class="spin-rate-block">
          <span class="spin-rate-label">先ローリング</span>
          <select class="spin-rate-select" onchange="handleFlashChange(this.value)">${flashOptionsHtml()}</select>
        </div>
        <div class="spin-rate-block">
          <span class="spin-rate-label">1000円あたりの回転数</span>
          <select class="spin-rate-select" onchange="handleSpinRateChange(this.value)">${spinRateOptionsHtml()}</select>
        </div>
        <div class="auto-spin-btns">
          <div class="auto-spin-wrap">
            <button class="btn-auto" onclick="autoSpin(${Math.round(tenThousandYenSpins())})">1万円分回す</button>
            <p class="spin-cost-hint">約${Math.round(tenThousandYenSpins())}回転分</p>
          </div>
        </div>
        <div style="display:flex; gap:8px;">
          <button class="btn-taiten" onclick="handleTaiten()">退店する</button>
          <button class="btn-taiten" onclick="handleShowRanking()">🏆 ランキング</button>
        </div>
      </div>`;

    case 'ranking_view':
      return `<div class="screen">
        <p class="rush-result-title">🏆 最高出玉ランキング</p>
        <button class="btn-sub" onclick="handleRankingBack()">戻る</button>
        <div class="rush-result-box">
          ${renderRankingList(loadRanking())}
        </div>
      </div>`;

    case 'flash':
      return `<div class="screen">
        <p class="result-sub">${p.interval}回転</p>
        ${sakiHtml()}
        <p class="shinraido">${flashLabel()}</p>
        <button class="btn-action" onclick="handleFlashJudge()">▶ 判定</button>
      </div>`;

    case 'flash_miss':
      return `<div class="screen">
        <p class="result-main lose">はずれ</p>
        <button class="btn-sub" onclick="backToNormal()" style="margin-top:8px;">続ける</button>
      </div>`;

    case 'zugara_hit':
      return `<div class="screen">
        <p class="result-sub">${p.interval}回転で大当たり</p>
        ${bonusBox('図柄揃い！', ZUGARA_BALLS)}
        ${hitIntervalProbHtml(p.interval)}
        <p class="prob-hint">ラッシュ突入率 57.4%</p>
        <button class="gasha-button" onclick="handleRushJudge()">PUSH</button>
        ${shareTabHtml('zugara')}
      </div>`;

    case 'judge_win':
      return `<div class="screen">
        <p class="judge-win">ラッシュ突入！</p>
        <p class="result-sub">ST${RUSH_ST}回（前半${RUSH_FIRST_SPINS}回＋後半${RUSH_SECOND_SPINS}回）</p>
        ${shareNote('ラッシュ突入 57.4%')}
        <button class="btn-action" onclick="enterRush()">▶ ラッシュへ</button>
      </div>`;

    case 'judge_lose':
      return `<div class="screen">
        <p class="result-main lose small">ラッシュならず…</p>
        <p class="result-sub">通常時へ戻ります（時短なし）</p>
        ${shareNote('通常へ 42.6%')}
        ${noRushStreakNoticeHtml()}
        <button class="btn-sub" onclick="handleSessionEnd()" style="margin-top:8px;">▶ 通常へ戻る</button>
      </div>`;

    case 'charge_hit':
      return `<div class="screen">
        <p class="result-sub">${p.interval}回転で当たり</p>
        ${bonusBox('', CHARGE_BALLS)}
        ${CHARGE_SHARE_HTML}
        ${hitIntervalProbHtml(p.interval)}
        ${noRushStreakNoticeHtml()}
        <button class="btn-sub" onclick="handleSessionEnd()" style="margin-top:8px;">▶ 通常へ戻る</button>
      </div>`;

    case 'rush_idle':
      return rushIdleScreen();

    case 'rush_hit': {
      const b = p.bonus;
      return `<div class="screen">
        <p class="result-sub">ST${p.spins}回転目（${b.first ? '前半' : '後半'}）で当選</p>
        <p class="chain-label">${game.session.hits}連チャン</p>
        ${bonusBox('', b.balls, b.first ? 'premium' : 'standard', roundsText(b.balls))}
        ${rushShareHtml(b)}
        <button class="btn-action" onclick="enterRush()">▶ 次へ（前半5回から）</button>
      </div>`;
    }

    case 'session_result': {
      const s = game.session;
      const rank = game.lastRankResult;
      return `<div class="screen">
        <p class="result-main lose small">ラッシュ終了</p>
        <p class="rush-result-title">リザルト</p>
        <div class="rush-result-box">
          <div class="result-row highlight">
            <span class="rr-label">連チャン数（初当たり含む）</span>
            <span class="rr-val gold">${s.hits}連</span>
          </div>
          <div class="result-row">
            <span class="rr-label">TOTAL</span>
            <span class="rr-val gold">${s.nominalBalls.toLocaleString()}個</span>
          </div>
          <div class="result-row">
            <span class="rr-label">獲得出玉</span>
            <span class="rr-val">${Math.round(s.actualBalls).toLocaleString()}球</span>
          </div>
        </div>
        ${s.everRush ? '' : noRushStreakNoticeHtml()}
        <button class="btn-action" onclick="handleSessionEnd()">▶ 通常へ戻る</button>
        <div class="rush-result-box">
          <p class="rr-section">🏆 最高出玉ランキング</p>
          ${rank && rank.madeList ? '<p class="rank-madelist">ランクイン！</p>' : ''}
          ${renderRankingList(rank ? rank.list : loadRanking(), rank ? rank.entry : null)}
        </div>
      </div>`;
    }

    case 'eigyo_alert':
      return `<div class="screen">
        <p style="font-size:22px; font-weight:bold; color:var(--c-ruri); text-align:center; line-height:1.6;">
          営業時間終了になりました
        </p>
        <p style="font-size:16px; color:#666; text-align:center;">このまま居座り続けますか？</p>
        <div style="display:flex; gap:16px; margin-top:8px;">
          <button class="btn-action" style="flex:1;" onclick="handleEigyoHai()">はい</button>
          <button class="btn-action" style="flex:1; background:linear-gradient(135deg,#999,#666); border-color:#ccc;"
            onclick="handleEigyoIie()">いいえ</button>
        </div>
      </div>`;

    case 'taiten_result': {
      const mochi = Math.floor(game.mochiDama);
      const mochiYen = Math.round(mochi * YEN_PER_BALL);
      const shuushi = mochiYen - game.toushi;
      const shuushiColor = shuushi >= 0 ? '#2e9e5b' : '#d24141';
      const shuushiSign = shuushi >= 0 ? '＋' : '';
      return `<div class="screen">
        <p style="font-size:24px; font-weight:bold; color:#666;">退店します</p>
        <div class="rush-result-box" style="max-width:320px;">
          <p class="rr-section" style="margin-bottom:8px;">収支発表</p>
          <div class="result-row">
            <span class="rr-label">総回転数</span>
            <span class="rr-val">${game.totalSpins.toLocaleString()}回</span>
          </div>
          <div class="result-row">
            <span class="rr-label">投資金額</span>
            <span class="rr-val" style="color:#d24141;">${game.toushi.toLocaleString()}円</span>
          </div>
          <div class="result-row">
            <span class="rr-label">持ち球換算</span>
            <span class="rr-val">${mochiYen.toLocaleString()}円</span>
          </div>
          <hr class="result-hr">
          <div class="result-row highlight">
            <span class="rr-label" style="font-weight:bold;">収支</span>
            <span class="rr-val" style="color:${shuushiColor}; font-size:22px;">
              ${shuushiSign}${shuushi.toLocaleString()}円
            </span>
          </div>
          <hr class="result-hr">
          <div class="result-row">
            <span class="rr-label">初当たり</span>
            <span class="rr-val">${game.normalHitCount}回</span>
          </div>
          <div class="result-row">
            <span class="rr-label">ラッシュ突入</span>
            <span class="rr-val">${game.rushEntryCount}回</span>
          </div>
        </div>
        <button class="btn-action" onclick="resetGame()" style="margin-top:8px;">▶ 最初の画面に戻る</button>
      </div>`;
    }

    default:
      return `<div class="screen"><p>...</p></div>`;
  }
}

function renderRushStats() {
  const s = game.rushAllStats;
  const prob = s.hits > 0 && s.totalSpins > 0 ? '1/' + (s.totalSpins / s.hits).toFixed(1) : '1/―';
  document.getElementById('rs-chain').textContent = s.hits + '回';
  document.getElementById('rs-prob').textContent = prob;
  document.getElementById('rs-spins').textContent = s.totalSpins + '回';
  document.getElementById('rs-big').textContent = s.big + '回';
}

function renderLog() {
  const el = document.getElementById('log-list');
  el.innerHTML = game.log.map(item =>
    `<div class="log-item ${item.type}">${item.text}</div>`
  ).join('');
}

render();
