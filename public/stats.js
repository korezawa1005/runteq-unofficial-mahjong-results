export function summarize(player, games) {
  const entries = games
    .flatMap(game => game.results.map(result => ({...result, played_at: game.played_at, created_at: game.created_at})))
    .filter(result => result.player_id === player.id)
    .sort((a, b) => a.played_at.localeCompare(b.played_at) || a.created_at.localeCompare(b.created_at));
  const ranks = [1, 2, 3, 4].map(rank => entries.filter(entry => entry.rank === rank).length);
  const count = entries.length;
  return {
    player,
    count,
    ranks,
    rates: ranks.map(value => count ? value / count * 100 : 0),
    topRate: count ? ranks[0] / count * 100 : null,
    averageRank: count ? entries.reduce((sum, entry) => sum + entry.rank, 0) / count : null,
    avoidLastRate: count ? (count - ranks[3]) / count * 100 : null,
    rentaiRate: count ? (ranks[0] + ranks[1]) / count * 100 : null,
    avoidBustRate: count ? entries.filter(entry => entry.score >= 0).length / count * 100 : null,
  };
}

export function rankSeries(playerId, games, limit = null) {
  const entries = games
    .flatMap(game => game.results
      .filter(result => result.player_id === playerId)
      .map(result => ({...result, played_at: game.played_at, created_at: game.created_at})))
    .sort((a, b) => a.played_at.localeCompare(b.played_at) || a.created_at.localeCompare(b.created_at));
  const series = entries.map((entry, index) => ({
    game: index + 1,
    date: entry.played_at.slice(0, 10),
    value: entry.rank,
  }));
  return limit ? series.slice(-limit) : series;
}
