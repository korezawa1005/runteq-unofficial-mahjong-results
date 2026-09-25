import {leaderboard, rankSeries, summarize} from './stats.js';

const app = document.querySelector('#app');
const toast = document.querySelector('#toast');
let state = {players: [], games: [], adminConfigured: false, isAdmin: false, accessConfigured: false, hasAccess: true};
let restorePayload = null;

const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
const number = value => Math.round(value).toLocaleString('ja-JP');
const percent = value => value == null ? '—' : `${value.toFixed(2)}%`;
const rankValue = value => value == null ? '—' : value.toFixed(2);
const localNow = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const hashInfo = () => {
  const [page = 'stats', query = ''] = (location.hash.slice(1) || 'stats').split('?');
  return {page, params: new URLSearchParams(query)};
};
const years = () => [...new Set(state.games.map(game => game.played_at.slice(0, 4)).filter(Boolean))].sort((a, b) => b.localeCompare(a));
const selectedYear = params => params.get('year') || years()[0] || 'all';
const gamesForYear = year => year === 'all' ? state.games : state.games.filter(game => game.played_at.startsWith(`${year}-`));
const queryHash = (page, values) => {
  const params = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => value != null && value !== '' && params.set(key, value));
  return `${page}${params.size ? `?${params}` : ''}`;
};

async function api(path, options = {}) {
  const headers = options.body ? {'Content-Type': 'application/json', 'X-Requested-With': 'HanchanRecord'} : {};
  if (options.method && options.method !== 'GET') headers['X-Requested-With'] = 'HanchanRecord';
  const response = await fetch(path, {...options, headers: {...headers, ...(options.headers || {})}});
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || '処理できませんでした。');
  return body;
}

function notify(message, error = false) {
  toast.textContent = message;
  toast.className = error ? 'show error' : 'show';
  setTimeout(() => toast.className = '', 2800);
}

function route() {
  if (state.accessConfigured && !state.hasAccess) {
    document.body.classList.add('access-locked');
    document.querySelectorAll('[data-nav]').forEach(link => link.classList.remove('active'));
    renderAccessLock();
    return;
  }
  document.body.classList.remove('access-locked');
  const {page} = hashInfo();
  document.querySelectorAll('[data-nav]').forEach(link => link.classList.toggle('active', link.dataset.nav === page));
  if (page === 'record') renderRecord();
  else if (page === 'history') renderHistory();
  else if (page === 'members') renderMembers();
  else renderStats();
}

function empty(title, text, action = '') {
  return `<section class="empty"><div class="empty-mascot"><img src="/assets/rantekun.jpg" alt=""></div><h2>${title}</h2><p>${text}</p>${action}</section>`;
}

function renderAccessLock() {
  app.innerHTML = `<section class="access-gate panel">
    <div class="empty-mascot"><img src="/assets/rantekun.jpg" alt="らんてくん"></div>
    <p class="eyebrow">CIRCLE MEMBERS ONLY</p><h1>サークル共通PIN</h1>
    <p>仲間から共有されたPINを入力してください。この端末では30日間入力を省略できます。</p>
    <form id="access-login"><label class="field"><span>共通PIN</span><input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4,12}" maxlength="12" autocomplete="current-password" autofocus required></label><button class="button primary" type="submit">成績表を開く</button></form>
    ${state.adminConfigured ? `<details><summary>管理者PINで入る</summary><form id="gate-admin-login"><label class="field"><span>管理者PIN</span><input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4,12}" maxlength="12" required></label><button class="button secondary" type="submit">管理者として開く</button></form></details>` : ''}
  </section>`;
  document.querySelector('#access-login').addEventListener('submit', loginAccess);
  document.querySelector('#gate-admin-login')?.addEventListener('submit', loginAdmin);
}

function yearControl(year, id = 'year-filter') {
  return `<label class="filter-control"><span>集計期間</span><select id="${id}"><option value="all" ${year === 'all' ? 'selected' : ''}>通算</option>${years().map(value => `<option value="${value}" ${year === value ? 'selected' : ''}>${value}年</option>`).join('')}</select></label>`;
}

function renderStats() {
  if (!state.players.length) {
    app.innerHTML = empty('最初にメンバーを登録しましょう', '4人以上登録すると、半荘の結果を記録できます。', '<a class="button primary" href="#members">メンバーを登録</a>');
    return;
  }
  const {params} = hashInfo();
  const year = selectedYear(params);
  const view = params.get('view') === 'list' ? 'list' : 'personal';
  const rankingMetrics = ['averageRank', 'topRate', 'rentaiRate', 'avoidLastRate', 'avoidBustRate'];
  const sort = rankingMetrics.includes(params.get('sort')) ? params.get('sort') : 'averageRank';
  const selectedId = params.get('player') || state.players[0].id;
  const player = state.players.find(item => item.id === selectedId) || state.players[0];
  const games = gamesForYear(year);
  app.innerHTML = `
    <section class="page-head stats-head">
      <div><p class="eyebrow">RECORDS</p><h1>${view === 'list' ? 'ランキング' : '個人成績'}</h1><p>${year === 'all' ? 'すべての' : `${year}年の`}半荘記録を集計しています。</p></div>
      <div class="head-filters">${yearControl(year)}${view === 'personal' ? `<label class="filter-control"><span>メンバー</span><select id="stats-player">${state.players.map(item => `<option value="${item.id}" ${item.id === player.id ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}</select></label>` : ''}</div>
    </section>
    <div class="view-switch" role="group" aria-label="成績表示"><a class="${view === 'personal' ? 'active' : ''}" href="#${queryHash('stats', {year, player: player.id})}">個人成績</a><a class="${view === 'list' ? 'active' : ''}" href="#${queryHash('stats', {view: 'list', year, sort})}">ランキング</a></div>
    ${view === 'list' ? comparisonView(games, year, sort) : personalView(player, games)}
  `;
  document.querySelector('#year-filter').addEventListener('change', event => {
    location.hash = queryHash('stats', {view: view === 'list' ? 'list' : null, year: event.target.value, player: view === 'personal' ? player.id : null, sort: view === 'list' ? sort : null});
  });
  document.querySelector('#stats-player')?.addEventListener('change', event => {
    location.hash = queryHash('stats', {year, player: event.target.value});
  });
}

function personalView(player, games) {
  const stats = summarize(player, games);
  return stats.count ? statsView(stats, games) : empty(`${esc(player.name)}さんの記録はありません`, '選択した期間に半荘を記録すると、ここに成績が表示されます。', '<a class="button primary" href="#record">対局を記録</a>');
}

function card(label, value, suffix = '') {
  return `<article class="stat-card"><span>${label}</span><strong>${value}<small>${suffix}</small></strong></article>`;
}

function statsView(stats, games) {
  const colors = ['#2f7650', '#3274a1', '#d97918', '#b24751'];
  return `<section class="stats-grid">
      ${card('ゲーム数', number(stats.count), '回')}${card('トップ回数', number(stats.ranks[0]), '回')}${card('トップ率', percent(stats.topRate))}${card('平均着順', rankValue(stats.averageRank), '位')}${card('ラス回避率', percent(stats.avoidLastRate))}${card('連対率', percent(stats.rentaiRate))}${card('飛び回避率', percent(stats.avoidBustRate))}
    </section>
    ${rankTrend(stats.player, games)}
    <section class="panel rank-panel"><div class="panel-title"><div><p class="eyebrow">RANK DISTRIBUTION</p><h2>着順の内訳</h2></div><span>${stats.count}半荘</span></div>
      <div class="rank-bar" aria-label="着順の割合">${stats.rates.map((rate, i) => rate ? `<span style="width:${rate}%;background:${colors[i]}">${rate >= 9 ? `${rate.toFixed(1)}%` : ''}</span>` : '').join('')}</div>
      <div class="rank-list">${stats.ranks.map((count, i) => `<div><i style="background:${colors[i]}"></i><span>${i + 1}位</span><strong>${count}<small>回</small></strong><em>${stats.rates[i].toFixed(2)}%</em></div>`).join('')}</div>
    </section>`;
}

function rankTrend(player, games) {
  const series = rankSeries(player.id, games, 10);
  const width = 900, height = 280, left = 58, right = 22, top = 20, bottom = 42;
  const chartWidth = width - left - right, chartHeight = height - top - bottom;
  const x = index => series.length === 1 ? left + chartWidth / 2 : left + index / (series.length - 1) * chartWidth;
  const y = value => top + (value - 1) / 3 * chartHeight;
  const points = series.map((item, index) => `${x(index).toFixed(1)},${y(item.value).toFixed(1)}`).join(' ');
  const labelIndexes = [...new Set([0, Math.floor((series.length - 1) / 2), series.length - 1])];
  return `<section class="panel trend-panel"><div class="panel-title"><div><p class="eyebrow">RANK TREND</p><h2>着順の推移</h2></div><span>直近${series.length}半荘</span></div>
    <div class="trend-summary"><span>直近の着順</span><strong>${series.at(-1).value}<small>位</small></strong></div><div class="chart-scroll"><svg class="trend-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="着順の推移">
      ${[1,2,3,4].map(rank => `<line class="grid-line" x1="${left}" y1="${y(rank)}" x2="${width-right}" y2="${y(rank)}"></line><text class="axis-label" x="${left-10}" y="${y(rank)+4}" text-anchor="end">${rank}位</text>`).join('')}
      <polyline class="trend-line" points="${points}"></polyline>${series.map((item, index) => `<circle class="trend-point trend-rank-${item.value}" cx="${x(index)}" cy="${y(item.value)}" r="${index === series.length - 1 ? 5 : 3}"><title>${item.date}・${item.game}半荘目：${item.value}位</title></circle>`).join('')}
      ${labelIndexes.map(index => `<text class="axis-label x-label" x="${x(index)}" y="${height-12}" text-anchor="middle">${series[index].game}半荘</text>`).join('')}</svg></div><p class="chart-note">選択期間内の直近10半荘で取った着順です。上に近いほど良い成績です。</p></section>`;
}

function comparisonView(games, year, sort) {
  const metrics = {
    averageRank: {label:'平均着順', short:'平均着順', value:stats => `${rankValue(stats.averageRank)}位`},
    topRate: {label:'トップ率', short:'トップ率', value:stats => percent(stats.topRate)},
    rentaiRate: {label:'連対率', short:'連対率', value:stats => percent(stats.rentaiRate)},
    avoidLastRate: {label:'ラス回避率', short:'ラス回避', value:stats => percent(stats.avoidLastRate)},
    avoidBustRate: {label:'飛び回避率', short:'飛び回避', value:stats => percent(stats.avoidBustRate)},
  };
  const rows = leaderboard(state.players, games, sort);
  const leaders = rows.filter(row => row.count).slice(0, 3);
  const metric = metrics[sort];
  const metricLinks = Object.entries(metrics).map(([key, item]) => `<a class="${key === sort ? 'active' : ''}" aria-current="${key === sort ? 'true' : 'false'}" href="#${queryHash('stats', {view:'list', year, sort:key})}">${item.short}</a>`).join('');
  const podium = leaders.length ? `<section class="ranking-podium">${leaders.map(stats => `<article class="podium-card place-${stats.position}"><span class="podium-rank">${stats.position}<small>位</small></span><div><p>${esc(stats.player.name)}</p><strong>${metric.value(stats)}</strong><small>${stats.count}半荘</small></div></article>`).join('')}</section>` : '';
  const active = key => key === sort ? 'active-metric' : '';
  return `<section class="ranking-tools"><div><p class="eyebrow">RANK BY</p><h2>${metric.label}ランキング</h2></div><nav class="metric-switch" aria-label="ランキング基準">${metricLinks}</nav></section>${podium}
    <section class="panel comparison-panel"><div class="table-scroll"><table class="comparison-table"><thead><tr><th>順位</th><th>メンバー</th><th>対局数</th><th class="${active('averageRank')}">平均着順</th><th class="${active('topRate')}">トップ率</th><th class="${active('rentaiRate')}">連対率</th><th class="${active('avoidLastRate')}">ラス回避率</th><th class="${active('avoidBustRate')}">飛び回避率</th></tr></thead><tbody>${rows.map(stats => `<tr class="${stats.count ? '' : 'no-record'}"><td><span class="table-rank rank-${stats.position || 0}">${stats.position ?? '—'}</span></td><th><a href="#${queryHash('stats', {player:stats.player.id, year})}">${esc(stats.player.name)}</a></th><td>${stats.count}</td><td class="${active('averageRank')}">${rankValue(stats.averageRank)}</td><td class="${active('topRate')}">${percent(stats.topRate)}</td><td class="${active('rentaiRate')}">${percent(stats.rentaiRate)}</td><td class="${active('avoidLastRate')}">${percent(stats.avoidLastRate)}</td><td class="${active('avoidBustRate')}">${percent(stats.avoidBustRate)}</td></tr>`).join('')}</tbody></table></div></section>`;
}

function gameForm(game = null) {
  const selectable = game ? state.players : state.players.filter(player => !player.archived);
  const latest = state.games[0];
  const canReuseLatest = latest && latest.results.every(result => selectable.some(player => player.id === result.player_id));
  const initial = game ? [...game.results].sort((a,b) => a.rank-b.rank) : selectable.slice(0, 4).map((player, index) => ({player_id: player.id, score: [40000,30000,20000,10000][index]}));
  return `<form id="game-form" class="panel form-panel" data-game-id="${game?.id || ''}">
    <div class="form-toolbar"><label class="field date-field"><span>対局日時</span><input type="datetime-local" name="played_at" value="${esc(game?.played_at || localNow())}" required></label>${!game && canReuseLatest ? '<button class="button secondary" id="reuse-players" type="button">前回の4人を選択</button>' : ''}</div>
    <div class="result-table"><div class="result-heading"><span>順位</span><span>メンバー</span><span>終了時点数</span></div>${[1,2,3,4].map((rank, index) => `<div class="result-row"><div class="rank-badge rank-${rank}">${rank}<small>位</small></div><label><span class="mobile-label">メンバー</span><select name="player" required>${selectable.map(item => `<option value="${item.id}" ${item.id === initial[index]?.player_id ? 'selected' : ''}>${esc(item.name)}${item.archived ? '（非表示）' : ''}</option>`).join('')}</select></label><label class="score-input"><span class="mobile-label">終了時点数</span><input name="score" type="number" step="100" value="${initial[index]?.score ?? [40000,30000,20000,10000][index]}" required><b>点</b></label><input type="hidden" name="rank" value="${rank}"></div>`).join('')}</div>
    <p id="player-error" class="form-error" role="alert" hidden>同じメンバーを重複して選択できません。</p>
    <p id="score-order-error" class="form-error" role="alert" hidden>点数と順位が一致していません。高い点数の人を上位にしてください。</p>
    <p id="tie-note" class="form-note" hidden>同点のため順位を確認してください。上の行のメンバーを上位として記録します。</p>
    <div class="score-total">点数合計 <strong id="score-total">100,000点</strong><span>（100,000点にしてください）</span></div>
    <div class="form-actions">${game ? '<a class="button secondary" href="#history">キャンセル</a>' : ''}<button class="button primary submit" type="submit">${game ? '変更を保存' : 'この結果を記録'}</button></div>
  </form>`;
}

function renderRecord() {
  const activePlayers = state.players.filter(player => !player.archived);
  if (activePlayers.length < 4) {
    const action = state.isAdmin ? '<a class="button primary" href="#members">メンバーを登録</a>' : '<a class="button primary" href="#members">管理者ロックを解除</a>';
    app.innerHTML = empty('メンバーが4人必要です', `現在は${activePlayers.length}人です。あと${4 - activePlayers.length}人登録してください。`, action);
    return;
  }
  app.innerHTML = `<section class="page-head"><div><p class="eyebrow">NEW GAME</p><h1>対局を記録</h1><p>順位の行にメンバーと終了時点数を入力します。</p></div></section>${gameForm()}${recentGamesView()}`;
  bindGameForm();
}

function bindGameForm() {
  const form = document.querySelector('#game-form');
  const playerSelects = [...form.querySelectorAll('[name=player]')];
  const scoreInputs = [...form.querySelectorAll('[name=score]')];
  const submitButton = form.querySelector('[type=submit]');
  const validate = () => {
    const selected = playerSelects.map(select => select.value);
    const duplicated = new Set(selected).size !== selected.length;
    playerSelects.forEach(select => {
      [...select.options].forEach(option => option.disabled = option.value !== select.value && selected.includes(option.value));
      select.setCustomValidity(duplicated ? '同じメンバーを重複して選択できません。' : '');
    });
    document.querySelector('#player-error').hidden = !duplicated;
    const scores = scoreInputs.map(input => Number(input.value || 0));
    const total = scores.reduce((sum, score) => sum + score, 0);
    const wrongOrder = scores.some((score, index) => index < 3 && score < scores[index + 1]);
    const tied = scores.some((score, index) => index < 3 && score === scores[index + 1]);
    const output = document.querySelector('#score-total');
    output.textContent = `${total.toLocaleString('ja-JP')}点`;
    output.classList.toggle('invalid', total !== 100000);
    document.querySelector('#score-order-error').hidden = !wrongOrder;
    document.querySelector('#tie-note').hidden = !tied || wrongOrder;
    submitButton.disabled = duplicated || total !== 100000 || wrongOrder;
  };
  playerSelects.forEach(select => select.addEventListener('change', validate));
  scoreInputs.forEach(input => input.addEventListener('input', validate));
  document.querySelector('#reuse-players')?.addEventListener('click', () => {
    [...state.games[0].results].sort((a,b) => a.rank-b.rank).forEach((result, index) => playerSelects[index].value = result.player_id);
    validate();
    notify('前回の4人を選択しました。');
  });
  form.addEventListener('submit', saveGame);
  validate();
}

function formatGame(game, actions = true) {
  const {page, params} = hashInfo();
  const suffix = new URLSearchParams(params);
  suffix.set('edit', game.id);
  return `<article class="game-row"><time>${new Date(game.played_at).toLocaleString('ja-JP', {year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</time><div>${[...game.results].sort((a,b) => a.rank-b.rank).map(result => `<span><b>${result.rank}位</b> ${esc(result.name)} <em>${number(result.score)}点</em></span>`).join('')}</div>${state.isAdmin && actions ? `<aside><a href="#${page}?${suffix}">編集</a><button type="button" data-delete="${game.id}">削除</button></aside>` : ''}</article>`;
}

function recentGamesView() {
  if (!state.games.length) return '';
  return `<section class="history"><div class="panel-title"><div><p class="eyebrow">RECENT GAMES</p><h2>最近の対局</h2></div><a href="#history">すべて見る</a></div>${state.games.slice(0, 5).map(game => formatGame(game, false)).join('')}</section>`;
}

async function saveGame(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const players = [...form.querySelectorAll('[name=player]')];
  const scores = [...form.querySelectorAll('[name=score]')];
  const gameId = form.dataset.gameId;
  const button = form.querySelector('[type=submit]');
  button.disabled = true;
  try {
    const payload = {played_at: form.played_at.value, results: players.map((input, index) => ({player_id: input.value, rank: index + 1, score: Number(scores[index].value)}))};
    await api(gameId ? `/api/games/${gameId}` : '/api/games', {method: gameId ? 'PATCH' : 'POST', body: JSON.stringify(payload)});
    await refreshState();
    notify(gameId ? '対局結果を変更しました。' : '対局結果を記録しました。');
    location.hash = gameId ? 'history' : `stats?player=${players[0].value}&year=${form.played_at.value.slice(0,4)}`;
  } catch (error) { notify(error.message, true); button.disabled = false; }
}

async function deleteGame(event) {
  if (!confirm('この対局記録を削除しますか？')) return;
  try { await api(`/api/games/${event.currentTarget.dataset.delete}`, {method:'DELETE'}); await refreshState(); notify('対局記録を削除しました。'); route(); }
  catch (error) { notify(error.message, true); }
}

function renderHistory() {
  const {params} = hashInfo();
  const editing = params.get('edit');
  const game = state.games.find(item => item.id === editing);
  if (editing && state.isAdmin && game) {
    app.innerHTML = `<section class="page-head"><div><p class="eyebrow">EDIT GAME</p><h1>対局を編集</h1><p>保存すると個人成績も自動で再集計されます。</p></div></section>${gameForm(game)}`;
    bindGameForm();
    return;
  }
  const year = selectedYear(params);
  const playerId = params.get('player') || 'all';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const filtered = gamesForYear(year).filter(item => playerId === 'all' || item.results.some(result => result.player_id === playerId));
  const perPage = 20, pageCount = Math.max(1, Math.ceil(filtered.length / perPage)), current = Math.min(page, pageCount);
  const shown = filtered.slice((current - 1) * perPage, current * perPage);
  app.innerHTML = `<section class="page-head"><div><p class="eyebrow">GAME HISTORY</p><h1>対局履歴</h1><p>保存した半荘を年・メンバーで絞り込めます。</p></div><div class="head-filters">${yearControl(year, 'history-year')}<label class="filter-control"><span>メンバー</span><select id="history-player"><option value="all">全員</option>${state.players.map(player => `<option value="${player.id}" ${player.id === playerId ? 'selected' : ''}>${esc(player.name)}</option>`).join('')}</select></label></div></section>
    <section class="history history-page"><div class="panel-title"><h2>${filtered.length}件の対局</h2><span>${current} / ${pageCount}ページ</span></div>${shown.length ? shown.map(gameItem => formatGame(gameItem)).join('') : empty('該当する対局はありません', '条件を変えるか、新しい対局を記録してください。')}</section>
    ${pageCount > 1 ? `<nav class="pagination" aria-label="履歴ページ">${Array.from({length: pageCount}, (_, i) => `<a class="${i + 1 === current ? 'active' : ''}" href="#${queryHash('history', {year, player: playerId, page: i + 1})}">${i + 1}</a>`).join('')}</nav>` : ''}`;
  document.querySelector('#history-year').addEventListener('change', event => location.hash = queryHash('history', {year:event.target.value, player:playerId}));
  document.querySelector('#history-player').addEventListener('change', event => location.hash = queryHash('history', {year, player:event.target.value}));
  document.querySelectorAll('[data-delete]').forEach(button => button.addEventListener('click', deleteGame));
}

function renderMembers() {
  const activeCount = state.players.filter(player => !player.archived).length;
  app.innerHTML = `<section class="page-head"><div><p class="eyebrow">PLAYERS</p><h1>メンバー</h1><p>登録メンバーと管理設定を確認します。</p></div><span class="admin-status ${state.isAdmin ? 'unlocked' : ''}">${state.isAdmin ? '管理者モード' : '一般モード'}</span></section>
    <section class="member-layout"><div class="admin-column">${adminPanel()}</div><section class="panel member-list"><div class="panel-title"><h2>登録メンバー</h2><span>${activeCount}人</span></div>${state.players.length ? state.players.map((item, index) => memberRow(item, index)).join('') : '<p class="muted">まだ登録されていません。</p>'}</section></section>`;
  document.querySelector('#admin-setup')?.addEventListener('submit', setupAdmin);
  document.querySelector('#admin-login')?.addEventListener('submit', loginAdmin);
  document.querySelector('#admin-logout')?.addEventListener('click', logoutAdmin);
  document.querySelector('#member-form')?.addEventListener('submit', saveMember);
  document.querySelector('#access-pin-form')?.addEventListener('submit', saveAccessPin);
  document.querySelector('#download-backup')?.addEventListener('click', downloadBackup);
  document.querySelector('#restore-file')?.addEventListener('change', previewRestore);
  document.querySelector('#restore-backup')?.addEventListener('click', restoreBackup);
  document.querySelectorAll('[data-save-player]').forEach(button => button.addEventListener('click', savePlayer));
  document.querySelectorAll('[data-toggle-player]').forEach(button => button.addEventListener('click', togglePlayer));
}

function adminPanel() {
  if (!state.adminConfigured) return `<form id="admin-setup" class="panel member-form"><p class="eyebrow">FIRST SETUP</p><h2>管理者PINを設定</h2><p class="admin-help">管理操作に使う4〜12桁の数字を決めてください。</p><label class="field"><span>管理者PIN</span><input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4,12}" minlength="4" maxlength="12" autocomplete="new-password" required></label><button class="button primary" type="submit">PINを設定する</button></form>`;
  if (!state.isAdmin) return `<form id="admin-login" class="panel member-form"><p class="eyebrow">ADMIN</p><h2>管理者ロック</h2><p class="admin-help">メンバーや対局を管理するときだけ解除します。</p><label class="field"><span>管理者PIN</span><input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4,12}" maxlength="12" autocomplete="current-password" required></label><button class="button primary" type="submit">ロックを解除</button></form>`;
  return `<form id="member-form" class="panel member-form"><div class="admin-panel-head"><div><p class="eyebrow">ADMIN</p><h2>新しいメンバー</h2></div><button id="admin-logout" type="button">ロックする</button></div><label class="field"><span>名前</span><input name="name" maxlength="20" placeholder="例：NEET" required></label><button class="button primary" type="submit">登録する</button></form>
    <form id="access-pin-form" class="panel member-form"><p class="eyebrow">GROUP ACCESS</p><h2>共通PIN</h2><p class="admin-help">URLを知っている仲間だけが入れるようにする4〜12桁の数字です。${state.accessConfigured ? '現在は設定済みです。' : ''}</p><label class="field"><span>${state.accessConfigured ? '新しい共通PIN' : '共通PIN'}</span><input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4,12}" minlength="4" maxlength="12" required></label><button class="button secondary" type="submit">${state.accessConfigured ? '共通PINを変更' : '共通PINを設定'}</button></form>
    <section class="panel member-form backup-panel"><p class="eyebrow">BACKUP</p><h2>バックアップ・復元</h2><p class="admin-help">全メンバーと対局をJSONで保存します。PINは含みません。</p><button id="download-backup" class="button secondary" type="button">バックアップを保存</button><label class="file-field"><span>復元するファイル</span><input id="restore-file" type="file" accept="application/json,.json"></label><p id="restore-preview" class="restore-preview">ファイルを選ぶと件数を確認できます。</p><button id="restore-backup" class="button danger" type="button" disabled>この内容で復元</button></section>`;
}

function memberRow(item, index) {
  const status = item.archived ? '<span class="archive-label">非表示</span>' : '';
  if (!state.isAdmin) return `<div class="member-row ${item.archived ? 'archived' : ''}"><i>${index + 1}</i><strong>${esc(item.name)} ${status}</strong><a href="#stats?player=${item.id}">成績を見る</a></div>`;
  return `<div class="member-row admin-member-row ${item.archived ? 'archived' : ''}" data-player="${item.id}"><i>${index + 1}</i><label><span class="sr-only">メンバー名</span><input value="${esc(item.name)}" maxlength="20"></label><div class="member-actions"><button type="button" data-save-player="${item.id}">名前を保存</button><button type="button" data-toggle-player="${item.id}">${item.archived ? '再表示' : '非表示'}</button></div></div>`;
}

async function refreshState() { state = await api('/api/state'); }

async function loginAccess(event) {
  event.preventDefault();
  try { await api('/api/access/login', {method:'POST', body:JSON.stringify({pin:event.currentTarget.pin.value})}); await refreshState(); notify('成績表を開きました。'); route(); }
  catch (error) { notify(error.message, true); }
}

async function setupAdmin(event) {
  event.preventDefault();
  try { await api('/api/admin/setup', {method:'POST', body:JSON.stringify({pin:event.currentTarget.pin.value})}); await refreshState(); notify('管理者PINを設定しました。'); renderMembers(); }
  catch (error) { notify(error.message, true); }
}

async function loginAdmin(event) {
  event.preventDefault();
  try { await api('/api/admin/login', {method:'POST', body:JSON.stringify({pin:event.currentTarget.pin.value})}); await refreshState(); notify('管理者ロックを解除しました。'); route(); }
  catch (error) { notify(error.message, true); }
}

async function logoutAdmin() {
  try { await api('/api/admin/logout', {method:'POST'}); await refreshState(); notify('管理者画面をロックしました。'); route(); }
  catch (error) { notify(error.message, true); }
}

async function saveAccessPin(event) {
  event.preventDefault();
  try { await api('/api/admin/access-pin', {method:'POST', body:JSON.stringify({pin:event.currentTarget.pin.value})}); await refreshState(); notify('共通PINを保存しました。'); renderMembers(); }
  catch (error) { notify(error.message, true); }
}

async function savePlayer(event) {
  const row = event.currentTarget.closest('[data-player]');
  const player = state.players.find(item => item.id === event.currentTarget.dataset.savePlayer);
  try { await api(`/api/players/${player.id}`, {method:'PATCH', body:JSON.stringify({name:row.querySelector('input').value, archived:player.archived})}); await refreshState(); notify('メンバー名を変更しました。'); renderMembers(); }
  catch (error) { notify(error.message, true); }
}

async function togglePlayer(event) {
  const player = state.players.find(item => item.id === event.currentTarget.dataset.togglePlayer);
  try { await api(`/api/players/${player.id}`, {method:'PATCH', body:JSON.stringify({name:player.name, archived:!player.archived})}); await refreshState(); notify(player.archived ? 'メンバーを再表示しました。' : 'メンバーを非表示にしました。'); renderMembers(); }
  catch (error) { notify(error.message, true); }
}

async function saveMember(event) {
  event.preventDefault();
  const form = event.currentTarget, button = form.querySelector('button');
  button.disabled = true;
  try { await api('/api/players', {method:'POST', body:JSON.stringify({name:form.name.value})}); await refreshState(); notify('メンバーを登録しました。'); renderMembers(); document.querySelector('#member-form [name=name]').focus(); }
  catch (error) { notify(error.message, true); button.disabled = false; }
}

async function downloadBackup() {
  try {
    const data = await api('/api/admin/backup');
    const blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'});
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `runteq-mahjong-backup-${new Date().toISOString().slice(0,10)}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
    notify('バックアップを保存しました。');
  } catch (error) { notify(error.message, true); }
}

async function previewRestore(event) {
  const preview = document.querySelector('#restore-preview');
  const button = document.querySelector('#restore-backup');
  restorePayload = null;
  button.disabled = true;
  try {
    const file = event.target.files[0];
    if (!file) return;
    const data = JSON.parse(await file.text());
    if (data.format !== 'runteq-mahjong-backup' || data.version !== 1 || !Array.isArray(data.players) || !Array.isArray(data.games)) throw new Error('このアプリのバックアップファイルではありません。');
    restorePayload = data;
    preview.textContent = `メンバー ${data.players.length}人・対局 ${data.games.length}件で現在のデータを置き換えます。`;
    button.disabled = false;
  } catch (error) { preview.textContent = error.message || 'ファイルを読み込めませんでした。'; notify(preview.textContent, true); }
}

async function restoreBackup() {
  if (!restorePayload || !confirm(`メンバー ${restorePayload.players.length}人・対局 ${restorePayload.games.length}件で現在のデータを置き換えますか？`)) return;
  try { const result = await api('/api/admin/restore', {method:'POST', body:JSON.stringify(restorePayload)}); await refreshState(); restorePayload = null; notify(`${result.players}人・${result.games}件を復元しました。`); renderMembers(); }
  catch (error) { notify(error.message, true); }
}

window.addEventListener('hashchange', route);
try { await refreshState(); route(); }
catch (error) { app.innerHTML = empty('読み込めませんでした', 'サーバーを起動して、ページを読み直してください。'); }
