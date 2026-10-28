import type { Lane } from '../types.js';

export const QUEUE_NAMES: Record<number, string> = {
  400: '匹配模式',
  420: '单双排',
  430: '匹配模式',
  440: '灵活排位',
  450: '极地大乱斗',
  490: '快速匹配',
  700: '斗魂竞技场',
  720: '大乱斗克隆',
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
