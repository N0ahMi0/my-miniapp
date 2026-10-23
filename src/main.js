import hbSDK, { HbMiniProgramSDKError } from '@heybox/hb-sdk';
import './styles.css';
import { loadLibrary } from './game-source.js';
import { computeNicheIndex } from './niche.js';
import { snapshotMeta } from './player-stats.js';

// key 只允许 1-128 位字母、数字、下划线和连字符，不能带冒号。
const STORAGE_KEY = 'niche_last_result';
// v3：口径改为"拥有者数量"，旧存档字段不兼容，直接作废重算。
const STORAGE_VERSION = 3;

const els = {
  avatar: document.querySelector('[data-testid="user-avatar"]'),
  userName: document.querySelector('[data-testid="user-name"]'),
  userHint: document.querySelector('[data-testid="user-hint"]'),
  login: document.querySelector('[data-testid="login-button"]'),
  scoreValue: document.querySelector('[data-testid="score-value"]'),
  scoreRank: document.querySelector('[data-testid="score-rank"]'),
  scoreDesc: document.querySelector('[data-testid="score-desc"]'),
  statGames: document.querySelector('[data-testid="stat-games"]'),
  statHours: document.querySelector('[data-testid="stat-hours"]'),
  statMedian: document.querySelector('[data-testid="stat-median"]'),
  gameList: document.querySelector('[data-testid="game-list"]'),
  compute: document.querySelector('[data-testid="compute-button"]'),
  share: document.querySelector('[data-testid="share-button"]'),
  save: document.querySelector('[data-testid="save-button"]'),
  status: document.querySelector('[data-testid="status"]'),
  sourceNote: document.querySelector('[data-testid="source-note"]'),
  savedNote: document.querySelector('[data-testid="saved-note"]'),
};

const colorScheme = window.matchMedia('(prefers-color-scheme: dark)');

let sdkReady = false;
let busy = false;
let currentResult = null;
let runtimeMode = 'unknown';

/* ---------------------------------- 工具 ---------------------------------- */

function setStatus(message, tone = 'info') {
  els.status.textContent = message;
  els.status.dataset.tone = tone;
}

async function toast(message, status = 'success') {
  try {
    await hbSDK.ui.showToast({ message, status });
  } catch (error) {
    console.warn('Toast 展示失败', error);
  }
}

function formatHours(hours) {
  if (hours >= 1000) return `${(hours / 1000).toFixed(1)}k`;
  return String(Math.round(hours));
}

function formatTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

/** 只把摘要写入 Storage，避免把整份游戏库塞进配额。 */
function toSummary(result) {
  return {
    version: STORAGE_VERSION,
    index: result.index,
    rankName: result.rank?.name ?? '',
    rankDesc: result.rank?.desc ?? '',
    totalGames: result.totalGames,
    totalHours: result.totalHours,
    medianOwnersText: result.medianOwnersText ?? result.medianCcuText ?? '',
    niche: (result.niche ?? []).map((game) => ({
      name: game.name,
      ownersText: game.ownersText,
      rarity: game.rarity,
      estimated: Boolean(game.estimated),
      playtimeHours: game.playtimeHours,
    })),
    source: result.source ?? 'mock',
    sourceMessage: result.message ?? '',
    computedAt: result.computedAt,
    savedAt: new Date().toISOString(),
  };
}

/* --------------------------------- 渲染 --------------------------------- */

function renderGameList(niche) {
  els.gameList.replaceChildren();
  if (!niche || niche.length === 0) {
    const row = document.createElement('li');
    row.className = 'empty-row';
    row.textContent = '没有可展示的游戏';
    els.gameList.append(row);
    return;
  }

  for (const game of niche) {
    const item = document.createElement('li');
    item.className = 'game-row';

    const head = document.createElement('div');
    head.className = 'game-head';

    const name = document.createElement('span');
    name.className = 'game-name';
    name.textContent = game.name;

    const players = document.createElement('span');
    players.className = 'game-players';
    const ownersText = game.ownersText ?? game.ccuText ?? game.playersText;
    players.textContent = ownersText ? `${ownersText} 拥有${game.estimated ? ' · 估算' : ''}` : '数据缺失';

    head.append(name, players);

    const bar = document.createElement('div');
    bar.className = 'bar';
    const fill = document.createElement('div');
    fill.className = 'bar-fill';
    fill.style.width = `${Math.min(Math.max(game.rarity, 2), 100)}%`;
    bar.append(fill);

    item.append(head, bar);
    els.gameList.append(item);
  }
}

function renderSummary(summary, { restored = false } = {}) {
  els.scoreValue.textContent = String(summary.index);
  els.scoreRank.textContent = summary.rankName;
  els.scoreDesc.textContent = summary.rankDesc;
  els.statGames.textContent = String(summary.totalGames);
  els.statHours.textContent = formatHours(summary.totalHours);
  els.statMedian.textContent = summary.medianOwnersText ?? summary.medianCcuText ?? '--';
  renderGameList(summary.niche);

  const fromSteam = summary.source === 'steam';
  const meta = snapshotMeta();
  const snapshotPart = meta.generatedAt
    ? `｜拥有者数据快照：${formatTime(meta.generatedAt)}（${meta.count} 款${meta.fixture ? '，示例' : ''}）`
    : '';
  els.sourceNote.textContent = `数据来源：${fromSteam ? 'Steam 游戏库' : '内置示例数据'}${
    summary.sourceMessage ? ` — ${summary.sourceMessage}` : ''
  }${snapshotPart}`;

  if (summary.savedAt) {
    els.savedNote.hidden = false;
    els.savedNote.textContent = `${restored ? '已恢复上次保存的结果' : '已保存到本地'} · ${formatTime(summary.savedAt)}`;
  }

  els.share.disabled = false;
  els.save.disabled = false;
  currentResult = summary;
}

function resetButtons() {
  els.compute.disabled = !sdkReady || busy;
  els.login.disabled = !sdkReady || busy;
  els.share.disabled = busy || !currentResult;
  els.save.disabled = busy || !currentResult;
}

/* -------------------------------- 本地存储 -------------------------------- */

async function saveResult({ silent }) {
  if (!currentResult) return;
  const summary = toSummary({ ...currentResult, savedAt: undefined });
  try {
    await hbSDK.storage.setStorage({ key: STORAGE_KEY, data: summary });
    els.savedNote.hidden = false;
    els.savedNote.textContent = `已保存到本地 · ${formatTime(summary.savedAt)}`;
    if (!silent) {
      await toast('已保存到本地', 'success');
      setStatus('结果已写入本地 Storage，下次打开会自动恢复。');
    }
  } catch (error) {
    console.error('保存失败', error);
    const code = error instanceof HbMiniProgramSDKError ? error.code : error?.message;
    setStatus(`保存失败：${code ?? '未知错误'}`, 'error');
    if (!silent) await toast('保存失败', 'error');
  }
}

async function readSaved() {
  try {
    const { data } = await hbSDK.storage.getStorage({ key: STORAGE_KEY });
    if (!data || data.version !== STORAGE_VERSION || typeof data.index !== 'number') return null;
    return data;
  } catch (error) {
    console.warn('读取本地结果失败', error);
    return null;
  }
}

/* --------------------------------- 业务 ---------------------------------- */

async function refreshIdentity() {
  if (typeof hbSDK.user?.getInfo !== 'function') return;
  try {
    const info = await hbSDK.user.getInfo();
    if (!info.isHeyboxAppLoggedIn) {
      els.userName.textContent = '未登录';
      els.userHint.textContent = '登录后可读取你的 Steam 游戏库';
      els.avatar.hidden = true;
      return;
    }
    const profile = info.userInfo?.profile ?? {};
    els.userName.textContent = profile.nickname || '已登录';
    els.userHint.textContent = info.userInfo?.steamId ? '已绑定 Steam' : '已登录小黑盒';
    if (profile.avatar) {
      els.avatar.src = profile.avatar;
      els.avatar.hidden = false;
    } else {
      els.avatar.hidden = true;
    }
  } catch (error) {
    console.warn('读取用户资料失败', error);
    els.userHint.textContent = '暂时读不到用户资料';
  }
}

async function compute({ silent = false } = {}) {
  if (busy) return;
  busy = true;
  resetButtons();
  if (!silent) setStatus('正在读取游戏库并计算…');

  try {
    const library = await loadLibrary();
    els.userHint.textContent = library.source === 'steam' ? '已读取 Steam 游戏库' : library.message;
    const result = computeNicheIndex(library.games);
    const summary = toSummary({
      ...result,
      source: library.source,
      message: library.message,
    });

    renderSummary(summary);
    await saveResult({ silent: true });
    setStatus(
      library.source === 'steam'
        ? `已按 ${summary.totalGames} 款游戏算出小众指数。`
        : `当前使用示例数据（${library.message}），结果仅用于演示。`,
      library.source === 'steam' ? 'success' : 'warn',
    );
  } catch (error) {
    console.error('计算失败', error);
    setStatus(`计算出错：${error?.message ?? '未知错误'}`, 'error');
  } finally {
    busy = false;
    resetButtons();
  }
}

async function login() {
  if (busy) return;

  // Browser Mock 没有真实账号上下文，auth.login() 必然失败（RUNTIME_CONTEXT_INVALID），
  // 提前说明比先抛错误再解释更清楚；真机/生产环境仍会走真实授权流程。
  if (runtimeMode === 'development') {
    setStatus(
      '浏览器 Mock 没有可用的账号上下文，无法完成真实授权码登录。请在小黑盒客户端打开本小程序验收登录流程；此处的身份已通过 user.getInfo() 读取。',
      'warn',
    );
    return;
  }

  busy = true;
  resetButtons();
  setStatus('正在请求登录授权…');

  try {
    const result = await hbSDK.auth.login({ scopes: ['profile'] });
    const ttl = typeof result.expiresIn === 'number' ? `，授权码 ${result.expiresIn} 秒内有效` : '';
    await toast('登录成功', 'success');
    setStatus(`已拿到一次性授权码${ttl}。授权码应交给自己的服务端换取 token，页面不保存它。`, 'success');
    await refreshIdentity();
    await compute({ silent: true });
  } catch (error) {
    if (error instanceof HbMiniProgramSDKError) {
      if (error.code === 'AUTHORIZATION_CANCELLED') {
        setStatus('已取消登录。');
        return;
      }
      if (error.code === 'SERVER_API_REQUIRED') {
        setStatus(
          '当前运行在无网络的本地模式，授权码登录需要先声明并获得 network 平台批准；身份展示仍可通过 user.getInfo() 读取。',
          'warn',
        );
        return;
      }
      if (error.code === 'RUNTIME_CONTEXT_INVALID') {
        setStatus(
          `当前运行环境（${runtimeMode === 'development' ? '浏览器 Mock' : '当前客户端'}）没有可用的账号上下文，无法完成真实授权码登录；请在真机小黑盒客户端验收登录流程，身份展示仍可通过 user.getInfo() 读取。`,
          'warn',
        );
        return;
      }
      if (error.code === 'USER_GESTURE_REQUIRED') {
        setStatus('授权登录必须在按钮点击等用户操作中发起，请重新点击「登录」。', 'warn');
        return;
      }
      setStatus(`登录失败：${error.code}`, 'error');
      return;
    }
    setStatus(`登录失败：${error?.message ?? '未知错误'}`, 'error');
  } finally {
    busy = false;
    resetButtons();
  }
}

async function share() {
  if (!currentResult || busy) return;
  const extra = {
    score: String(currentResult.index),
    rank: currentResult.rankName,
  };

  try {
    const url = await hbSDK.share.copyLink({ extra });
    await toast('分享链接已复制', 'success');
    setStatus(`已复制分享链接：${url}`);
    return;
  } catch (error) {
    console.warn('share.copyLink 失败', error);
    const code = error instanceof HbMiniProgramSDKError ? error.code : error?.message;
    // 降级：直接把结果文案写进剪贴板，保证提示不丢。
    const text = `我的小众指数 ${currentResult.index}/100（${currentResult.rankName}），你猜我玩的是不是冷门？`;
    try {
      await navigator.clipboard.writeText(text);
      await toast('已复制结果文案', 'success');
      setStatus(`分享链接不可用（${code ?? '未知原因'}），已改为复制结果文案。`, 'warn');
    } catch (fallbackError) {
      console.error('复制失败', fallbackError);
      setStatus(`分享失败：${code ?? '未知原因'}`, 'error');
      await toast('分享失败', 'error');
    }
  }
}

/* --------------------------------- 启动 --------------------------------- */

function syncNavigationBar() {
  hbSDK.viewport
    .setNavigationBarStyle({ foregroundStyle: colorScheme.matches ? 'light' : 'dark' })
    .catch((error) => console.error('无法同步导航栏样式', error));
}

async function boot() {
  resetButtons();
  syncNavigationBar();

  if (typeof colorScheme.addEventListener === 'function') {
    colorScheme.addEventListener('change', syncNavigationBar);
  } else if (typeof colorScheme.addListener === 'function') {
    colorScheme.addListener(syncNavigationBar);
  }

  els.compute.addEventListener('click', () => compute());
  els.login.addEventListener('click', login);
  els.share.addEventListener('click', share);
  els.save.addEventListener('click', () => saveResult({ silent: false }));

  hbSDK.onHandshakeStateChange((state) => {
    sdkReady = state.status === 'ready';
    resetButtons();
    if (!sdkReady) {
      setStatus(`SDK 状态：${state.status}`, 'warn');
      return;
    }

    // 握手完成后：先恢复上次结果，没有历史记录再自动算一次。
    void (async () => {
      try {
        const env = await hbSDK.environment.getInfo();
        runtimeMode = env.runtime.mode;
      } catch (error) {
        console.warn('读取环境信息失败', error);
      }
      await refreshIdentity();
      const saved = await readSaved();
      if (saved) {
        renderSummary(saved, { restored: true });
        setStatus('已恢复上次保存的结果，点「计算」可按最新游戏库重算。');
        return;
      }
      await compute({ silent: true });
    })();
  });
}

void boot();
