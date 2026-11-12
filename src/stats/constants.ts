import type { GameModeKey, Lane } from '../types.js';

export const QUEUE_NAMES: Record<number, string> = {
  400: '匹配模式',
  420: '单双排',
  430: '匹配模式',
  440: '灵活排位',
  450: '极地大乱斗',
  490: '快速匹配',
  700: '斗魂竞技场',
  720: '大乱斗克隆',
  890: '快速模式',
  900: '无限火力',
  1020: '克隆大作战',
  1300: '极限闪击',
  1400: '终极魔典',
  1700: '斗魂竞技场',
  1710: '斗魂竞技场',
  1900: '无限乱斗',
  2000: '新手教程',
};

export function queueName(queueId: number | undefined): string {
  if (!queueId) return '未知模式';
  return QUEUE_NAMES[queueId] ?? `模式 ${queueId}`;
}

/** 结算接口只给 queueType，用它反推常用队列 ID */
const QUEUE_IDS_BY_TYPE: Record<string, number> = {
  RANKED_SOLO_5x5: 420,
  RANKED_FLEX_SR: 440,
  NORMAL: 400,
  ARAM_UNRANKED_5x5: 450,
  ARAM_CLASH: 720,
  CHERRY: 1700,
  CHERRY_UNRANKED: 1700,
  URF: 900,
  ONEFORALL: 1020,
  NEXUSBLITZ: 1300,
  ULTBOOK: 1400,
  SWIFTPLAY: 890,
  BRAWL: 2300,
  KIWI: 2400,
  JADE: 3260,
  TUTORIAL_MODULE_1: 2000,
  TUTORIAL_MODULE_2: 2010,
  TUTORIAL_MODULE_3: 2020,
};

export function queueIdFromType(type?: string): number | undefined {
  if (!type) return undefined;
  // queueType 里的 5x5 是小写 x，不能整体转大写
  const name = type.trim();
  return QUEUE_IDS_BY_TYPE[name] ?? QUEUE_IDS_BY_TYPE[name.toUpperCase()];
}

export const MODE_NAMES: Record<GameModeKey, string> = {
  SR: '召唤师峡谷',
  ARAM: '极地大乱斗',
  ARENA: '斗魂竞技场',
};

/** 从队列 ID / Live Client Data 的 gameMode 推导统计分组 */
export function modeFromQueue(queueId?: number, gameMode?: string): GameModeKey | undefined {
  const mode = String(gameMode ?? '').toUpperCase();
  if (mode === 'ARAM' || queueId === 450 || queueId === 720) return 'ARAM';
  if (mode === 'CHERRY' || queueId === 1700 || queueId === 1710) return 'ARENA';
  if (mode === 'CLASSIC' || mode === 'SWIFTPLAY') return 'SR';
  if (queueId === 400 || queueId === 420 || queueId === 430 || queueId === 440 || queueId === 890) {
    return 'SR';
  }
  return undefined;
}

/** 当前队列对应的统计组：单双排、灵活排位、匹配、大乱斗、竞技场 */
export function currentQueueGroup(queueId?: number, mode?: GameModeKey): string {
  if (mode === 'ARAM') return 'aram';
  if (mode === 'ARENA') return 'arena';
  if (queueId === 420) return 'solo';
  if (queueId === 440) return 'flex';
  if (queueId === 400 || queueId === 430) return 'normal';
  if (queueId === 450 || queueId === 720) return 'aram';
  if (queueId === 1700 || queueId === 1710) return 'arena';
  return 'sr';
}

/** 一场历史对局属于哪个统计组 */
export function gameQueueGroup(queueId: number | undefined, position: Lane): string {
  if (position === 'ARAM' || queueId === 450 || queueId === 720) return 'aram';
  if (position === 'ARENA' || queueId === 1700 || queueId === 1710) return 'arena';
  if (queueId === 420) return 'solo';
  if (queueId === 440) return 'flex';
  if (queueId === 400 || queueId === 430) return 'normal';
  return 'sr';
}

export function queueGroupName(group: string, queueId?: number): string {
  if (group === 'aram') return '极地大乱斗';
  if (group === 'arena') return '斗魂竞技场';
  if (group === 'solo') return '单双排';
  if (group === 'flex') return '灵活排位';
  if (group === 'normal') return '匹配模式';
  return queueName(queueId) === '未知模式' ? '召唤师峡谷' : queueName(queueId);
}

export const POSITION_NAMES: Record<string, string> = {
  top: '上单',
  jungle: '打野',
  middle: '中单',
  mid: '中单',
  bottom: 'ADC',
  adc: 'ADC',
  utility: '辅助',
  support: '辅助',
};

export function positionName(position: string | undefined): string {
  if (!position) return '补位';
  return POSITION_NAMES[position.toLowerCase()] ?? position;
}

export const LANE_NAMES: Record<Lane, string> = {
  TOP: '上单',
  JUNGLE: '打野',
  MID: '中单',
  ADC: 'ADC',
  SUPPORT: '辅助',
  ARAM: '大乱斗',
  ARENA: '竞技场',
  UNKNOWN: '补位',
};

export const TIER_NAMES: Record<string, string> = {
  IRON: '黑铁',
  BRONZE: '青铜',
  SILVER: '白银',
  GOLD: '黄金',
  PLATINUM: '铂金',
  EMERALD: '翡翠',
  DIAMOND: '钻石',
  MASTER: '大师',
  GRANDMASTER: '宗师',
  CHALLENGER: '王者',
  UNRANKED: '未定级',
};

export const DIVISION_NAMES: Record<string, string> = {
  I: 'I',
  II: 'II',
  III: 'III',
  IV: 'IV',
};
