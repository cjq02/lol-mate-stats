/** 全局类型定义（LCU 原始数据 + 本项目产出的报告结构） */

export interface LcuConnection {
  host: string;
  port: number;
  password: string;
  protocol: 'https';
  pid?: number;
  /** 连接信息来自哪里：process / lockfile / env */
  source: string;
}

export interface SummonerInfo {
  summonerId: number;
  accountId?: number;
  puuid?: string;
  displayName?: string;
  gameName?: string;
  tagLine?: string;
  summonerLevel?: number;
  profileIconId?: number;
}

export interface ChampSelectMember {
  cellId: number;
  summonerId: number;
  puuid?: string;
  championId: number;
  championPickIntent?: number;
  assignedPosition?: string;
  team: number;
}

export interface ChampSelectSession {
  localPlayerCellId: number;
  myTeam: ChampSelectMember[];
  theirTeam?: ChampSelectMember[];
  timer?: {
    phase?: string;
    adjustedTimeLeftInPhase?: number;
    totalTimeInPhase?: number;
    internalNowInEpochMs?: number;
  };
  actions?: Array<Array<{ actorCellId: number; championId: number; type: string; completed: boolean }>>;
}

export interface RawStats {
  win?: boolean | number;
  kills?: number;
  deaths?: number;
  assists?: number;
  goldEarned?: number;
  totalDamageDealtToChampions?: number;
  totalDamageTaken?: number;
  visionScore?: number;
  totalMinionsKilled?: number;
  neutralMinionsKilled?: number;
  minionsKilled?: number;
  [key: string]: unknown;
}

export interface RawParticipant {
  participantId?: number;
  teamId?: number;
  championId?: number;
  spell1Id?: number;
  spell2Id?: number;
  stats?: RawStats;
  timeline?: { lane?: string; role?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface RawIdentityPlayer {
  summonerId?: number | string;
  accountId?: number | string;
  currentAccountId?: number | string;
  puuid?: string;
  summonerName?: string;
  gameName?: string;
  tagLine?: string;
  [key: string]: unknown;
}

export interface RawGame {
  gameId?: number;
  gameCreation?: number;
  gameDuration?: number;
  queueId?: number;
  gameMode?: string;
  participants?: RawParticipant[];
  participantIdentities?: Array<{ participantId?: number; player?: RawIdentityPlayer }>;
  [key: string]: unknown;
}

export type Lane =
  | 'TOP'
  | 'JUNGLE'
  | 'MID'
  | 'ADC'
  | 'SUPPORT'
  | 'ARAM'
  | 'ARENA'
  | 'UNKNOWN';

export interface AnalyzedGame {
  gameId: number;
  queueId: number;
  queueName: string;
  gameCreation: number;
  durationMin: number;
  championId: number;
  championName: string;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  kda: number;
  cs: number;
  csPerMin: number;
  gold: number;
  damage: number;
  damageShare: number;
  damagePerMin: number;
  tankShare: number;
  killParticipation: number;
  visionScore: number;
  visionPerMin: number;
  position: Lane;
  score: number;
  tags: string[];
}

export interface Streak {
  type: 'win' | 'loss';
  count: number;
}

export interface TopChampion {
  championId: number;
  name: string;
  games: number;
  wins: number;
  winRate: number;
  avgKda: number;
}

export interface RiskAssessment {
  /** 坑指数 0-100，越高说明近期表现越差 */
  score: number;
  level: 'low' | 'medium' | 'high' | 'severe';
  /** 判断依据（含具体数值） */
  reasons: string[];
  /** 明显不达标的场次 / 严重不达标场次 */
  badGames: number;
  severeGames: number;
  /** 是否存在新手特征（等级低 + 数据差，仅为提示） */
  newbie: boolean;
}

export interface RecentSummary {
  games: number;
  wins: number;
  losses: number;
  winRate: number;
  /** 近 N 场中疑似挂机的场次 */
  afkGames: number;
  /** 疑似挂机比例 0-1 */
  afkRate: number;
  avgKda: number;
  avgScore: number;
  avgDamage: number;
  avgDamagePerMin: number;
  avgDamageShare: number;
  avgKillParticipation: number;
  avgCsPerMin: number;
  avgVisionPerMin: number;
  avgDeaths: number;
  avgDurationMin: number;
  streak: Streak | null;
  rating: number;
  grade: Grade;
  labels: string[];
  risk: RiskAssessment;
  topChampions: TopChampion[];
}

export type Grade = 'S' | 'A' | 'B' | 'C' | 'D';

/** 统计用的模式分组：召唤师峡谷 / 极地大乱斗 / 竞技场 */
export type GameModeKey = 'SR' | 'ARAM' | 'ARENA';

/** 当前对局信息：只统计同队列/同模式的近期战绩 */
export interface GameContext {
  queueId?: number;
  mode?: GameModeKey;
}

export interface RankInfo {
  queue: 'RANKED_SOLO_5x5' | 'RANKED_FLEX_SR';
  tier: string;
  division: string;
  leaguePoints: number;
  wins: number;
  losses: number;
}

/** 本局实时数据（来自 Live Client Data API） */
export interface LiveStats {
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
  wardScore?: number;
  championLevel?: number;
  isDead?: boolean;
}

/** Live Client Data API 返回的玩家结构（只保留用得到的字段） */
export interface LiveGamePlayer {
  championName?: string;
  rawChampionName?: string;
  isBot?: boolean;
  isDead?: boolean;
  level?: number;
  position?: string;
  riotId?: string;
  riotIdGameName?: string;
  riotIdTagLine?: string;
  summonerName?: string;
  team?: string;
  scores?: {
    kills?: number;
    deaths?: number;
    assists?: number;
    creepScore?: number;
    wardScore?: number;
  };
}

export interface GameflowSession {
  gameData?: {
    gameMode?: string;
    queue?: { id?: number };
  };
}

/** 首页“我的战绩”列表里的一场比赛 */
export interface MatchSummary {
  gameId: number;
  queueId: number;
  queueName: string;
  gameCreation: number;
  gameDuration: number;
  championId: number;
  championName?: string;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
}

export interface MatchScoreboardPlayer {
  puuid?: string;
  name: string;
  championId: number;
  championName?: string;
  teamId: number;
  isEnemy: boolean;
  position?: string;
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
  gold: number;
  damage: number;
  damageTaken: number;
  vision: number;
  win: boolean;
  items: number[];
}

export interface MatchDetail {
  gameId: number;
  queueId?: number;
  queueName: string;
  gameMode?: GameModeKey;
  gameCreation?: number;
  gameDuration?: number;
  selfPuuid?: string;
  players: PlayerReport[];
  scoreboard: MatchScoreboardPlayer[];
}

export interface LiveGameData {
  activePlayer?: {
    riotId?: string;
    summonerName?: string;
  };
  gameData?: {
    gameMode?: string;
    queue?: { id?: number };
  };
  allPlayers?: LiveGamePlayer[];
}

/** 本局玩家 + 己方/敌方标记（由当前玩家所在队伍推导） */
export interface LiveMember extends LiveGamePlayer {
  isEnemy?: boolean;
}

export interface PlayerReport {
  summonerId: number;
  puuid?: string;
  accountId?: number;
  displayName: string;
  tagLine?: string;
  level?: number;
  profileIconId?: number;
  /** 选人阶段的分配位置（top/jungle/middle/bottom/utility） */
  position?: string;
  championId?: number;
  championName?: string;
  rank?: RankInfo | null;
  recent?: RecentSummary;
  games?: AnalyzedGame[];
  /** 本局实时数据（游戏进行中才有） */
  live?: LiveStats;
  /** 人机玩家（无战绩可查） */
  isBot?: boolean;
  /** 对局中的敌方玩家 */
  isEnemy?: boolean;
  /** 近期综合评分 0-100，取不到战绩时为 null */
  rating: number | null;
  grade?: Grade;
  labels: string[];
  /** 数据获取失败时的提示 */
  error?: string;
  loading?: boolean;
}

export interface Snapshot {
  mode: 'live' | 'demo';
  phase: string;
  inChampSelect: boolean;
  /** 是否处于对局中（此时 players 为本局队友） */
  inGame?: boolean;
  collecting: boolean;
  updatedAt: string;
  message?: string;
  region?: string;
  /** 当前对局队列（用于只统计同模式战绩） */
  queueId?: number;
  /** 当前模式分组 */
  gameMode?: GameModeKey;
  localPlayer?: {
    summonerId: number;
    displayName: string;
    cellId: number;
    championId: number;
    championName?: string;
  };
  players: PlayerReport[];
  error?: string;
}
