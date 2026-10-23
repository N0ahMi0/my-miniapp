#!/usr/bin/env node
/**
 * 生成"拥有者数量"快照。
 *
 * 数据源：SteamSpy 的 request=all 分页接口（每页 1000 款），60 次请求即可覆盖 6 万款游戏。
 *
 * 关于口径：Valve 官方没有任何"拥有者数量"接口，SteamSpy 是目前最常用的第三方估算，
 * 它给的是区间（例如 "20,000,000 .. 50,000,000"）。这里取**几何中点**作为代表值：
 * 拥有者分布跨越 5 个数量级，几何中点比算术中点更贴近"量级中心"，
 * 例如 2 万~5 万取到 31623，而不是 35000。
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

/** 离线小样本：用于在无法访问 Steam 的机器上跑通构建链路。数值为估算量级，不是真实统计。 */
const FIXTURE = [
  [730, 60_000_000],
  [570, 45_000_000],
  [578080, 60_000_000],
  [271590, 50_000_000],
  [105600, 45_000_000],
  [413150, 40_000_000],
  [550, 40_000_000],
  [440, 50_000_000],
  [945360, 30_000_000],
  [292030, 30_000_000],
  [1091500, 25_000_000],
  [1245620, 25_000_000],
  [236390, 25_000_000],
  [230410, 25_000_000],
  [1174180, 20_000_000],
  [489830, 20_000_000],
  [620, 20_000_000],
  [359550, 20_000_000],
  [1086940, 20_000_000],
  [2358720, 20_000_000],
  [220, 20_000_000],
  [252490, 15_000_000],
  [238960, 15_000_000],
  [322330, 15_000_000],
  [251570, 15_000_000],
  [739630, 15_000_000],
  [892970, 15_000_000],
  [377160, 12_000_000],
  [400, 12_000_000],
  [255710, 12_000_000],
  [374320, 12_000_000],
  [1966720, 12_000_000],
  [108600, 10_000_000],
  [289070, 10_000_000],
  [814380, 10_000_000],
  [391540, 10_000_000],
  [1145360, 8_000_000],
  [588650, 8_000_000],
  [275850, 8_000_000],
  [268910, 8_000_000],
  [435150, 6_000_000],
  [294100, 6_000_000],
  [281990, 5_000_000],
  [427520, 5_000_000],
  [457140, 4_000_000],
  [526870, 4_000_000],
  [632470, 4_000_000],
  [233860, 1_500_000],
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

/**
 * 把 SteamSpy 的拥有者区间解析成代表值。
 * 例："20,000,000 .. 50,000,000" -> 31622777（几何中点）
 * 解析失败返回 null，由调用方跳过该条。
 */
export function parseOwners(text) {
  const match = /([\d,]+)\s*\.\.\s*([\d,]+)/.exec(String(text ?? ''));
  if (!match) return null;
  const low = Number(match[1].replaceAll(',', ''));
  const high = Number(match[2].replaceAll(',', ''));
  if (!Number.isFinite(low) || !Number.isFinite(high) || high <= 0) return null;
  const floor = Math.max(low, 1); // 0 也按 1 处理，避免几何平均为 0
  return Math.round(Math.sqrt(floor * high));
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
  /** @type {Map<number, number>} */
  const ownersByAppid = new Map();
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
      const owners = parseOwners(entry?.owners);
      if (owners === null) {
        skipped += 1;
        continue;
      }
      ownersByAppid.set(appid, owners);
    }

    pagesFetched += 1;
    if ((page + 1) % 10 === 0 || page === 0) {
      console.log(`  已抓 ${pagesFetched} 页，累计 ${ownersByAppid.size} 款`);
    }
    await sleep(args.pageDelayMs);
  }

  return { ownersByAppid, pagesFetched, skipped };
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

  let ownersByAppid;
  let source;
  let pagesFetched = 0;
  let skipped = 0;

  if (args.fixture) {
    ownersByAppid = new Map(FIXTURE);
    source = 'fixture';
    console.log(`  已载入离线样本 ${ownersByAppid.size} 款`);
  } else {
    const spy = await fetchSteamSpy(args);
    ownersByAppid = spy.ownersByAppid;
    pagesFetched = spy.pagesFetched;
    skipped = spy.skipped;
    source = 'steamspy';
    console.log(`  SteamSpy 完成：${ownersByAppid.size} 款 / ${pagesFetched} 页（跳过 ${skipped} 条无区间数据）`);

    if (ownersByAppid.size === 0) {
      throw new Error('SteamSpy 没有返回任何数据，已中止（不会覆盖现有快照）');
    }
  }

  // 按 appid 升序写成扁平数组 [appid, owners, appid, owners, ...]，比对象更省体积。
  const entries = [...ownersByAppid.entries()].sort((a, b) => a[0] - b[0]);
  const data = [];
  for (const [appid, owners] of entries) {
    data.push(appid, owners);
  }

  const quantiles = buildQuantiles(entries.map(([, owners]) => owners));
  const payload = {
    generatedAt: startedAt.toISOString(),
    metric: 'owners',
    source,
    fixture: args.fixture,
    count: entries.length,
    pages: pagesFetched,
    skipped,
    quantiles,
    data,
  };

  const target = await writeSnapshot(args.out, payload);
  const bytes = JSON.stringify(payload).length;
  console.log(
    `[fetch-players] 完成：${entries.length} 款，${(bytes / 1024).toFixed(0)} KB → ${target}`,
  );
  console.log(
    `[fetch-players] 分位点：p50=${quantiles[50]}，p90=${quantiles[90]}，p99=${quantiles[99]}`,
  );
}

main().catch((error) => {
  console.error(`[fetch-players] 失败：${error.message}`);
  process.exitCode = 1;
});
