/** 全局类型定义（LCU 原始数据 + 本项目产出的报告结构） */

/** 历史战绩游标分页：按对局时间 + gameId 定位下一页 */
export interface ArchiveCursor {
  gameCreation: number;
  gameId: number;
}

/** 大乱斗选人阶段：当前英雄 / 替补席英雄的胜率信息 */
export interface AramChampionOption {
  championId: number;
  championName: string;
  /** 是否是当前分配到的英雄 */
  isCurrent: boolean;
  /** 替补席是否标记为优先 */
  isPriority?: boolean;
  /** 我的场次 / 胜率 / 均分（来自长期存档） */
  games: number;
  wins: number;
  winRate: number;
  avgScore: number;
  /** 本地存档里所有玩家在该英雄上的整体数据 */
  globalGames: number;
  globalWinRate: number;
}

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
  /** 大乱斗替补席是否可用 */
  benchEnabled?: boolean;
  /** 大乱斗替补席上的可选英雄 */
  benchChampions?: Array<{ championId: number; isPriority?: boolean }>;
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
  largestKillingSpree?: number;
  firstBloodKill?: boolean | number;
  firstBloodAssist?: boolean | number;
  doubleKills?: number;
  tripleKills?: number;
  quadraKills?: number;
  pentaKills?: number;
  turretKills?: number;
  totalHeal?: number;
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

/** 对局时间线里的一个分段（通常每 10 分钟） */
export interface TimelineSegment {
  startMin: number;
  endMin: number;
  /** 该分段的分均经济 */
  goldPerMin?: number;
  /** 该分段的分均经验 */
  xpPerMin?: number;
  /** 该分段相对对位的补刀差（负数表示落后） */
  csDiffPerMin?: number;
  /** 该分段相对对位的经验差 */
  xpDiffPerMin?: number;
}

/** 从结算接口的 timeline 字段解析出的节奏数据 */
export interface GameTimeline {
  segments: TimelineSegment[];
  /** 连续没有经济/经验增长的最长分钟数，用于识别中段挂机 */
  idleMinutes: number;
  /** 第一段的补刀差（前期对线） */
  csDiffEarly?: number;
  /** 最后一段的补刀差（中后期） */
  csDiffLate?: number;
  /** 第一段的经验差 */
  xpDiffEarly?: number;
  /** 最后一段的经验差 */
  xpDiffLate?: number;
}

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
  heal: number;
  damageShare: number;
  damagePerMin: number;
  tankShare: number;
  killParticipation: number;
  visionScore: number;
  visionPerMin: number;
  position: Lane;
  score: number;
  tags: string[];
  /** 结算接口提供 timeline 时才有 */
  timeline?: GameTimeline;
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

/** 玩家长期历史基线：用来判断近期表现是超常还是拉胯 */
export interface PlayerBaseline {
  /** 参与统计的历史场次 */
  games: number;
  /** 历史平均单场评分 */
  avgScore: number;
  /** 评分标准差（下限按 6 分兜底） */
  stdDev: number;
  /** 近期均分 - 历史均分 */
  delta: number;
  /** delta / stdDev，越大说明越超出自身平时水平 */
  z: number;
}

/** 某个英雄在长期存档里的使用情况 */
export interface ChampionUsage {
  championId: number;
  games: number;
  wins: number;
  winRate: number;
  avgScore: number;
  bestScore: number;
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
  /** 近 N 场中被判为小坑/坑/巨坑的场次（单场评分 < 40） */
  pitGames: number;
  avgKda: number;
  avgScore: number;
  avgDamage: number;
  avgDamagePerMin: number;
  avgDamageShare: number;
  avgKillParticipation: number;
  avgCsPerMin: number;
  avgVisionPerMin: number;
  avgDeaths: number;
  /** 场均治疗量 */
  avgHeal: number;
  avgDurationMin: number;
  streak: Streak | null;
  rating: number;
  grade: Grade;
  labels: string[];
  risk: RiskAssessment;
  topChampions: TopChampion[];
  /** 近期玩得最多的分路；ARAM/竞技场不参与统计 */
  mainPosition?: Lane;
  /** 主玩分路占比 0-1 */
  mainPositionShare: number;
}

export type Grade = 'S' | 'A' | 'B' | 'C' | 'D';

/** 单场“坑”的程度：小坑 / 坑 / 巨坑 */
export type BadLevel = 'mild' | 'bad' | 'severe';

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
  /** 对局已进行分钟数（用于分均指标） */
  gameMinutes?: number;
  /** 队伍总击杀，用于实时参团率 */
  teamKills?: number;
  /** 参团率 0-1 */
  killParticipation?: number;
  /** 装备总价值：官方实时接口不提供金币，用已购装备价格近似 */
  gold?: number;
  /** KDA（(击杀+助攻)/死亡） */
  kda?: number;
  csPerMin?: number;
  goldPerMin?: number;
  visionPerMin?: number;
  /** 当前装备（物品 id） */
  items?: number[];
  /** 召唤师技能名称 */
  summonerSpells?: string[];
  /** 基石 + 主系符文 */
  runes?: string;
  /** 复活剩余秒数；活着时为 0/undefined */
  respawnTimer?: number;
  /** 以下只有本人能拿到 */
  currentGold?: number;
  health?: number;
  maxHealth?: number;
  resourceValue?: number;
  resourceMax?: number;
  resourceType?: string;
  attackDamage?: number;
  abilityPower?: number;
  armor?: number;
  magicResist?: number;
  moveSpeed?: number;
  attackSpeed?: number;
  abilityHaste?: number;
  critChance?: number;
  /** 本人 Q/W/E/R 等级 */
  abilities?: Array<{ key: string; name?: string; level: number }>;
}

/** Live Client Data API 的装备条目（不同版本字段名略有差异） */
export interface LiveItem {
  itemID?: number;
  itemId?: number;
  displayName?: string;
  count?: number;
  price?: number;
}

/** 符文/基石 */
export interface LiveRunes {
  keystone?: { displayName?: string; id?: number };
  primaryRuneTree?: { displayName?: string; id?: number };
  secondaryRuneTree?: { displayName?: string; id?: number };
}

export interface LiveSummonerSpell {
  displayName?: string;
  rawDisplayName?: string;
}

export interface LiveSummonerSpells {
  summonerSpellOne?: LiveSummonerSpell;
  summonerSpellTwo?: LiveSummonerSpell;
}

/** activePlayer 的实时属性（只有本人有） */
export interface LiveChampionStats {
  currentHealth?: number;
  maxHealth?: number;
  resourceValue?: number;
  resourceMax?: number;
  resourceType?: string;
  attackDamage?: number;
  abilityPower?: number;
  armor?: number;
  magicResist?: number;
  moveSpeed?: number;
  attackSpeed?: number;
  abilityHaste?: number;
  critChance?: number;
}

export interface LiveAbility {
  abilityLevel?: number;
  displayName?: string;
  id?: string;
}

export interface LiveActivePlayer {
  riotId?: string;
  riotIdGameName?: string;
  riotIdTagLine?: string;
  summonerName?: string;
  currentGold?: number;
  level?: number;
  championStats?: LiveChampionStats;
  abilities?: Record<string, LiveAbility>;
  fullRunes?: LiveRunes;
}

/** 本局事件（击杀、推塔、小龙、大龙等） */
export interface LiveEvent {
  EventID?: number;
  EventName?: string;
  EventTime?: number;
  KillerName?: string;
  VictimName?: string;
  Assisters?: string[];
  TurretKilled?: string;
  InhibKilled?: string;
  DragonType?: string;
  MonsterType?: string;
  Stolen?: boolean;
}

/** Live Client Data API 返回的玩家结构（只保留用得到的字段） */
export interface LiveGamePlayer {
  championName?: string;
  rawChampionName?: string;
  isBot?: boolean;
  isDead?: boolean;
  level?: number;
  position?: string;
  respawnTimer?: number;
  riotId?: string;
  riotIdGameName?: string;
  riotIdTagLine?: string;
  summonerName?: string;
  team?: string;
  /** 装备栏：接口通常返回对象数组，偶尔是纯 id 数组 */
  items?: Array<number | LiveItem>;
  runes?: LiveRunes;
  summonerSpells?: LiveSummonerSpells;
  /** 只有本人会被 watcher 补上 activePlayer 数据 */
  active?: LiveActivePlayer;
  scores?: {
    kills?: number;
    deaths?: number;
    assists?: number;
    creepScore?: number;
    wardScore?: number;
  };
}

export interface GameflowTeamMember {
  puuid?: string;
  summonerId?: number;
  /** 同一开黑队伍会共享这个 ID */
  teamParticipantId?: number;
}

/** 大厅/选人阶段的队伍成员（用于识别开黑） */
export interface LobbyMember {
  puuid?: string;
  summonerId?: number;
}

export interface GameflowSession {
  gameData?: {
    gameMode?: string;
    queue?: { id?: number };
    teamOne?: GameflowTeamMember[];
    teamTwo?: GameflowTeamMember[];
  };
}

/** 结算界面（End of Game）返回的玩家数据 */
export interface EndOfGamePlayer {
  championId?: number;
  skinName?: string;
  summonerId?: number;
  accountId?: number;
  puuid?: string;
  summonerName?: string;
  teamId?: number;
  selectedPosition?: string;
  detectedTeamPosition?: string;
  items?: number[];
  stats?: Record<string, number | string | boolean | undefined>;
}

/** 结算界面的统计块；对局刚结束、客户端战绩列表尚未同步时可用 */
export interface EndOfGameStatsBlock {
  gameId?: number;
  gameLength?: number;
  gameMode?: string;
  queueId?: number;
  summonerId?: number;
  accountId?: number;
  championId?: number;
  teams?: Array<{
    teamId?: number;
    isWinningTeam?: boolean;
    isPlayerTeam?: boolean;
    players?: EndOfGamePlayer[];
  }>;
  /** 部分客户端版本把玩家直接放在顶层 */
  players?: EndOfGamePlayer[];
}

/** 首页“我的战绩”列表里的一场比赛 */
export interface MatchSummary {
  gameId: number;
  queueId: number;
  queueName: string;
  /** LCU 的 gameMode（CLASSIC / ARAM / CHERRY 等） */
  gameMode?: string;
  gameCreation: number;
  gameDuration: number;
  championId: number;
  championName?: string;
  /** 本局位置（TOP / JUNGLE / MID / ADC / SUPPORT / ARAM / ARENA / UNKNOWN） */
  position?: string;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  /** 本场评分（从本地存档或实时分析得到） */
  score?: number;
  /** 本场标记：重开、队友逃跑等 */
  tags?: string[];
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
  heal: number;
  vision: number;
  win: boolean;
  items: number[];
  /** 本局时长（分钟） */
  durationMin?: number;
  /** 本局表现评分（与近期战绩的评分口径一致） */
  score?: number;
  grade?: Grade;
  damageShare?: number;
  tankShare?: number;
  killParticipation?: number;
  csPerMin?: number;
  goldPerMin?: number;
  damagePerMin?: number;
  damageTakenPerMin?: number;
  visionPerMin?: number;
  /** 本局“坑”的程度 */
  badLevel?: BadLevel;
  tags?: string[];
  /** 本局节奏（结算接口有 timeline 时） */
  timeline?: GameTimeline;
}

export interface MatchAfkPlayer {
  puuid?: string;
  name: string;
  championId: number;
  championName?: string;
  teamId: number;
  isEnemy: boolean;
  position?: string;
  /** 本局“坑”的程度，仅 badPlayers 使用 */
  badLevel?: BadLevel;
  /** 本局表现分 */
  score?: number;
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
  /** 本局标记：重开、队友逃跑、对手逃跑等 */
  tags?: string[];
  /** 被推断为逃跑/挂机的具体玩家 */
  afkPlayers?: MatchAfkPlayer[];
  /** 本局表现明显偏差的具体玩家 */
  badPlayers?: MatchAfkPlayer[];
}

export interface LiveGameData {
  activePlayer?: LiveActivePlayer;
  gameData?: {
    gameMode?: string;
    queue?: { id?: number };
    /** 对局已进行秒数 */
    gameTime?: number;
    mapName?: string;
    mapNumber?: number;
    mapTerrain?: string;
  };
  allPlayers?: LiveGamePlayer[];
  events?: { Events?: LiveEvent[] };
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
  /** 与长期历史相比的状态（需要存档里至少有 10 场） */
  baseline?: PlayerBaseline;
  /** 当前英雄的历史熟练度（来自长期存档） */
  championStats?: ChampionUsage;
  /** 本局实时数据（游戏进行中才有） */
  live?: LiveStats;
  /** 人机玩家（无战绩可查） */
  isBot?: boolean;
  /** 对局中的敌方玩家 */
  isEnemy?: boolean;
  /** 本局一起开黑的人数（仅当前对局可识别，2 人以上才有值） */
  premadeSize?: number;
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
  /** 对局已进行秒数（游戏进行中） */
  gameTime?: number;
  /** 当前模式分组 */
  gameMode?: GameModeKey;
  /** 当前这局游戏的临时会话 ID（用于保存实时 AI 分析） */
  liveSessionId?: string;
  /** 本局事件（击杀、推塔、小龙、大龙等），用于实时 AI */
  liveEvents?: LiveEvent[];
  /** 大乱斗选人阶段的可选英雄（当前英雄 + 替补席） */
  aramChampions?: AramChampionOption[];
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
