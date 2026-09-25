import test from 'node:test';
import assert from 'node:assert/strict';
import {leaderboard, rankSeries, summarize} from '../public/stats.js';

const player = {id: 'a', name: 'A'};
const game = (day, rank, score, created) => ({played_at: day, created_at: created, results: [{player_id: 'a', rank, score}]});

test('calculates all personal statistics', () => {
  const games = [
    game('2026-09-01T10:00', 1, 50000, '1'),
    game('2026-09-01T11:00', 1, 40000, '2'),
    game('2026-09-01T12:00', 3, 20000, '3'),
    game('2026-09-02T10:00', 4, -10000, '4'),
  ];
  const result = summarize(player, games);
  assert.equal(result.count, 4);
  assert.deepEqual(result.ranks, [2, 0, 1, 1]);
  assert.equal(result.averageRank, 2.25);
  assert.equal(result.topRate, 50);
  assert.equal(result.rentaiRate, 50);
  assert.equal(result.avoidLastRate, 75);
  assert.equal(result.avoidBustRate, 75);
});

test('returns the rank of each game in chronological order', () => {
  const games = [
    game('2026-09-01T10:00', 1, 50000, '1'),
    game('2026-09-01T11:00', 3, 20000, '2'),
    game('2026-09-02T10:00', 2, 30000, '3'),
  ];
  assert.deepEqual(rankSeries('a', games).map(item => item.value), [1, 3, 2]);
});

test('limits the rank chart to the latest ten games', () => {
  const games = Array.from({length: 12}, (_, index) => game(`2026-09-${String(index + 1).padStart(2, '0')}T10:00`, index === 0 ? 1 : 3, 25000, String(index)));
  const series = rankSeries('a', games, 10);
  assert.equal(series.length, 10);
  assert.equal(series[0].game, 3);
  assert.equal(series.at(-1).game, 12);
  assert.equal(series.at(-1).value, 3);
});

test('sorts rankings by the selected metric and keeps ties at the same rank', () => {
  const players = ['a', 'b', 'c'].map(id => ({id, name: id.toUpperCase()}));
  const games = [
    {played_at:'2026-09-01T10:00', created_at:'1', results:[
      {player_id:'a', rank:1, score:40000}, {player_id:'b', rank:2, score:30000}, {player_id:'c', rank:3, score:20000},
    ]},
    {played_at:'2026-09-02T10:00', created_at:'2', results:[
      {player_id:'b', rank:1, score:40000}, {player_id:'a', rank:2, score:30000}, {player_id:'c', rank:3, score:20000},
    ]},
  ];
  const average = leaderboard(players, games, 'averageRank');
  assert.deepEqual(average.map(row => row.player.id), ['a', 'b', 'c']);
  assert.deepEqual(average.map(row => row.position), [1, 1, 3]);
  const topRate = leaderboard(players, games, 'topRate');
  assert.deepEqual(topRate.map(row => row.player.id), ['a', 'b', 'c']);
  assert.deepEqual(topRate.map(row => row.position), [1, 1, 3]);
});

test('shows players below the minimum game count as reference records', () => {
  const players = [{id:'a', name:'A'}, {id:'b', name:'B'}];
  const games = [
    {played_at:'2026-09-01T10:00', created_at:'1', results:[{player_id:'a', rank:1, score:40000}, {player_id:'b', rank:2, score:30000}]},
    {played_at:'2026-09-02T10:00', created_at:'2', results:[{player_id:'b', rank:1, score:40000}]},
  ];
  const rows = leaderboard(players, games, 'topRate', 2);
  assert.equal(rows[0].player.id, 'b');
  assert.equal(rows[0].position, 1);
  assert.equal(rows[0].eligible, true);
  assert.equal(rows[1].player.id, 'a');
  assert.equal(rows[1].position, null);
  assert.equal(rows[1].eligible, false);
});
