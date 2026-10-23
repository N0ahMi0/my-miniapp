/**
 * 游戏库数据源。
 *
 * 优先读取真实的 Steam 游戏库（hbSDK.user.getSteamGameList，需声明 steamLibrary 权限）；
 * 未登录、未绑定 Steam、权限不足或 Host 不支持时，自动退回到内置示例库，
 * 保证在任何环境下都能看到完整页面。
 */
import hbSDK, { HbMiniProgramSDKError } from '@heybox/hb-sdk';

/** 最多拉取几页（每页 100 条），避免首次进入时请求过多。 */
const MAX_PAGES = 3;
const PAGE_SIZE = 100;

/** 内置示例游戏库，覆盖从大众到冷门的各种量级。 */
const MOCK_LIBRARY = [
  { appid: 730, name: 'Counter-Strike 2', playtimeHours: 1260 },
  { appid: 570, name: 'Dota 2', playtimeHours: 320 },
  { appid: 413150, name: 'Stardew Valley', playtimeHours: 186 },
  { appid: 294100, name: 'RimWorld', playtimeHours: 94 },
  { appid: 233860, name: 'Kenshi', playtimeHours: 61 },
  { appid: 526870, name: 'Satisfactory', playtimeHours: 44 },
  { appid: 457140, name: 'Oxygen Not Included', playtimeHours: 33 },
  { appid: 632470, name: 'Disco Elysium', playtimeHours: 27 },
  { appid: 1145360, name: 'Hades', playtimeHours: 21 },
  { appid: 945360, name: 'Among Us', playtimeHours: 15 },
  { appid: 108600, name: 'Project Zomboid', playtimeHours: 12 },
  { appid: 251570, name: '7 Days to Die', playtimeHours: 7 },
];

/** 示例库同样带上估算的图标地址占位（不回源加载，仅用于演示字段结构）。 */
const MOCK_SOURCE = 'mock';

function toHours(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.round((seconds / 3600) * 10) / 10;
}

/** SDK 错误码 -> 给用户看的原因说明。 */
function describeError(error) {
  if (error instanceof HbMiniProgramSDKError) {
    switch (error.code) {
      case 'PERMISSION_NOT_IN_SNAPSHOT':
        return '当前运行快照里没有 steamLibrary 声明，先用示例数据演示。';
      case 'PERMISSION_DENIED':
        return 'steamLibrary 声明已存在但未被平台批准，先用示例数据演示。';
      case 'METHOD_FORBIDDEN':
        return '当前客户端还没有开放 Steam 游戏库能力，先用示例数据演示。';
      case 'HEYBOX_APP_LOGIN_REQUIRED':
        return '小黑盒登录态已失效，先用示例数据演示。';
      case 'RATE_LIMITED':
      case 'RATE_LIMITED_BY_RUNTIME':
        return 'Steam 游戏库请求被限流，稍后可以重试，先用示例数据演示。';
      default:
        return `读取 Steam 游戏库失败（${error.code}），先用示例数据演示。`;
    }
  }
  return '读取 Steam 游戏库失败，先用示例数据演示。';
}

/**
 * 读取游戏库。
 * @returns {Promise<{source: string, reason: string, message: string, games: Array}>}
 */
export async function loadLibrary() {
  if (typeof hbSDK.user?.getSteamGameList !== 'function') {
    return {
      source: MOCK_SOURCE,
      reason: 'unsupported',
      message: '当前 SDK 版本没有 Steam 游戏库接口，先用示例数据演示。',
      games: MOCK_LIBRARY,
    };
  }

  const games = [];
  let offset = 0;
  let isMe = true;

  try {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await hbSDK.user.getSteamGameList({
        limit: PAGE_SIZE,
        offset,
        sort: 'all',
        includeHidden: false,
      });

      // 联合类型：必须先判 isLogin / isBound，再读 data。
      if (!result.isLogin) {
        return {
          source: MOCK_SOURCE,
          reason: 'not-login',
          message: '还没有登录小黑盒，先用示例数据演示。',
          games: MOCK_LIBRARY,
        };
      }
      if (!result.isBound) {
        return {
          source: MOCK_SOURCE,
          reason: 'not-bound',
          message: '当前账号还没有绑定 Steam，先用示例数据演示。',
          games: MOCK_LIBRARY,
        };
      }

      const data = result.data;
      if (typeof data?.isMe === 'boolean') isMe = isMe && data.isMe;
      for (const item of data.gameList ?? []) {
        games.push({
          appid: item.appid,
          name: item.name,
          image: item.image ?? item.icon ?? '',
          playtimeHours: toHours(item.playtimeForever),
          playtime2Weeks: toHours(item.playtime2Weeks),
        });
      }

      if (!data.hasMore) break;
      if (typeof data.nextOffset !== 'number' || data.nextOffset <= offset) break;
      offset = data.nextOffset;
    }
  } catch (error) {
    console.error('读取 Steam 游戏库失败', error);
    return {
      source: MOCK_SOURCE,
      reason: 'error',
      message: describeError(error),
      games: MOCK_LIBRARY,
    };
  }

  if (games.length === 0) {
    return {
      source: MOCK_SOURCE,
      reason: 'empty',
      message: '你的 Steam 游戏库里没有可统计的游戏，先用示例数据演示。',
      games: MOCK_LIBRARY,
    };
  }

  return {
    source: 'steam',
    reason: 'ok',
    message: isMe ? '数据来自你的 Steam 游戏库。' : '数据来自 Steam 游戏库。',
    games,
  };
}
