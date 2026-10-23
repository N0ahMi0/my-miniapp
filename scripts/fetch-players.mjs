#!/usr/bin/env node
/**
 * 生成"拥有者数量"快照。
 *
 * 数据源：SteamSpy 的 request=all 分页接口（每页 1000 款），60 次请求即可覆盖 6 万款游戏。
 *
 * 为什么不能直接用 owners：
 * SteamSpy 的 owners 只有 13 个固定区间（"0 .. 20,000"、"20,000 .. 50,000" …），
 * 取中点会让 60% 的游戏并列在 141 这个值上，小众分在底部完全饱和。
 *
 * 所以用评论数做区间内标定：
 *   1. 按区间分组，算组内"评论数中位数"；
 *   2. 组系数 = 区间几何中点 ÷ 该中位数；
 *   3. 每款游戏的估计值 = 评论数 × 组系数，再夹回区间上下界内。
 * 这样同一区间里的 4 万款游戏就能按评论数拉开，跨区间仍被区间锚定，不会跑飞。
 *
 * 用法：
 *   node scripts/fetch-players.mjs                 # 抓全量
 *   node scripts/fetch-players.mjs --pages 20      # 限制页数（调试用）
 *   node scripts/fetch-players.mjs --fixture       # 离线生成小样本（不联网）
 *
 * 产物：src/data/players.json
 * 失败时不会覆盖已有快照（先写 .tmp 再原子替换，旧文件留作 players.prev.json）。
 */
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const STEAMSPY_ALL = 'https://steamspy.com/api.php?request=all&page=';

const DEFAULTS = {
  out: 'src/data',
  pages: 70,
  pageDelayMs: 1100,
  timeoutMs: 20_000,
  tries: 3,
};

/**
 * 离线小样本：字段结构与 SteamSpy 响应一致，
 * 目的是让 --fixture 也能跑完整条"区间解析 → 评论数标定"的代码路径。
 * 覆盖了最低区间里评论数差异很大的几款，用来验证并列问题是否被拉开。
 */
const FIXTURE = [
  { appid: 730, owners: '50,000,000 .. 100,000,000', positive: 8_600_000, negative: 1_050_000 },
  { appid: 570, owners: '20,000,000 .. 50,000,000', positive: 2_400_000, negative: 380_000 },
  { appid: 578080, owners: '50,000,000 .. 100,000,000', positive: 2_100_000, negative: 900_000 },
  { appid: 271590, owners: '20,000,000 .. 50,000,000', positive: 1_700_000, negative: 210_000 },
  { appid: 413150, owners: '20,000,000 .. 50,000,000', positive: 780_000, negative: 24_000 },
  { appid: 105600, owners: '20,000,000 .. 50,000,000', positive: 1_100_000, negative: 40_000 },
  { appid: 1086940, owners: '10,000,000 .. 20,000,000', positive: 690_000, negative: 42_000 },
  { appid: 1245620, owners: '10,000,000 .. 20,000,000', positive: 720_000, negative: 96_000 },
  { appid: 292030, owners: '10,000,000 .. 20,000,000', positive: 700_000, negative: 22_000 },
  { appid: 1091500, owners: '10,000,000 .. 20,000,000', positive: 640_000, negative: 120_000 },
  { appid: 252490, owners: '5,000,000 .. 10,000,000', positive: 680_000, negative: 160_000 },
  { appid: 108600, owners: '5,000,000 .. 10,000,000', positive: 320_000, negative: 42_000 },
  { appid: 294100, owners: '2,000,000 .. 5,000,000', positive: 210_000, negative: 14_000 },
  { appid: 526870, owners: '2,000,000 .. 5,000,000', positive: 180_000, negative: 9_000 },
  { appid: 632470, owners: '1,000,000 .. 2,000,000', positive: 96_000, negative: 8_400 },
  { appid: 233860, owners: '1,000,000 .. 2,000,000', positive: 52_000, negative: 3_100 },
  { appid: 457140, owners: '1,000,000 .. 2,000,000', positive: 48_000, negative: 2_600 },
  { appid: 275850, owners: '2,000,000 .. 5,000,000', positive: 240_000, negative: 66_000 },
  { appid: 268910, owners: '5,000,000 .. 10,000,000', positive: 210_000, negative: 8_000 },
  { appid: 391540, owners: '5,000,000 .. 10,000,000', positive: 260_000, negative: 30_000 },
  { appid: 588650, owners: '2,000,000 .. 5,000,000', positive: 160_000, negative: 8_000 },
  { appid: 1145360, owners: '2,000,000 .. 5,000,000', positive: 150_000, negative: 6_000 },
  { appid: 281990, owners: '1,000,000 .. 2,000,000', positive: 88_000, negative: 14_000 },
  { appid: 427520, owners: '1,000,000 .. 2,000,000', positive: 74_000, negative: 2_400 },
  { appid: 289070, owners: '2,000,000 .. 5,000,000', positive: 140_000, negative: 30_000 },
  { appid: 255710, owners: '2,000,000 .. 5,000,000', positive: 130_000, negative: 26_000 },
  { appid: 374320, owners: '2,000,000 .. 5,000,000', positive: 120_000, negative: 18_000 },
  { appid: 814380, owners: '2,000,000 .. 5,000,000', positive: 110_000, negative: 14_000 },
  { appid: 739630, owners: '5,000,000 .. 10,000,000', positive: 400_000, negative: 40_000 },
  { appid: 1966720, owners: '5,000,000 .. 10,000,000', positive: 520_000, negative: 60_000 },
  { appid: 945360, owners: '10,000,000 .. 20,000,000', positive: 480_000, negative: 90_000 },
  { appid: 236390, owners: '10,000,000 .. 20,000,000', positive: 300_000, negative: 120_000 },
  // 最低区间：评论数差异很大，用来验证"并列 141"是否被拉开
  { appid: 966330, owners: '0 .. 20,000', positive: 42, negative: 6 },
  { appid: 1147560, owners: '0 .. 20,000', positive: 15, negative: 2 },
  { appid: 1282730, owners: '0 .. 20,000', positive: 8, negative: 1 },
  { appid: 1637320, owners: '0 .. 20,000', positive: 3, negative: 0 },
  { appid: 1962700, owners: '0 .. 20,000', positive: 1, negative: 0 },
  { appid: 2110110, owners: '0 .. 20,000', positive: 0, negative: 0 },
  { appid: 2325190, owners: '0 .. 20,000', positive: 0, negative: 0 },
  { appid: 2480400, owners: '20,000 .. 50,000', positive: 600, negative: 40 },
  { appid: 2507960, owners: '20,000 .. 50,000', positive: 220, negative: 12 },
  { appid: 2622380, owners: '50,000 .. 100,000', positive: 900, negative: 80 },
];

/* -------------------------------- 参数解析 -------------------------------- */

function parseArgs(argv) {
  const args = { ...DEFAULTS, fixture: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => argv[i + 1];
    switch (flag) {
      case '--out':
        args.out = next();
        i += 1;
        break;
      case '--pages':
        args.pages = Number(next());
        i += 1;
        break;
      case '--fixture':
        args.fixture = true;
        break;
      case '--help':
      case '-h':
        console.log(
          [
            'node scripts/fetch-players.mjs [options]',
            '  --out <dir>      输出目录，默认 src/data',
            '  --pages <n>      SteamSpy 最大页数，默认 70（每页 1000 款）',
            '  --fixture        不联网，生成离线小样本',
          ].join('\n'),
        );
        process.exit(0);
        break;
      default:
        if (flag.startsWith('--')) {
          console.error(`未知参数：${flag}`);
          process.exit(2);
        }
    }
  }
  return args;
}

/* --------------------------------- 工具 ---------------------------------- */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 把 "20,000,000 .. 50,000,000" 解析成上下界。 */
export function parseOwnersRange(text) {
  const match = /([\d,]+)\s*\.\.\s*([\d,]+)/.exec(String(text ?? ''));
  if (!match) return null;
  const low = Number(match[1].replaceAll(',', ''));
  const high = Number(match[2].replaceAll(',', ''));
  if (!Number.isFinite(low) || !Number.isFinite(high) || high <= 0) return null;
  return { low, high };
}

function reviewsOf(entry) {
  const positive = Number(entry?.positive);
  const negative = Number(entry?.negative);
  const total = (Number.isFinite(positive) ? positive : 0) + (Number.isFinite(negative) ? negative : 0);
  return total > 0 ? total : 0;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function fetchJson(url, { timeoutMs, tries }) {
  let lastError;
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { accept: 'application/json', 'user-agent': 'hb-sdk-miniapp-snapshot/1.0' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      // SteamSpy 被 Cloudflare 拦截时返回 HTML，这里提前识别，避免写出空快照。
      if (!text.trimStart().startsWith('{') && !text.trimStart().startsWith('[')) {
        throw new Error(`响应不是 JSON（前 40 字符：${text.slice(0, 40).replace(/\s+/g, ' ')}）`);
      }
      return JSON.parse(text);
    } catch (error) {
      lastError = error;
      if (attempt < tries) await sleep(600 * attempt * attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`${url} 请求失败：${lastError?.message ?? '未知错误'}`);
}

/**
 * 区间内用评论数标定拥有者数。
 * @param {Array<{appid:number, low:number, high:number, reviews:number}>} records
 * @returns {{owners: Map<number, number>, brackets: Array<{low:number, high:number, factor:number, count:number}>}}
 */
export function calibrateOwners(records) {
  /** @type {Map<string, {low:number, high:number, records:Array}>} */
  const groups = new Map();
  for (const record of records) {
    const key = `${record.low}-${record.high}`;
    if (!groups.has(key)) groups.set(key, { low: record.low, high: record.high, records: [] });
    groups.get(key).records.push(record);
  }

  const owners = new Map();
  const brackets = [];

  for (const group of groups.values()) {
    const midpoint = Math.sqrt(Math.max(group.low, 1) * group.high);
    const withReviews = group.records.filter((record) => record.reviews > 0);
    const medianReviews = median(withReviews.map((record) => record.reviews));
    // 评论数中位数缺失或为 0 时退回区间中点，这组内部无法细分。
    const factor = medianReviews > 0 ? midpoint / medianReviews : 0;

    for (const record of group.records) {
      const floor = Math.max(group.low, 1);
      let estimate;
      if (factor > 0 && record.reviews > 0) {
        estimate = record.reviews * factor;
        estimate = Math.min(Math.max(estimate, floor), group.high);
      } else {
        // 没有任何评论：压到区间下界，代表这一档里最冷门的一端。
        estimate = floor;
      }
      owners.set(record.appid, Math.max(1, Math.round(estimate)));
    }

    brackets.push({ low: group.low, high: group.high, factor, count: group.records.length });
  }

  brackets.sort((a, b) => a.low - b.low);
  return { owners, brackets };
}

/** 计算 101 个分位点，客户端用它把拥有者数映射成百分位。 */
function buildQuantiles(values) {
  if (values.length === 0) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const quantiles = [];
  for (let i = 0; i <= 100; i += 1) {
    const pos = Math.floor((i / 100) * (sorted.length - 1));
    quantiles.push(sorted[pos]);
  }
  return quantiles;
}

/* -------------------------------- 数据抓取 -------------------------------- */

async function fetchSteamSpy(args) {
  const records = [];
  let pagesFetched = 0;
  let skipped = 0;

  for (let page = 0; page < args.pages; page += 1) {
    const url = `${STEAMSPY_ALL}${page}`;
    let payload;
    try {
      payload = await fetchJson(url, args);
    } catch (error) {
      console.warn(`  ⚠ 第 ${page} 页失败：${error.message}`);
      if (page === 0) throw error; // 第一页就失败，说明接口整体不可用
      break;
    }

    const entries = Object.values(payload ?? {});
    if (entries.length === 0) {
      console.log(`  第 ${page} 页为空，抓取结束`);
      break;
    }

    for (const entry of entries) {
      const appid = Number(entry?.appid);
      if (!Number.isInteger(appid) || appid <= 0) continue;
      const range = parseOwnersRange(entry?.owners);
      if (!range) {
        skipped += 1;
        continue;
      }
      records.push({ appid, low: range.low, high: range.high, reviews: reviewsOf(entry) });
    }

    pagesFetched += 1;
    if ((page + 1) % 10 === 0 || page === 0) {
      console.log(`  已抓 ${pagesFetched} 页，累计 ${records.length} 款`);
    }
    await sleep(args.pageDelayMs);
  }

  return { records, pagesFetched, skipped };
}

/* -------------------------------- 快照写入 -------------------------------- */

async function writeSnapshot(outDir, payload) {
  await mkdir(outDir, { recursive: true });
  const target = path.join(outDir, 'players.json');
  const previous = path.join(outDir, 'players.prev.json');
  const temp = `${target}.tmp`;

  try {
    await readFile(target);
    await copyFile(target, previous);
  } catch {
    // 首次生成，没有旧文件可备份。
  }

  await writeFile(temp, JSON.stringify(payload), 'utf8');
  await rename(temp, target);
  return target;
}

/* --------------------------------- 主流程 -------------------------------- */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date();
  console.log(`[fetch-players] 开始，模式：${args.fixture ? 'fixture（离线）' : '在线抓取'}`);

  let records;
  let source;
  let pagesFetched = 0;
  let skipped = 0;

  if (args.fixture) {
    records = FIXTURE.map((entry) => {
      const range = parseOwnersRange(entry.owners);
      return { appid: entry.appid, low: range.low, high: range.high, reviews: reviewsOf(entry) };
    });
    source = 'fixture';
    console.log(`  已载入离线样本 ${records.length} 款`);
  } else {
    const spy = await fetchSteamSpy(args);
    records = spy.records;
    pagesFetched = spy.pagesFetched;
    skipped = spy.skipped;
    source = 'steamspy';
    console.log(`  SteamSpy 完成：${records.length} 款 / ${pagesFetched} 页（跳过 ${skipped} 条无区间数据）`);

    if (records.length === 0) {
      throw new Error('SteamSpy 没有返回任何数据，已中止（不会覆盖现有快照）');
    }
  }

  const { owners, brackets } = calibrateOwners(records);
  for (const bracket of brackets) {
    console.log(
      `  区间 ${bracket.low} ~ ${bracket.high}：${bracket.count} 款，系数 ${bracket.factor.toFixed(2)}`,
    );
  }

  // 按 appid 升序写成扁平数组 [appid, owners, appid, owners, ...]，比对象更省体积。
  const entries = [...owners.entries()].sort((a, b) => a[0] - b[0]);
  const data = [];
  for (const [appid, value] of entries) {
    data.push(appid, value);
  }

  const quantiles = buildQuantiles(entries.map(([, value]) => value));
  const distinct = new Set(entries.map(([, value]) => value)).size;

  const payload = {
    generatedAt: startedAt.toISOString(),
    metric: 'owners',
    method: 'review-scaled',
    source,
    fixture: args.fixture,
    count: entries.length,
    pages: pagesFetched,
    skipped,
    distinct,
    quantiles,
    data,
  };

  const target = await writeSnapshot(args.out, payload);
  const bytes = JSON.stringify(payload).length;
  console.log(
    `[fetch-players] 完成：${entries.length} 款，${distinct} 个不同取值，${(bytes / 1024).toFixed(0)} KB → ${target}`,
  );
  console.log(
    `[fetch-players] 分位点：p50=${quantiles[50]}，p90=${quantiles[90]}，p99=${quantiles[99]}`,
  );
}

main().catch((error) => {
  console.error(`[fetch-players] 失败：${error.message}`);
  process.exitCode = 1;
});
