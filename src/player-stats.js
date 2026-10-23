/**
 * 拥有者数快照的读取与打分。
 *
 * 数据来自 src/data/players.json，由 scripts/fetch-players.mjs 生成：
 * - data 是扁平数组 [appid, owners, appid, owners, ...]，比对象更省体积、解析更快；
 * - quantiles 是 101 个分位点，用来把拥有者数映射成"在全部收录游戏中的百分位"。
 *
 * 用百分位而不是写死对数区间，是因为分位数由真实分布决定：
 * 中位数游戏天然是 50 分，不会因为常数拍错而让所有人都是"冷门猎手"。
 */
import snapshot from './data/players.json';

const meta = Object.freeze({
  generatedAt: typeof snapshot?.generatedAt === 'string' ? snapshot.generatedAt : null,
  metric: typeof snapshot?.metric === 'string' ? snapshot.metric : 'owners',
  source: typeof snapshot?.source === 'string' ? snapshot.source : 'none',
  fixture: Boolean(snapshot?.fixture),
  count: Number.isFinite(snapshot?.count) ? snapshot.count : 0,
  quantiles: Array.isArray(snapshot?.quantiles) ? snapshot.quantiles : [],
});

let ownersIndex = null;

function getIndex() {
  if (ownersIndex) return ownersIndex;
  const map = new Map();
  const flat = Array.isArray(snapshot?.data) ? snapshot.data : [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const appid = flat[i];
    const owners = flat[i + 1];
    if (Number.isInteger(appid) && Number.isFinite(owners)) map.set(appid, owners);
  }
  ownersIndex = map;
  return map;
}

/** 快照元信息，用于在页面上标注数据版本。 */
export function snapshotMeta() {
  return meta;
}

function hashAppid(appid) {
  let h = 2166136261;
  const text = String(appid);
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/**
 * 查询某款游戏的拥有者数量。
 * 未收录时给一个确定性的冷门估计值，并标记 estimated=true，由界面提示"估算"。
 */
export function ownersFor(appid) {
  const known = getIndex().get(appid);
  if (typeof known === 'number') return { owners: known, estimated: false };

  const t = (hashAppid(appid) % 1000) / 1000;
  // 对数均匀落在 500 ~ 50000，覆盖"没进快照的冷门游戏"这个合理区间。
  const owners = Math.round(10 ** (Math.log10(500) + t * 2));
  return { owners, estimated: true };
}

/**
 * 拥有者数量 -> 小众分（0-100，越高越冷门）。
 * 用快照的 101 个分位点做百分位映射：比 p90 更冷门就是 90 分以上。
 */
export function nicheScore(owners) {
  const quantiles = meta.quantiles;
  if (quantiles.length === 101) {
    let low = 0;
    let high = 100;
    let found = 100;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (quantiles[mid] >= owners) {
        found = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
    return 100 - found;
  }

  // 没有分位点（快照缺失）时退回对数刻度：1 万 ~ 1 亿映射到 100 ~ 0。
  const MAX_OWNERS = 100_000_000;
  const MIN_OWNERS = 10_000;
  const clamped = Math.min(Math.max(owners, MIN_OWNERS), MAX_OWNERS);
  return Math.round(
    ((Math.log10(MAX_OWNERS) - Math.log10(clamped)) /
      (Math.log10(MAX_OWNERS) - Math.log10(MIN_OWNERS))) *
      100,
  );
}
