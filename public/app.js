import {rankSeries, summarize} from './stats.js';

const app = document.querySelector('#app');
const toast = document.querySelector('#toast');
let state = {players: [], games: [], adminConfigured: false, isAdmin: false};

const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
const number = value => Math.round(value).toLocaleString('ja-JP');
const percent = value => value == null ? '—' : `${value.toFixed(2)}%`;
const rankValue = value => value == null ? '—' : value.toFixed(2);
const localNow = () => {
  const now = new Date(Date.now() - new Date().getTimezoneOffset() * 60000);
  return now.toISOString().slice(0, 16);
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
  const page = location.hash.slice(1) || 'stats';
  document.querySelectorAll('[data-nav]').forEach(link => link.classList.toggle('active', link.dataset.nav === page));
  if (page === 'record') renderRecord();
  else if (page === 'members') renderMembers();
  else renderStats();
}

function empty(title, text, action = '') {
  return `<section class="empty"><div class="empty-icon">四</div><h2>${title}</h2><p>${text}</p>${action}</section>`;
}

function renderStats() {
  if (!state.players.length) {
    app.innerHTML = empty('最初にメンバーを登録しましょう', '4人以上登録すると、半荘の結果を記録できます。', '<a class="button primary" href="#members">メンバーを登録</a>');
    return;
  }
  const selectedId = new URLSearchParams(location.hash.split('?')[1] || '').get('player') || state.players[0].id;
  const player = state.players.find(item => item.id === selectedId) || state.players[0];
  const stats = summarize(player, state.games);
  app.innerHTML = `
    <section class="page-head">
      <div><p class="eyebrow">PERSONAL RECORD</p><h1>個人成績</h1><p>半荘の記録から自動で集計します。</p></div>
      <label class="player-picker"><span>メンバー</span><select id="stats-player">${state.players.map(item => `<option value="${item.id}" ${item.id === player.id ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}</select></label>
    </section>
    ${stats.count ? statsView(stats) : empty(`${esc(player.name)}さんの記録はまだありません`, '半荘の結果を登録すると、ここに成績が表示されます。', '<a class="button primary" href="#record">対局を記録</a>')}
  `;
  document.querySelector('#stats-player').addEventListener('change', event => {
    location.hash = `stats?player=${event.target.value}`;
  });
}

function card(label, value, suffix = '') {
  return `<article class="stat-card"><span>${label}</span><strong>${value}<small>${suffix}</small></strong></article>`;
}

function statsView(stats) {
  const colors = ['#2f7650', '#3274a1', '#b56816', '#b24751'];
  return `
    <section class="stats-grid">
      ${card('ゲーム数', number(stats.count), '回')}
      ${card('トップ回数', number(stats.ranks[0]), '回')}
      ${card('トップ率', percent(stats.topRate))}
      ${card('平均着順', rankValue(stats.averageRank), '位')}
      ${card('ラス回避率', percent(stats.avoidLastRate))}
      ${card('連対率', percent(stats.rentaiRate))}
      ${card('飛び回避率', percent(stats.avoidBustRate))}
    </section>
    ${rankTrend(stats.player)}
    <section class="panel rank-panel">
      <div class="panel-title"><div><p class="eyebrow">RANK DISTRIBUTION</p><h2>着順の内訳</h2></div><span>${stats.count}半荘</span></div>
      <div class="rank-bar" aria-label="着順の割合">${stats.rates.map((rate, i) => rate ? `<span style="width:${rate}%;background:${colors[i]}">${rate >= 9 ? `${rate.toFixed(1)}%` : ''}</span>` : '').join('')}</div>
      <div class="rank-list">${stats.ranks.map((count, i) => `<div><i style="background:${colors[i]}"></i><span>${i + 1}位</span><strong>${count}<small>回</small></strong><em>${stats.rates[i].toFixed(2)}%</em></div>`).join('')}</div>
    </section>`;
}

function rankTrend(player) {
  const series = rankSeries(player.id, state.games, 10);
  const width = 900;
  const height = 280;
  const left = 58;
  const right = 22;
  const top = 20;
  const bottom = 42;
  const chartWidth = width - left - right;
  const chartHeight = height - top - bottom;
  const x = index => series.length === 1 ? left + chartWidth / 2 : left + index / (series.length - 1) * chartWidth;
  const y = value => top + (value - 1) / 3 * chartHeight;
  const points = series.map((item, index) => `${x(index).toFixed(1)},${y(item.value).toFixed(1)}`).join(' ');
  const labelIndexes = [...new Set([0, Math.floor((series.length - 1) / 2), series.length - 1])];
  return `<section class="panel trend-panel">
    <div class="panel-title"><div><p class="eyebrow">RANK TREND</p><h2>着順の推移</h2></div><span>直近${series.length}半荘</span></div>
    <div class="trend-summary"><span>直近の着順</span><strong>${series.at(-1).value}<small>位</small></strong></div>
    <div class="chart-scroll">
      <svg class="trend-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="着順の推移">
        ${[1, 2, 3, 4].map(rank => `<line class="grid-line" x1="${left}" y1="${y(rank)}" x2="${width-right}" y2="${y(rank)}"></line><text class="axis-label" x="${left-10}" y="${y(rank)+4}" text-anchor="end">${rank}位</text>`).join('')}
        <polyline class="trend-line" points="${points}"></polyline>
        ${series.map((item, index) => `<circle class="trend-point" cx="${x(index)}" cy="${y(item.value)}" r="${index === series.length - 1 ? 5 : 3}"><title>${item.date}・${item.game}半荘目：${item.value}位</title></circle>`).join('')}
        ${labelIndexes.map(index => `<text class="axis-label x-label" x="${x(index)}" y="${height-12}" text-anchor="middle">${series[index].game}半荘</text>`).join('')}
      </svg>
    </div>
    <p class="chart-note">直近10半荘で実際に取った着順です。上に近いほど良い成績です。</p>
  </section>`;
}

function renderRecord() {
  const activePlayers = state.players.filter(player => !player.archived);
  if (activePlayers.length < 4) {
    const action = state.isAdmin ? '<a class="button primary" href="#members">メンバーを登録</a>' : '<a class="button primary" href="#members">管理者ロックを解除</a>';
    app.innerHTML = empty('メンバーが4人必要です', `現在は${activePlayers.length}人です。あと${4 - activePlayers.length}人登録してください。`, action);
    return;
  }
  const initial = activePlayers.slice(0, 4);
  app.innerHTML = `
    <section class="page-head"><div><p class="eyebrow">NEW GAME</p><h1>対局を記録</h1><p>四人麻雀・半荘の終了結果を入力します。</p></div></section>
    <form id="game-form" class="panel form-panel">
      <label class="field date-field"><span>対局日時</span><input type="datetime-local" name="played_at" value="${localNow()}" required></label>
      <div class="result-table">
        <div class="result-heading"><span>順位</span><span>メンバー</span><span>終了時点数</span></div>
        ${[1,2,3,4].map((rank, index) => `<div class="result-row">
          <div class="rank-badge rank-${rank}">${rank}<small>位</small></div>
          <label><span class="mobile-label">メンバー</span><select name="player" required>${activePlayers.map(item => `<option value="${item.id}" ${item.id === initial[index]?.id ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}</select></label>
          <label class="score-input"><span class="mobile-label">終了時点数</span><input name="score" type="number" step="100" value="${[40000,30000,20000,10000][index]}" required><b>点</b></label>
          <input type="hidden" name="rank" value="${rank}">
        </div>`).join('')}
      </div>
      <p id="player-error" class="form-error" role="alert" hidden>同じメンバーを重複して選択できません。</p>
      <div class="score-total">点数合計 <strong id="score-total">100,000点</strong><span>（100,000点にしてください）</span></div>
      <button class="button primary submit" type="submit">この結果を記録</button>
    </form>
    ${historyView()}`;
  const form = document.querySelector('#game-form');
  const playerSelects = [...form.querySelectorAll('[name=player]')];
  const submitButton = form.querySelector('[type=submit]');
  const updatePlayerOptions = () => {
    const selected = playerSelects.map(select => select.value);
    const duplicated = new Set(selected).size !== selected.length;
    playerSelects.forEach(select => {
      [...select.options].forEach(option => {
        option.disabled = option.value !== select.value && selected.includes(option.value);
      });
      select.setCustomValidity(duplicated ? '同じメンバーを重複して選択できません。' : '');
    });
    document.querySelector('#player-error').hidden = !duplicated;
    submitButton.disabled = duplicated;
  };
  const updateTotal = () => {
    const total = [...form.querySelectorAll('[name=score]')].reduce((sum, input) => sum + Number(input.value || 0), 0);
    const output = document.querySelector('#score-total');
    output.textContent = `${total.toLocaleString('ja-JP')}点`;
    output.classList.toggle('invalid', total !== 100000);
  };
  playerSelects.forEach(select => select.addEventListener('change', updatePlayerOptions));
  updatePlayerOptions();
  form.addEventListener('input', updateTotal);
  form.addEventListener('submit', saveGame);
  document.querySelectorAll('[data-delete]').forEach(button => button.addEventListener('click', deleteGame));
}

function historyView() {
  if (!state.games.length) return '';
  return `<section class="history"><div class="panel-title"><div><p class="eyebrow">RECENT GAMES</p><h2>最近の対局</h2></div></div>${state.games.slice(0, 10).map(game => `<article class="game-row"><time>${new Date(game.played_at).toLocaleString('ja-JP', {year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</time><div>${game.results.sort((a,b) => a.rank-b.rank).map(result => `<span><b>${result.rank}位</b> ${esc(result.name)} <em>${number(result.score)}点</em></span>`).join('')}</div>${state.isAdmin ? `<button type="button" data-delete="${game.id}">削除</button>` : ''}</article>`).join('')}</section>`;
}

async function saveGame(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const players = [...form.querySelectorAll('[name=player]')];
  const scores = [...form.querySelectorAll('[name=score]')];
  const button = form.querySelector('[type=submit]');
  button.disabled = true;
  try {
    await api('/api/games', {method: 'POST', body: JSON.stringify({
      played_at: form.played_at.value,
      results: players.map((input, index) => ({player_id: input.value, rank: index + 1, score: Number(scores[index].value)})),
    })});
    state = await api('/api/state');
    notify('対局結果を記録しました。');
    location.hash = `stats?player=${players[0].value}`;
  } catch (error) {
    notify(error.message, true);
    button.disabled = false;
  }
}

async function deleteGame(event) {
  if (!confirm('この対局記録を削除しますか？')) return;
  try {
    await api(`/api/games/${event.currentTarget.dataset.delete}`, {method: 'DELETE'});
    state = await api('/api/state');
    notify('対局記録を削除しました。');
    renderRecord();
  } catch (error) { notify(error.message, true); }
}

function renderMembers() {
  const activeCount = state.players.filter(player => !player.archived).length;
  app.innerHTML = `
    <section class="page-head"><div><p class="eyebrow">PLAYERS</p><h1>メンバー</h1><p>登録メンバーを確認します。</p></div><span class="admin-status ${state.isAdmin ? 'unlocked' : ''}">${state.isAdmin ? '管理者モード' : '一般モード'}</span></section>
    <section class="member-layout">
      <div class="admin-column">${adminPanel()}</div>
      <section class="panel member-list"><div class="panel-title"><h2>登録メンバー</h2><span>${activeCount}人</span></div>${state.players.length ? state.players.map((item, index) => memberRow(item, index)).join('') : '<p class="muted">まだ登録されていません。</p>'}</section>
    </section>`;
  document.querySelector('#admin-setup')?.addEventListener('submit', setupAdmin);
  document.querySelector('#admin-login')?.addEventListener('submit', loginAdmin);
  document.querySelector('#admin-logout')?.addEventListener('click', logoutAdmin);
  document.querySelector('#member-form')?.addEventListener('submit', saveMember);
  document.querySelectorAll('[data-save-player]').forEach(button => button.addEventListener('click', savePlayer));
  document.querySelectorAll('[data-toggle-player]').forEach(button => button.addEventListener('click', togglePlayer));
}

function adminPanel() {
  if (!state.adminConfigured) return `<form id="admin-setup" class="panel member-form"><p class="eyebrow">FIRST SETUP</p><h2>管理者PINを設定</h2><p class="admin-help">管理操作に使う4〜12桁の数字を決めてください。</p><label class="field"><span>管理者PIN</span><input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4,12}" minlength="4" maxlength="12" autocomplete="new-password" required></label><button class="button primary" type="submit">PINを設定する</button></form>`;
  if (!state.isAdmin) return `<form id="admin-login" class="panel member-form"><p class="eyebrow">ADMIN</p><h2>管理者ロック</h2><p class="admin-help">メンバーを管理するときだけ解除します。</p><label class="field"><span>管理者PIN</span><input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4,12}" maxlength="12" autocomplete="current-password" required></label><button class="button primary" type="submit">ロックを解除</button></form>`;
  return `<form id="member-form" class="panel member-form"><div class="admin-panel-head"><div><p class="eyebrow">ADMIN</p><h2>新しいメンバー</h2></div><button id="admin-logout" type="button">ロックする</button></div><label class="field"><span>名前</span><input name="name" maxlength="20" placeholder="例：NEET" required></label><button class="button primary" type="submit">登録する</button></form>`;
}

function memberRow(item, index) {
  const status = item.archived ? '<span class="archive-label">非表示</span>' : '';
  if (!state.isAdmin) return `<div class="member-row ${item.archived ? 'archived' : ''}"><i>${index + 1}</i><strong>${esc(item.name)} ${status}</strong><a href="#stats?player=${item.id}">成績を見る</a></div>`;
  return `<div class="member-row admin-member-row ${item.archived ? 'archived' : ''}" data-player="${item.id}"><i>${index + 1}</i><label><span class="sr-only">メンバー名</span><input value="${esc(item.name)}" maxlength="20"></label><div class="member-actions"><button type="button" data-save-player="${item.id}">名前を保存</button><button type="button" data-toggle-player="${item.id}">${item.archived ? '再表示' : '非表示'}</button></div></div>`;
}

async function refreshState() {
  state = await api('/api/state');
}

async function setupAdmin(event) {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await api('/api/admin/setup', {method: 'POST', body: JSON.stringify({pin: form.pin.value})});
    await refreshState();
    notify('管理者PINを設定しました。');
    renderMembers();
  } catch (error) { notify(error.message, true); }
}

async function loginAdmin(event) {
  event.preventDefault();
  try {
    await api('/api/admin/login', {method: 'POST', body: JSON.stringify({pin: event.currentTarget.pin.value})});
    await refreshState();
    notify('管理者ロックを解除しました。');
    renderMembers();
  } catch (error) { notify(error.message, true); }
}

async function logoutAdmin() {
  try {
    await api('/api/admin/logout', {method: 'POST'});
    await refreshState();
    notify('管理者画面をロックしました。');
    renderMembers();
  } catch (error) { notify(error.message, true); }
}

async function savePlayer(event) {
  const row = event.currentTarget.closest('[data-player]');
  const player = state.players.find(item => item.id === event.currentTarget.dataset.savePlayer);
  try {
    await api(`/api/players/${player.id}`, {method: 'PATCH', body: JSON.stringify({name: row.querySelector('input').value, archived: player.archived})});
    await refreshState();
    notify('メンバー名を変更しました。');
    renderMembers();
  } catch (error) { notify(error.message, true); }
}

async function togglePlayer(event) {
  const player = state.players.find(item => item.id === event.currentTarget.dataset.togglePlayer);
  try {
    await api(`/api/players/${player.id}`, {method: 'PATCH', body: JSON.stringify({name: player.name, archived: !player.archived})});
    await refreshState();
    notify(player.archived ? 'メンバーを再表示しました。' : 'メンバーを非表示にしました。');
    renderMembers();
  } catch (error) { notify(error.message, true); }
}

async function saveMember(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    await api('/api/players', {method: 'POST', body: JSON.stringify({name: form.name.value})});
    state = await api('/api/state');
    notify('メンバーを登録しました。');
    renderMembers();
    document.querySelector('#member-form [name=name]').focus();
  } catch (error) {
    notify(error.message, true);
    button.disabled = false;
  }
}

window.addEventListener('hashchange', route);
try {
  state = await api('/api/state');
  route();
} catch (error) {
  app.innerHTML = empty('読み込めませんでした', 'サーバーを起動して、ページを読み直してください。');
}
