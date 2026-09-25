class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const encoder = new TextEncoder();
const SESSION_SECONDS = 60 * 60 * 24 * 30;

const bytesToHex = bytes => [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
const hexToBytes = hex => new Uint8Array(hex.match(/.{2}/g)?.map(value => parseInt(value, 16)) || []);
const timingSafeEqual = (left, right) => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
};
const now = () => new Date().toISOString();
const unixTime = () => Math.floor(Date.now() / 1000);
const uid = () => bytesToHex(crypto.getRandomValues(new Uint8Array(12)));

function parseCookies(request) {
  return Object.fromEntries((request.headers.get('Cookie') || '').split(';').map(part => part.trim().split('=').map(decodeURIComponent)).filter(parts => parts.length === 2));
}

function sessionCookie(request, name, value, maximum = SESSION_SECONDS) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maximum}${secure}`;
}

function json(status, body, responseCookies = []) {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  responseCookies.forEach(cookie => headers.append('Set-Cookie', cookie));
  return new Response(JSON.stringify(body), {status, headers});
}

async function readJson(request, maximum = 100_000) {
  if ((request.headers.get('Content-Type') || '').split(';')[0] !== 'application/json') throw new AppError(415, 'データ形式が正しくありません。');
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > maximum) throw new AppError(400, 'データが大きすぎます。');
  const text = await request.text();
  if (text.length > maximum) throw new AppError(400, 'データが大きすぎます。');
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new AppError(400, 'データを読み込めませんでした。');
  }
}

async function pinHash(pin, label = '管理者PIN', saltHex = null) {
  if (typeof pin !== 'string' || !/^[0-9]{4,12}$/.test(pin)) throw new AppError(400, `${label}は4〜12桁の数字で入力してください。`);
  const salt = saltHex ? hexToBytes(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', encoder.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const digest = await crypto.subtle.deriveBits({name:'PBKDF2', hash:'SHA-256', salt, iterations:100_000}, key, 256);
  return `${bytesToHex(salt)}:${bytesToHex(digest)}`;
}

async function verifyPin(pin, stored) {
  try {
    const [salt, expected] = stored.split(':', 2);
    const actual = (await pinHash(pin, 'PIN', salt)).split(':', 2)[1];
    return timingSafeEqual(hexToBytes(actual), hexToBytes(expected));
  } catch {
    return false;
  }
}

async function tokenHash(token) {
  return bytesToHex(await crypto.subtle.digest('SHA-256', encoder.encode(token)));
}

async function setting(db, key) {
  return await db.prepare('SELECT value FROM settings WHERE key=?').bind(key).first('value');
}

async function hasSession(db, table, token) {
  if (!token) return false;
  const row = await db.prepare(`SELECT 1 AS found FROM ${table} WHERE token=? AND expires>?`).bind(await tokenHash(token), unixTime()).first();
  return Boolean(row);
}

async function authState(request, db) {
  const cookies = parseCookies(request);
  const [adminPin, accessPin] = await Promise.all([setting(db, 'admin_pin'), setting(db, 'access_pin')]);
  const isAdmin = await hasSession(db, 'admin_sessions', cookies.hanchan_admin);
  const hasAccess = !accessPin || isAdmin || await hasSession(db, 'access_sessions', cookies.hanchan_access);
  return {adminConfigured:Boolean(adminPin), accessConfigured:Boolean(accessPin), isAdmin, hasAccess};
}

function requireAdmin(auth) {
  if (!auth.isAdmin) throw new AppError(403, '管理者PINでロックを解除してください。');
}

function requireAccess(auth) {
  if (!auth.hasAccess) throw new AppError(401, '共通PINを入力してください。');
}

async function createSession(db, table) {
  const token = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  const expires = unixTime() + SESSION_SECONDS;
  await db.batch([
    db.prepare(`DELETE FROM ${table} WHERE expires<=?`).bind(unixTime()),
    db.prepare(`INSERT INTO ${table}(token,expires) VALUES(?,?)`).bind(await tokenHash(token), expires),
  ]);
  return token;
}

async function recordAttempt(request, db, table) {
  const timestamp = unixTime();
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const row = await db.prepare(`SELECT count,reset_at FROM ${table} WHERE ip=?`).bind(ip).first();
  if (row && row.reset_at > timestamp && row.count >= 10) throw new AppError(429, 'PINの入力回数が多いため、1分後にお試しください。');
  const count = row && row.reset_at > timestamp ? row.count + 1 : 1;
  await db.prepare(`INSERT INTO ${table}(ip,count,reset_at) VALUES(?,?,?) ON CONFLICT(ip) DO UPDATE SET count=excluded.count,reset_at=excluded.reset_at`).bind(ip, count, timestamp + 60).run();
  return ip;
}

async function loadState(db) {
  const [playerQuery, resultQuery] = await Promise.all([
    db.prepare('SELECT id,name,created_at,archived FROM players ORDER BY archived,created_at,id').all(),
    db.prepare(`SELECT g.id,g.played_at,g.created_at,r.player_id,r.rank,r.score,p.name
      FROM games g JOIN results r ON r.game_id=g.id JOIN players p ON p.id=r.player_id
      ORDER BY g.played_at DESC,g.created_at DESC,r.rank`).all(),
  ]);
  const players = playerQuery.results.map(player => ({...player, archived:Boolean(player.archived)}));
  const games = [];
  for (const row of resultQuery.results) {
    if (!games.length || games.at(-1).id !== row.id) games.push({id:row.id, played_at:row.played_at, created_at:row.created_at, results:[]});
    games.at(-1).results.push({player_id:row.player_id, name:row.name, rank:row.rank, score:row.score});
  }
  return {players, games};
}

function validatePlayedAt(value) {
  const year = Number(String(value || '').slice(0, 4));
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) || !Number.isFinite(Date.parse(value)) || year < 1900 || year > 2200) throw new AppError(400, '対局日時を正しく入力してください。');
  return value;
}

async function validateResults(db, results, allowArchived = false) {
  if (!Array.isArray(results) || results.length !== 4 || results.some(item => !item || typeof item !== 'object' || Array.isArray(item))) throw new AppError(400, '4人分の結果を入力してください。');
  const playerIds = results.map(item => item.player_id);
  const ranks = results.map(item => item.rank);
  const scores = results.map(item => item.score);
  if (new Set(playerIds).size !== 4) throw new AppError(400, '同じメンバーを重複して選択できません。');
  const query = allowArchived ? 'SELECT id FROM players' : 'SELECT id FROM players WHERE archived=0';
  const known = new Set((await db.prepare(query).all()).results.map(row => row.id));
  if (playerIds.some(id => typeof id !== 'string' || !known.has(id))) throw new AppError(400, '登録済みのメンバーを4人選んでください。');
  if (ranks.some(rank => !Number.isInteger(rank)) || [...ranks].sort().join(',') !== '1,2,3,4') throw new AppError(400, '順位は1位から4位を1人ずつ選んでください。');
  if (scores.some(score => !Number.isInteger(score) || score < -1_000_000 || score > 1_000_000 || score % 100)) throw new AppError(400, '点数は100点単位で入力してください。');
  const total = scores.reduce((sum, score) => sum + score, 0);
  if (total !== 100_000) throw new AppError(400, `4人の点数合計を100,000点にしてください（現在 ${total.toLocaleString('ja-JP')}点）。`);
  const ordered = [...results].sort((a, b) => a.rank - b.rank);
  if (ordered.some((item, index) => index < 3 && item.score < ordered[index + 1].score)) throw new AppError(400, '点数と順位が一致していません。高い点数の人を上位にしてください。');
  return results.map(item => [item.player_id, item.rank, item.score]);
}

async function backupData(db) {
  const [playerQuery, gameQuery, resultQuery] = await Promise.all([
    db.prepare('SELECT id,name,created_at,archived FROM players ORDER BY created_at,id').all(),
    db.prepare('SELECT id,played_at,created_at FROM games ORDER BY played_at,created_at').all(),
    db.prepare('SELECT game_id,player_id,rank,score FROM results ORDER BY game_id,rank').all(),
  ]);
  const grouped = new Map();
  resultQuery.results.forEach(row => {
    if (!grouped.has(row.game_id)) grouped.set(row.game_id, []);
    grouped.get(row.game_id).push({player_id:row.player_id, rank:row.rank, score:row.score});
  });
  return {
    format:'runteq-mahjong-backup', version:1, exported_at:now(),
    players:playerQuery.results,
    games:gameQuery.results.map(game => ({...game, results:grouped.get(game.id) || []})),
  };
}

function validateBackup(payload) {
  if (payload.format !== 'runteq-mahjong-backup' || payload.version !== 1) throw new AppError(400, 'このアプリのバックアップファイルではありません。');
  if (!Array.isArray(payload.players) || !Array.isArray(payload.games) || payload.players.length > 10_000 || payload.games.length > 100_000) throw new AppError(400, 'バックアップの内容が正しくありません。');
  const ids = new Set(), names = new Set(), players = [];
  for (const player of payload.players) {
    const archived = player?.archived ?? 0;
    if (!player || typeof player.id !== 'string' || !player.id || ids.has(player.id) || typeof player.name !== 'string' || !player.name.trim() || player.name.trim().length > 20 || names.has(player.name.trim()) || typeof player.created_at !== 'string' || ![0, 1, false, true].includes(archived)) throw new AppError(400, 'メンバーデータが正しくありません。');
    ids.add(player.id); names.add(player.name.trim());
    players.push([player.id, player.name.trim(), player.created_at, Number(Boolean(archived))]);
  }
  const gameIds = new Set(), games = [];
  for (const game of payload.games) {
    if (!game || typeof game.id !== 'string' || !game.id || gameIds.has(game.id) || typeof game.created_at !== 'string') throw new AppError(400, '対局データが正しくありません。');
    validatePlayedAt(game.played_at);
    if (!Array.isArray(game.results) || game.results.length !== 4) throw new AppError(400, '対局結果が正しくありません。');
    const resultIds = game.results.map(item => item?.player_id);
    const ranks = game.results.map(item => item?.rank);
    const scores = game.results.map(item => item?.score);
    if (new Set(resultIds).size !== 4 || resultIds.some(id => !ids.has(id)) || ranks.some(rank => !Number.isInteger(rank)) || [...ranks].sort().join(',') !== '1,2,3,4') throw new AppError(400, '対局結果が正しくありません。');
    if (scores.some(score => !Number.isInteger(score) || score % 100 || score < -1_000_000 || score > 1_000_000) || scores.reduce((sum, score) => sum + score, 0) !== 100_000) throw new AppError(400, '対局結果の点数が正しくありません。');
    const ordered = [...game.results].sort((a, b) => a.rank - b.rank);
    if (ordered.some((item, index) => index < 3 && item.score < ordered[index + 1].score)) throw new AppError(400, '対局結果の点数と順位が一致していません。');
    gameIds.add(game.id);
    games.push([game.id, game.played_at, game.created_at, game.results.map(item => [item.player_id, item.rank, item.score])]);
  }
  return {players, games};
}

function chunkInsert(db, table, columns, rows, size = 20) {
  const statements = [];
  for (let index = 0; index < rows.length; index += size) {
    const chunk = rows.slice(index, index + size);
    const placeholders = chunk.map(() => `(${columns.map(() => '?').join(',')})`).join(',');
    statements.push(db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES ${placeholders}`).bind(...chunk.flat()));
  }
  return statements;
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const auth = await authState(request, env.DB);

  if (path === '/api/state' && method === 'GET') {
    const payload = auth.hasAccess ? await loadState(env.DB) : {players:[], games:[]};
    return json(200, {...payload, ...auth});
  }
  if (method !== 'GET' && request.headers.get('X-Requested-With') !== 'HanchanRecord') throw new AppError(403, 'アプリの画面から操作してください。');

  if (path === '/api/access/login' && method === 'POST') {
    const stored = await setting(env.DB, 'access_pin');
    if (!stored) throw new AppError(409, '共通PINはまだ設定されていません。');
    const ip = await recordAttempt(request, env.DB, 'access_attempts');
    const body = await readJson(request);
    if (!await verifyPin(body.pin, stored)) throw new AppError(401, '共通PINが違います。');
    await env.DB.prepare('DELETE FROM access_attempts WHERE ip=?').bind(ip).run();
    const token = await createSession(env.DB, 'access_sessions');
    return json(200, {ok:true}, [sessionCookie(request, 'hanchan_access', token)]);
  }
  if (path === '/api/admin/setup' && method === 'POST') {
    if (auth.adminConfigured) throw new AppError(409, '管理者PINは設定済みです。');
    const body = await readJson(request);
    await env.DB.prepare("INSERT INTO settings(key,value) VALUES('admin_pin',?)").bind(await pinHash(body.pin)).run();
    const token = await createSession(env.DB, 'admin_sessions');
    return json(201, {ok:true}, [sessionCookie(request, 'hanchan_admin', token)]);
  }
  if (path === '/api/admin/login' && method === 'POST') {
    const stored = await setting(env.DB, 'admin_pin');
    if (!stored) throw new AppError(409, '先に管理者PINを設定してください。');
    const ip = await recordAttempt(request, env.DB, 'admin_attempts');
    const body = await readJson(request);
    if (!await verifyPin(body.pin, stored)) throw new AppError(401, '管理者PINが違います。');
    await env.DB.prepare('DELETE FROM admin_attempts WHERE ip=?').bind(ip).run();
    const token = await createSession(env.DB, 'admin_sessions');
    return json(200, {ok:true}, [sessionCookie(request, 'hanchan_admin', token)]);
  }
  if (path === '/api/admin/logout' && method === 'POST') {
    const token = parseCookies(request).hanchan_admin;
    if (token) await env.DB.prepare('DELETE FROM admin_sessions WHERE token=?').bind(await tokenHash(token)).run();
    return json(200, {ok:true}, [sessionCookie(request, 'hanchan_admin', '', 0)]);
  }
  if (path === '/api/admin/access-pin' && method === 'POST') {
    requireAdmin(auth);
    const body = await readJson(request);
    const hashed = await pinHash(body.pin, '共通PIN');
    const token = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    await env.DB.batch([
      env.DB.prepare("INSERT INTO settings(key,value) VALUES('access_pin',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(hashed),
      env.DB.prepare('DELETE FROM access_sessions'),
      env.DB.prepare('INSERT INTO access_sessions(token,expires) VALUES(?,?)').bind(await tokenHash(token), unixTime() + SESSION_SECONDS),
    ]);
    return json(200, {ok:true}, [sessionCookie(request, 'hanchan_access', token)]);
  }
  if (path === '/api/admin/change-pin' && method === 'POST') {
    requireAdmin(auth);
    const body = await readJson(request);
    const hashed = await pinHash(body.pin);
    const token = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    await env.DB.batch([
      env.DB.prepare("UPDATE settings SET value=? WHERE key='admin_pin'").bind(hashed),
      env.DB.prepare('DELETE FROM admin_sessions'),
      env.DB.prepare('INSERT INTO admin_sessions(token,expires) VALUES(?,?)').bind(await tokenHash(token), unixTime() + SESSION_SECONDS),
    ]);
    return json(200, {ok:true}, [sessionCookie(request, 'hanchan_admin', token)]);
  }

  requireAccess(auth);
  if (path === '/api/players' && method === 'POST') {
    requireAdmin(auth);
    const body = await readJson(request);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 20) throw new AppError(400, '名前は1〜20文字で入力してください。');
    const player = {id:uid(), name, created_at:now(), archived:false};
    try { await env.DB.prepare('INSERT INTO players(id,name,created_at,archived) VALUES(?,?,?,0)').bind(player.id, name, player.created_at).run(); }
    catch (error) { if (String(error).includes('UNIQUE')) throw new AppError(409, '同じ名前のメンバーが登録されています。'); throw error; }
    return json(201, player);
  }
  if (path.startsWith('/api/players/') && method === 'PATCH') {
    requireAdmin(auth);
    const id = path.slice('/api/players/'.length);
    const current = await env.DB.prepare('SELECT * FROM players WHERE id=?').bind(id).first();
    if (!current) throw new AppError(404, 'メンバーが見つかりません。');
    const body = await readJson(request);
    const name = typeof body.name === 'string' ? body.name.trim() : current.name;
    const archived = body.archived ?? Boolean(current.archived);
    if (!name || name.length > 20) throw new AppError(400, '名前は1〜20文字で入力してください。');
    if (typeof archived !== 'boolean') throw new AppError(400, 'メンバーの状態が正しくありません。');
    try { await env.DB.prepare('UPDATE players SET name=?,archived=? WHERE id=?').bind(name, Number(archived), id).run(); }
    catch (error) { if (String(error).includes('UNIQUE')) throw new AppError(409, '同じ名前のメンバーが登録されています。'); throw error; }
    return json(200, {ok:true});
  }
  if (path === '/api/games' && method === 'POST') {
    requireAdmin(auth);
    const body = await readJson(request);
    const playedAt = validatePlayedAt(body.played_at);
    const rows = await validateResults(env.DB, body.results);
    const gameId = uid(), createdAt = now();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO games(id,played_at,created_at) VALUES(?,?,?)').bind(gameId, playedAt, createdAt),
      ...rows.map(row => env.DB.prepare('INSERT INTO results(game_id,player_id,rank,score) VALUES(?,?,?,?)').bind(gameId, ...row)),
    ]);
    return json(201, {id:gameId});
  }
  if (path.startsWith('/api/games/') && method === 'PATCH') {
    requireAdmin(auth);
    const id = path.slice('/api/games/'.length);
    if (!await env.DB.prepare('SELECT 1 AS found FROM games WHERE id=?').bind(id).first()) throw new AppError(404, '対局が見つかりません。');
    const body = await readJson(request);
    const playedAt = validatePlayedAt(body.played_at);
    const rows = await validateResults(env.DB, body.results, true);
    await env.DB.batch([
      env.DB.prepare('UPDATE games SET played_at=? WHERE id=?').bind(playedAt, id),
      env.DB.prepare('DELETE FROM results WHERE game_id=?').bind(id),
      ...rows.map(row => env.DB.prepare('INSERT INTO results(game_id,player_id,rank,score) VALUES(?,?,?,?)').bind(id, ...row)),
    ]);
    return json(200, {ok:true});
  }
  if (path.startsWith('/api/games/') && method === 'DELETE') {
    requireAdmin(auth);
    const id = path.slice('/api/games/'.length);
    const result = await env.DB.prepare('DELETE FROM games WHERE id=?').bind(id).run();
    if (!result.meta.changes) throw new AppError(404, '対局が見つかりません。');
    return json(200, {ok:true});
  }
  if (path === '/api/admin/backup' && method === 'GET') {
    requireAdmin(auth);
    return json(200, await backupData(env.DB));
  }
  if (path === '/api/admin/restore' && method === 'POST') {
    requireAdmin(auth);
    const payload = await readJson(request, 20_000_000);
    const {players, games} = validateBackup(payload);
    const gameRows = games.map(([id, playedAt, createdAt]) => [id, playedAt, createdAt]);
    const resultRows = games.flatMap(([id, , , results]) => results.map(row => [id, ...row]));
    const statements = [
      env.DB.prepare('DELETE FROM results'), env.DB.prepare('DELETE FROM games'), env.DB.prepare('DELETE FROM players'),
      ...chunkInsert(env.DB, 'players', ['id','name','created_at','archived'], players),
      ...chunkInsert(env.DB, 'games', ['id','played_at','created_at'], gameRows),
      ...chunkInsert(env.DB, 'results', ['game_id','player_id','rank','score'], resultRows),
    ];
    await env.DB.batch(statements);
    return json(200, {ok:true, players:players.length, games:games.length});
  }
  throw new AppError(404, 'ページが見つかりません。');
}

export default {
  async fetch(request, env) {
    try {
      if (!new URL(request.url).pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
      return await handleApi(request, env);
    } catch (error) {
      if (error instanceof AppError) return json(error.status, {error:error.message});
      console.error(error);
      return json(500, {error:'処理できませんでした。'});
    }
  },
};
