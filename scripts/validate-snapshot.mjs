#!/usr/bin/env node
/**
 * 校验 src/data/players.json 的结构与可信度。
 *
 * 目的是让 CI 在快照"抓到了但明显不对"时失败，而不是把垃圾数据提交进仓库：
 * 例如 SteamSpy 被 Cloudflare 拦住时可能返回一页空对象，脚本会写出一份 0 条的合法 JSON。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_FILE = 'src/data/players.json';
// 线上快照至少要有这么多条；fixture 模式不设下限。
const MIN_COUNT = 1000;

const file = process.argv[2] ?? DEFAULT_FILE;
const problems = [];

let snapshot;
try {
  snapshot = JSON.parse(await readFile(path.resolve(file), 'utf8'));
} catch (error) {
  console.error(`[validate] 读取失败：${error.message}`);
  process.exit(1);
}

const { count, data, quantiles, fixture, generatedAt, source } = snapshot ?? {};

if (!Array.isArray(data)) problems.push('data 不是数组');
if (!Array.isArray(quantiles)) problems.push('quantiles 不是数组');
if (!Number.isInteger(count)) problems.push('count 不是整数');

if (Array.isArray(data)) {
  if (data.length % 2 !== 0) problems.push(`data 长度 ${data.length} 不是偶数`);
  const derived = data.length / 2;
  if (Number.isInteger(count) && count !== derived) {
    problems.push(`count=${count} 与 data 实际条数 ${derived} 不一致`);
  }
  for (let i = 0; i + 1 < data.length; i += 2) {
    if (!Number.isInteger(data[i]) || data[i] <= 0) {
      problems.push(`第 ${i / 2} 条 appid 非法：${data[i]}`);
      break;
    }
    if (!Number.isFinite(data[i + 1]) || data[i + 1] < 0) {
      problems.push(`第 ${i / 2} 条拥有者数非法：${data[i + 1]}`);
      break;
    }
  }
  if (!fixture && derived < MIN_COUNT) {
    problems.push(`非 fixture 快照只有 ${derived} 条，低于下限 ${MIN_COUNT}`);
  }
}

if (Array.isArray(quantiles)) {
  if (quantiles.length !== 101) problems.push(`quantiles 长度为 ${quantiles.length}，应为 101`);
  for (let i = 1; i < quantiles.length; i += 1) {
    if (quantiles[i] < quantiles[i - 1]) {
      problems.push(`quantiles 非单调递增（第 ${i} 项 ${quantiles[i]} < ${quantiles[i - 1]}）`);
      break;
    }
  }
}

if (!generatedAt || Number.isNaN(Date.parse(generatedAt))) problems.push('generatedAt 缺失或无法解析');

if (problems.length > 0) {
  console.error('[validate] 快照不合格：');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

const ageDays = (Date.now() - Date.parse(generatedAt)) / 86_400_000;
console.log(
  `[validate] 通过：${count} 款，来源 ${source}${fixture ? '（fixture，仅供本地调试）' : ''}，` +
    `生成于 ${generatedAt}（${ageDays.toFixed(1)} 天前）`,
);
if (Array.isArray(data)) {
  const distinct = new Set(data.filter((_, index) => index % 2 === 1)).size;
  console.log(`[validate] 不同取值：${distinct} 个`);
  if (!fixture && distinct < 1000) {
    // SteamSpy 的 owners 只有 13 个原始区间；低于 1000 说明没用评论数标定，
    // 会出现大量并列值，小众分在底部饱和。
    console.warn('[validate] ⚠ 取值过于集中，可能没走评论数标定（method=review-scaled）');
  }
}
if (ageDays > 30) {
  console.warn('[validate] ⚠ 快照已超过 30 天，建议重跑 fetch:players');
}
