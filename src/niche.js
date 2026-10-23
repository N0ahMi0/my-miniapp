/**
 * 小众指数计算。
 *
 * 口径：游戏拥有者数量（SteamSpy 区间 + 评论数标定）。
 * - 单款游戏：用快照的 101 个分位点把拥有者数映射成 0-100 的"比多少比例的游戏更冷门"；
 * - 整库：每款游戏等权平均（不用游玩时长加权，避免网游/单机的类型偏差）。
 *
 * 数值口径与偏差说明见页面脚注。
 */
import { nicheScore, ownersFor } from './player-stats.js';

/** 小众指数分档。 */
const RANKS = [
  { min: 85, name: '深渊独行者', desc: '你的库里几乎找不到大众爆款，属于极少数派。' },
  { min: 70, name: '冷门猎手', desc: '小众是你的舒适区，热销榜和你关系不大。' },
  { min: 55, name: '口味偏门', desc: '一半大众一半冷门，挑得很有自己的一套。' },
  { min: 40, name: '有点个性', desc: '主流打底，偶尔夹带私货。' },
  { min: 25, name: '稳健大众', desc: '你玩的游戏大多耳熟能详，踩雷概率低。' },
  { min: 0, name: '国民口味', desc: '你的游戏库基本就是热销榜本身。' },
];

export function rankOf(index) {
  return RANKS.find((rank) => index >= rank.min) ?? RANKS[RANKS.length - 1];
}

/** 拥有者数量的展示格式。 */
export function formatOwners(owners) {
  if (owners >= 10_000_000) return `${(owners / 10_000_000).toFixed(1)} 千万`;
  if (owners >= 10_000) return `${(owners / 10_000).toFixed(1)} 万`;
  return String(Math.round(owners));
}

/**
 * 计算小众指数。
 * @param {Array<{appid: number, name: string, image?: string, playtimeHours: number}>} games
 */
export function computeNicheIndex(games) {
  const scored = games.map((game) => {
    const { owners, estimated } = ownersFor(game.appid);
    return {
      ...game,
      owners,
      ownersText: formatOwners(owners),
      estimated,
      rarity: nicheScore(owners),
    };
  });

  // 每款游戏等权。
  // 曾用时长加权，但时长与游戏类型强相关（网游天然比单机累积得多），
  // 会把小众单机系统性地压低——那是类型偏差，不是口味信号，故弃用。
  const index =
    scored.length > 0
      ? Math.round(scored.reduce((sum, game) => sum + game.rarity, 0) / scored.length)
      : 0;

  const byRarity = [...scored].sort((a, b) => b.rarity - a.rarity || b.playtimeHours - a.playtimeHours);
  const ownersSorted = scored.map((game) => game.owners).sort((a, b) => a - b);
  const medianOwners =
    ownersSorted.length === 0
      ? 0
      : ownersSorted.length % 2 === 1
        ? ownersSorted[(ownersSorted.length - 1) / 2]
        : Math.round((ownersSorted[ownersSorted.length / 2 - 1] + ownersSorted[ownersSorted.length / 2]) / 2);

  return {
    index,
    rank: rankOf(index),
    totalGames: scored.length,
    medianOwners,
    medianOwnersText: formatOwners(medianOwners),
    estimatedCount: scored.filter((game) => game.estimated).length,
    totalHours: Math.round(scored.reduce((sum, game) => sum + game.playtimeHours, 0)),
    niche: byRarity.slice(0, 5),
    mainstream: [...byRarity].reverse()[0] ?? null,
    games: byRarity,
    computedAt: new Date().toISOString(),
  };
}
