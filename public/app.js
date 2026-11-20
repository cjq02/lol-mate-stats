/* global EventSource, fetch */

const els = {
  board: document.getElementById('board'),
  aramPanel: document.getElementById('aram-panel'),
  aramList: document.getElementById('aram-list'),
  aramHint: document.getElementById('aram-hint'),
  empty: document.getElementById('empty'),
  emptyIcon: document.getElementById('empty-icon'),
  emptyTitle: document.getElementById('empty-title'),
  emptyDesc: document.getElementById('empty-desc'),
  status: document.getElementById('status-line'),
  phase: document.getElementById('phase-badge'),
  mode: document.getElementById('mode-badge'),
  region: document.getElementById('region-badge'),
  updated: document.getElementById('updated'),
  notice: document.getElementById('notice'),
  refresh: document.getElementById('refresh'),
  liveDot: document.getElementById('live-dot'),
  recentHint: document.getElementById('recent-hint'),
  searchForm: document.getElementById('search-form'),
  searchInput: document.getElementById('search-input'),
  searchPanel: document.getElementById('search-panel'),
  searchTitle: document.getElementById('search-title'),
  searchStatus: document.getElementById('search-status'),
  searchBoard: document.getElementById('search-board'),
  searchClose: document.getElementById('search-close'),
  matchesModal: document.getElementById('matches-modal'),
  matchesTitle: document.getElementById('matches-title'),
  matchesList: document.getElementById('matches-list'),
  matchesClose: document.getElementById('matches-close'),
  matchesBack: document.getElementById('matches-back'),
  matchesRefresh: document.getElementById('matches-refresh'),
  matchesAi: document.getElementById('matches-ai'),
  matchesTimeline: document.getElementById('matches-timeline'),
  timelineModal: document.getElementById('timeline-modal'),
  timelineTitle: document.getElementById('timeline-title'),
  timelineMeta: document.getElementById('timeline-meta'),
  timelinePlayers: document.getElementById('timeline-players'),
  timelineSummary: document.getElementById('timeline-summary'),
  timelineList: document.getElementById('timeline-list'),
  timelineClose: document.getElementById('timeline-close'),
  matchTabs: document.getElementById('match-tabs'),
  myMatchesTabs: document.getElementById('my-matches-tabs'),
  mySrTabs: document.getElementById('my-sr-tabs'),
  matchMeta: document.getElementById('match-meta'),
  matchProgress: document.getElementById('match-progress'),
  scoreTip: document.getElementById('score-tip'),
  infoTip: document.getElementById('info-tip'),
  matchSummary: document.getElementById('match-summary'),
  matchesSummary: document.getElementById('matches-summary'),
  matchesRangeTabs: document.getElementById('matches-range-tabs'),
  matchFlags: document.getElementById('match-flags'),
  aiModal: document.getElementById('ai-modal'),
  aiModalTitle: document.getElementById('ai-modal-title'),
  aiMeta: document.getElementById('ai-meta'),
  aiBody: document.getElementById('ai-body'),
  aiTabs: document.getElementById('ai-tabs'),
  aiClose: document.getElementById('ai-close'),
  aiRerun: document.getElementById('ai-rerun'),
  aiAsk: document.getElementById('ai-ask'),
  aiAskChips: document.getElementById('ai-ask-chips'),
  aiAskForm: document.getElementById('ai-ask-form'),
  aiAskInput: document.getElementById('ai-ask-input'),
  aiAskSend: document.getElementById('ai-ask-send'),
  aiNodes: document.getElementById('ai-nodes'),
  aiNodeList: document.getElementById('ai-node-list'),
  myMatches: document.getElementById('my-matches'),
  championRanking: document.getElementById('champion-ranking'),
  championRankingModal: document.getElementById('champion-ranking-modal'),
  championRankingList: document.getElementById('champion-ranking-list'),
  championRankingTabs: document.getElementById('champion-ranking-tabs'),
  championRankingSort: document.getElementById('champion-ranking-sort'),
  championRankingMeta: document.getElementById('champion-ranking-meta'),
  championRankingClose: document.getElementById('champion-ranking-close'),
  timeStats: document.getElementById('time-stats'),
  timeStatsModal: document.getElementById('time-stats-modal'),
  timeStatsTabs: document.getElementById('time-stats-tabs'),
  timeStatsDimension: document.getElementById('time-stats-dimension'),
  timeStatsSummary: document.getElementById('time-stats-summary'),
  timeStatsList: document.getElementById('time-stats-list'),
  timeStatsMeta: document.getElementById('time-stats-meta'),
  timeStatsClose: document.getElementById('time-stats-close'),
  latestMatch: document.getElementById('latest-match'),
  liveAi: document.getElementById('live-ai'),
};

const PHASE_LABELS = {
  None: '未连接',
  Lobby: '大厅',
  Matchmaking: '匹配中',
  CheckedIntoTournament: '赛事中',
  ReadyCheck: '确认对局',
  ChampSelect: '选人阶段',
  GameStart: '游戏启动中',
  InProgress: '游戏进行中',
  Reconnect: '重连中',
  WaitingForStats: '结算中',
  PreEndOfGame: '结算中',
  EndOfGame: '对局结束',
  TerminatedInError: '异常结束',
};

const PHASE_TITLES = {
  None: '等待客户端连接',
  Lobby: '已进入大厅',
  Matchmaking: '正在匹配…',
  ReadyCheck: '已找到对局',
  ChampSelect: '正在进入选人阶段…',
  GameStart: '游戏即将开始',
  InProgress: '游戏进行中',
  WaitingForStats: '正在结算…',
  EndOfGame: '对局已结束',
  Reconnect: '客户端重连中',
};

const PHASE_ICONS = {
  None: '🔌',
  Lobby: '🏠',
  Matchmaking: '🔍',
  ReadyCheck: '🎯',
  ChampSelect: '⏳',
  InProgress: '🎮',
  WaitingForStats: '📊',
  EndOfGame: '📊',
  Reconnect: '📡',
};

const POSITION_NAMES = {
  top: '上单',
  jungle: '打野',
  middle: '中单',
  mid: '中单',
  bottom: 'ADC',
  adc: 'ADC',
  utility: '辅助',
  support: '辅助',
};

const LANE_NAMES = {
  TOP: '上单',
  JUNGLE: '打野',
  MID: '中单',
  ADC: 'ADC',
  SUPPORT: '辅助',
  ARAM: '大乱斗',
  ARENA: '竞技场',
  UNKNOWN: '补位',
};

const TIER_NAMES = {
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

const QUEUE_LABELS = {
  400: '匹配模式',
  420: '单双排',
  430: '匹配模式',
  440: '灵活排位',
  450: '极地大乱斗',
  490: '快速匹配',
  700: '斗魂竞技场',
  720: '大乱斗克隆',
  1700: '斗魂竞技场',
  1710: '斗魂竞技场',
};

const MODE_LABELS = {
  SR: '召唤师峡谷',
  ARAM: '极地大乱斗',
  ARENA: '斗魂竞技场',
};

const CHAMPION_RANKING_MODE_LABELS = {
  all: '全部模式',
  SR: '召唤师峡谷',
  ARAM: '极地大乱斗',
  ARENA: '斗魂竞技场',
};

const SR_MODE_LABELS = {
  all: '召唤师峡谷',
  ranked: '排位',
  normal: '匹配',
  bot: '人机',
  swift: '快速模式',
  practice: '训练',
};

/** 人机队列：包含旧版 5v5 人机、3v3/1v1 人机和现在使用 Swiftplay 的人机队列 */
const BOT_QUEUE_IDS = new Set([
  800, 801, 810, 820, 830, 831, 832, 840, 841, 842, 850, 851, 852, 860, 861,
  862, 865, 870, 880, 890, 891, 893, 894,
]);

const CHAMPION_RANKING_SORT_LABELS = {
  avg: '平均分',
  games: '场次',
  winRate: '胜率',
  best: '最高分',
  proficiency: '熟练度',
};

const TIME_STATS_DIMENSION_LABELS = {
  hour: '按时段',
  weekday: '按星期',
  week: '按周',
  month: '按月',
  position: '按位置',
  type: '按类型',
};

const TIME_STATS_VIEW_LABELS = {
  winRate: '胜率',
  score: '评分',
};

function currentModeLabel() {
  const snapshot = state.snapshot;
  if (snapshot?.queueId && QUEUE_LABELS[snapshot.queueId]) {
    return QUEUE_LABELS[snapshot.queueId];
  }
  if (snapshot?.gameMode && MODE_LABELS[snapshot.gameMode]) {
    return MODE_LABELS[snapshot.gameMode];
  }
  return '近期';
}

function snapshotContext() {
  const snapshot = state.snapshot;
  if (!snapshot) return undefined;
  if (!snapshot.queueId && !snapshot.gameMode) return undefined;
  return { queueId: snapshot.queueId, mode: snapshot.gameMode };
}

const state = {
  snapshot: null,
  snapshotSig: '',
  live: false,
  refreshing: false,
  selfPuuid: '',
  matchRequestToken: 0,
  backStack: [],
  backScrollStack: [],
  currentView: null,
  loadingTimer: null,
  loadingProgress: null,
  matchDetail: null,
  matchTab: 'scoreboard',
  /** 本局时间线：{ gameId, data, cached, playerId } */
  timeline: null,
  timelineToken: 0,
  /** “我的战绩”当前模式的总胜负（来自历史存档） */
  modeRecord: null,
  /** 非空时“我的战绩”只显示该英雄的对局 */
  championFilter: null,
  /** “我的战绩”当前模式页签：all / SR / ARAM / ARENA */
  myMatchesMode: 'ARAM',
  /** 召唤师峡谷子页签：all / ranked / normal / bot / swift */
  myMatchesSrMode: 'all',
  /** 战绩列表当前显示范围：10 / 20 / 50 / 100 / 200 / 0（全部） */
  matchesRange: 50,
  matchesRangeLoading: false,
  matchesRangeToken: 0,
  myGames: [],
  myLcuOffset: 0,
  lcuExhausted: false,
  archiveOffset: 0,
  archiveLoaded: 0,
  archiveTotal: 0,
  archiveCursor: null,
  archiveLoading: false,
  championRankingLoading: false,
  /** 英雄评分排名当前模式：all / SR / ARAM / ARENA */
  championRankingMode: 'ARAM',
  /** 英雄评分排名排序：avg / games / winRate / best */
  championRankingSort: 'avg',
  championRankingData: [],
  championRankingToken: 0,
  /** 时段胜率当前模式：all / SR / ARAM / ARENA */
  timeStatsMode: 'ARAM',
  /** 时段统计口径：winRate / score */
  timeStatsView: 'winRate',
  /** 时段胜率统计维度：hour / weekday / week / month */
  timeStatsDimension: 'hour',
  timeStatsData: null,
  timeStatsSource: '',
  timeStatsToken: 0,
  timeStatsLoading: false,
  /** 查看玩家战绩时的分页状态 */
  playerMatches: null,
  itemIcons: null,
  /** 点击英雄头像/装备时按需加载的角色技能与装备描述 */
  championInfo: {},
  itemDetails: null,
  searchPlayers: [],
  matchesRefreshHandler: null,
  matchesRefreshing: false,
  latestLoading: false,
  aiStatus: null,
  aiLoading: false,
  aiTimer: null,
  /** 当前对局 AI 分析：{ gameId, controller, text, status, error, model, running, done } */
  ai: null,
};

/** “我的战绩”每次从客户端翻页读取的场次 */
const MY_MATCH_PAGE = 30;

/** 单个英雄的战绩每页场次（后端按英雄 + 模式直接查询） */
const CHAMPION_MATCH_PAGE = 20;

/** 查看某个玩家战绩时，历史存档每页场次 */
const PLAYER_MATCH_PAGE = 20;

/** 静态截图模式：?static=1 时只拉取一次快照，不建立 SSE（用于无头浏览器截图/调试） */
const STATIC_MODE = new URLSearchParams(window.location.search).has('static');

/** key -> { sig, node } */
const cardCache = new Map();

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function hueFor(text) {
  let hash = 0;
  const value = String(text ?? '?');
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) % 360;
  }
  return hash;
}

/** 0/0/0、0/1/0 这类几乎没有参与对局的场次，用灰色表示，不按低分红色处理 */
function isInactiveKda(stats) {
  if (!stats) return false;
  const kills = Number(stats.kills) || 0;
  const assists = Number(stats.assists) || 0;
  const deaths = Number(stats.deaths) || 0;
  return kills === 0 && assists === 0 && deaths <= 1;
}

const RATING_TONES = [
  { min: 75, className: 'score-75', color: '#3ddc97' },
  { min: 65, className: 'score-65', color: '#5eead4' },
  { min: 55, className: 'score-55', color: '#f5c76a' },
  { min: 45, className: 'score-45', color: '#ffab5e' },
  { min: 35, className: 'score-35', color: '#ff9b9b' },
  { min: -Infinity, className: 'score-low', color: '#ff4d6d' },
];

/**
 * 战绩列表上方的评分分段：直接复用 RATING_TONES 的边界和颜色，
 * 保证同一个分数在列表里和分段条里颜色一致（75+ / 65–74 / 55–64 / 45–54 / 35–44 / < 35）。
 */
const MATCH_SCORE_BANDS = RATING_TONES.map((tone, index) => {
  const upper = index === 0 ? null : RATING_TONES[index - 1].min - 1;
  const label =
    upper === null
      ? `${tone.min}+`
      : Number.isFinite(tone.min)
        ? `${tone.min}–${upper}`
        : `< ${upper + 1}`;
  return {
    from: tone.min,
    label,
    className: `score-band-${Number.isFinite(tone.min) ? tone.min : 'low'}`,
  };
});

/** 单场评分属于哪一段：返回 MATCH_SCORE_BANDS 的下标 */
function matchScoreBandIndex(score) {
  for (let index = 0; index < MATCH_SCORE_BANDS.length; index += 1) {
    if (score >= MATCH_SCORE_BANDS[index].from) return index;
  }
  return MATCH_SCORE_BANDS.length - 1;
}

/** 评分定位的展示名；权重由后端 scoreRule 提供，前端只负责文案 */
const SCORE_ROLE_LABELS = {
  carry: '输出核心（法师/ADC/刺客）',
  support: '软辅 / 治疗',
  tank: '坦克 / 硬辅',
  fighter: '战士',
  default: '通用',
};

/** 官方英雄分类，评分弹窗里显示这只英雄具体是什么角色 */
const SCORE_CLASS_LABELS = {
  mage: '法师',
  marksman: '射手',
  assassin: '刺客',
  fighter: '战士',
  tank: '坦克',
  support: '辅助',
};

const SCORE_METRIC_LABELS = [
  ['kda', 'KDA'],
  ['kp', '参团'],
  ['damage', '输出'],
  ['taken', '承伤'],
  ['heal', '治疗'],
];

/** 短板扣分里“参团 + 另一项”的另一项，按主定位取 */
const SCORE_DEFICIT_LABELS = {
  carry: '输出',
  support: '治疗',
  tank: '承伤',
  fighter: '输出',
  default: '输出',
};

/** 本局评分点击说明：定位、五项权重占比和短板规则 */
function scoreTipHtml(payload) {
  const weights = payload.weights ?? {};
  const total = SCORE_METRIC_LABELS.reduce(
    (sum, [key]) => sum + (Number(weights[key]) || 0),
    0,
  );
  const rows = SCORE_METRIC_LABELS.map(([key, label]) => {
    const share = total > 0 ? ((Number(weights[key]) || 0) / total) * 100 : 0;
    return `<div class="score-tip-row"><span>${label}</span><i style="width:${share.toFixed(
      1,
    )}%"></i><b>${share.toFixed(0)}%</b></div>`;
  }).join('');
  const role = SCORE_ROLE_LABELS[payload.primary] ?? payload.primary ?? '通用';
  const secondary =
    payload.secondary && payload.secondary !== payload.primary
      ? ` · 副 ${SCORE_ROLE_LABELS[payload.secondary] ?? payload.secondary}`
      : '';
  const classes = Array.isArray(payload.classes) ? payload.classes : [];
  const classText = classes
    .map((value) => SCORE_CLASS_LABELS[value] ?? value)
    .filter(Boolean)
    .join(' / ');
  const positionText =
    POSITION_NAMES[String(payload.position ?? '').toLowerCase()] ?? '';
  const roleText = [
    positionText ? `本局位置 ${positionText}` : '',
    classText ? `英雄分类 ${classText}` : '',
    `评分定位 ${role}${secondary}`,
  ]
    .filter(Boolean)
    .map((part) => `<span>${escapeHtml(part)}</span>`)
    .join('');
  const deficit = SCORE_DEFICIT_LABELS[payload.primary] ?? '输出';
  const grade = payload.grade
    ? `<span class="score-tip-grade">${escapeHtml(payload.grade)}</span>`
    : '';
  const adjustments = Array.isArray(payload.adjustments) ? payload.adjustments : [];
  const adjustmentHtml = adjustments.length
    ? `<div class="score-tip-adjust">${adjustments
        .map(
          (item) =>
            `<span>${escapeHtml(item.label)}</span><b class="${
              Number(item.value) >= 0 ? 'up' : 'down'
            }">${Number(item.value) > 0 ? '+' : ''}${item.value}</b>`,
        )
        .join('')}</div>`
    : '';
  return `<div class="score-tip-head">
      <b style="color:${payload.color ?? '#8b9ac0'}">${summaryScore(payload.score)}</b>
      ${grade}
    </div>
    <div class="score-tip-role">${roleText}</div>
    ${adjustmentHtml}
    <div class="score-tip-bars">${rows}</div>
    <div class="score-tip-note">
      按本局 10 人的 KDA / 参团 / 输出 / 承伤 / 治疗百分位加权，主副定位按 7:3 混合。<br />
      输出位承伤低于本局中位时按中位计算，不会因为少挨打被扣分。<br />
      短板扣分：参团 + ${deficit}双低 -6；核心指标 2 项后 20% -4、3 项 -8；极端局封顶 12。
    </div>`;
}

/** 弹窗统一贴着锚点放，优先在上方，空间不够再落到下方 */
function placeTip(tip, anchor) {
  const rect = anchor.getBoundingClientRect();
  const size = tip.getBoundingClientRect();
  const margin = 10;
  const left = Math.min(
    Math.max(margin, rect.left + rect.width / 2 - size.width / 2),
    Math.max(margin, window.innerWidth - size.width - margin),
  );
  const above = rect.top - size.height - 10;
  const top = above >= margin ? above : rect.bottom + 10;
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
}

let scoreTipRing = null;

function hideScoreTip() {
  scoreTipRing = null;
  els.scoreTip?.classList.add('hidden');
}

function showScoreTip(ring) {
  if (!els.scoreTip || ring === scoreTipRing) return;
  let payload;
  try {
    payload = JSON.parse(ring.dataset.scoreTip);
  } catch {
    return;
  }
  // 同一时间只留一个弹窗，避免英雄说明和评分说明叠在一起
  hideInfoTip();
  scoreTipRing = ring;
  els.scoreTip.innerHTML = scoreTipHtml(payload);
  els.scoreTip.classList.remove('hidden');
  placeTip(els.scoreTip, ring);
}

/* ------------------------- 英雄/装备点击说明 ------------------------- */

/** 每级数值相同就只显示一次，否则列出 1 级到 5 级 */
function spellValuesText(values, suffix = '') {
  if (!Array.isArray(values) || !values.length) return '';
  const unique = [...new Set(values)];
  return `${unique.join(' / ')}${suffix}`;
}

/** 英雄：英雄名 + 官方角色 + 玩法标签 + 被动 + QWER（含每级冷却与消耗） */
function championTipHtml(info, anchorLabel = '') {
  if (!info) return '<div class="info-tip-empty">暂无英雄资料</div>';
  const roles = (info.roles ?? []).map((role) => SCORE_CLASS_LABELS[role] ?? role);
  const tags = info.tags ?? [];
  const passive = info.passive
    ? `<div class="info-tip-block">
        <span class="info-tip-label">被动</span>
        <div class="info-tip-row">${iconHtml(
          info.passive.icon,
          info.passive.name,
          'tip',
        )}<span><b>${escapeHtml(info.passive.name)}</b><em>${escapeHtml(
          info.passive.description,
        )}</em></span></div>
      </div>`
    : '';
  const spells = (info.spells ?? [])
    .map((spell) => {
      const cooldown = spellValuesText(spell.cooldown, ' 秒');
      const free = Array.isArray(spell.cost) && spell.cost.every((value) => value === 0);
      const cost = free ? '无消耗' : spellValuesText(spell.cost);
      const numbers = [
        cooldown ? `冷却 ${cooldown}` : '',
        cost ? `消耗 ${cost}` : '',
      ]
        .filter(Boolean)
        .join(' · ');
      return `<div class="info-tip-row">${iconHtml(
        spell.icon,
        spell.key || spell.name,
        'tip',
      )}<span><b>${escapeHtml(
        spell.key ? `${spell.key.toUpperCase()} · ${spell.name}` : spell.name,
      )}</b>${
        numbers ? `<small class="info-tip-numbers">${escapeHtml(numbers)}</small>` : ''
      }<em>${escapeHtml(spell.description)}</em></span></div>`;
    })
    .join('');
  const meta = [
    roles.length
      ? `<div class="info-tip-meta"><span>角色</span>${escapeHtml(roles.join(' / '))}</div>`
      : '',
    tags.length
      ? `<div class="info-tip-meta"><span>标签</span>${escapeHtml(tags.join(' / '))}</div>`
      : '',
  ]
    .filter(Boolean)
    .join('');
  return `<div class="info-tip-head">${escapeHtml(
    info.name || anchorLabel || '英雄',
  )}</div>${meta ? `<div class="info-tip-metas">${meta}</div>` : ''}${passive}${
    spells ? `<div class="info-tip-block">${spells}</div>` : ''
  }`;
}

/** 装备：描述已由后端去掉富文本标签，这里只负责转义和换行 */
function itemTipHtml(id) {
  const detail = state.itemDetails?.[String(id)];
  if (!detail) return '<div class="info-tip-empty">暂无装备资料</div>';
  const price = detail.price ? `<span class="info-tip-price">${detail.price} 金币</span>` : '';
  return `<div class="info-tip-head">${escapeHtml(detail.name || '装备')}${price}</div>${
    detail.description
      ? `<div class="info-tip-desc">${escapeHtml(detail.description)}</div>`
      : '<div class="info-tip-empty">暂无装备描述</div>'
  }`;
}

let infoTipAnchor = null;
let infoTipToken = 0;
let infoTipTitleTarget = null;
let infoTipTitleValue = '';

/** 有原生 title 的父元素会同时弹出浏览器提示，弹窗打开期间先收起来 */
function suppressNativeTitle(anchor) {
  const target = anchor.closest('[title]');
  if (!target) return;
  infoTipTitleTarget = target;
  infoTipTitleValue = target.getAttribute('title') ?? '';
  target.removeAttribute('title');
}

function restoreNativeTitle() {
  infoTipTitleTarget?.setAttribute('title', infoTipTitleValue);
  infoTipTitleTarget = null;
  infoTipTitleValue = '';
}

function hideInfoTip() {
  infoTipAnchor = null;
  infoTipToken += 1;
  restoreNativeTitle();
  els.infoTip?.classList.add('hidden');
}

async function showInfoTip(anchor) {
  if (!els.infoTip || anchor === infoTipAnchor) return;
  const champId = anchor.dataset.champId;
  const itemId = anchor.dataset.itemId;
  const kind = champId ? 'champ' : itemId ? 'item' : null;
  if (!kind) return;
  const id = Number(kind === 'champ' ? champId : itemId);
  if (!Number.isFinite(id) || id <= 0) return;

  const anchorLabel = anchor.getAttribute('title') ?? '';
  hideScoreTip();
  infoTipAnchor = anchor;
  restoreNativeTitle();
  suppressNativeTitle(anchor);
  const token = ++infoTipToken;
  els.infoTip.innerHTML = '<div class="info-tip-loading">加载中…</div>';
  els.infoTip.classList.remove('hidden');
  placeTip(els.infoTip, anchor);

  let html = '';
  if (kind === 'champ') {
    let info = await loadChampionInfo(id);
    // 客户端刚启动时资源可能还没就绪，停留在当前图标上时再试一次
    if (!info) {
      championInfoRetryAt.delete(id);
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      if (token !== infoTipToken || anchor !== infoTipAnchor) return;
      info = await loadChampionInfo(id);
    }
    html = championTipHtml(info, anchorLabel);
  } else {
    await loadItemDetails();
    html = itemTipHtml(id);
  }
  if (token !== infoTipToken || anchor !== infoTipAnchor) return;
  els.infoTip.innerHTML = html;
  placeTip(els.infoTip, anchor);
}

/** 时段统计看的是平均分，实际集中在 50-75，单独用更细的分段颜色 */
const TIME_STATS_SCORE_TONES = [
  { min: 75, className: 'avg-75', color: '#3ddc97' },
  { min: 70, className: 'avg-70', color: '#38bdf8' },
  { min: 65, className: 'avg-65', color: '#a3e635' },
  { min: 60, className: 'avg-60', color: '#ffe14d' },
  { min: 55, className: 'avg-55', color: '#ffb020' },
  { min: 50, className: 'avg-50', color: '#ff7a45' },
  { min: -Infinity, className: 'avg-low', color: '#ff4d6d' },
];

/** 评分排名徽标按名次取色：1–10 名从金到石板灰，颜色和字重逐级变淡变细 */
const RANK_TIERS = [
  'top', // 1
  'top', // 2
  'top', // 3
  'mid', // 4
  'mid', // 5
  'mid', // 6
  'low', // 7
  'low', // 8
  'min', // 9
  'min', // 10
];

function rankClass(rank) {
  const index = Math.min(Math.max(Number(rank) || 1, 1), RANK_TIERS.length);
  return `rank-tone-${index} rank-tier-${RANK_TIERS[index - 1]}`;
}

function ratingColor(rating, stats) {
  if (rating === null || rating === undefined) return '#5b6b8c';
  if (isInactiveKda(stats)) return '#7c8aa5';
  return RATING_TONES.find((tone) => rating >= tone.min)?.color ?? '#ff4d6d';
}

function hexToRgba(hex, alpha) {
  const normalized = hex.replace('#', '');
  const value = Number.parseInt(normalized, 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function pct(value, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
  return `${(Number(value) * 100).toFixed(digits)}%`;
}

/** 胜率：有小数时保留 1 位，整数时不显示 .0（如 50%、47.6%） */
function winRatePct(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
  const text = (Number(value) * 100).toFixed(1);
  return `${text.endsWith('.0') ? text.slice(0, -2) : text}%`;
}

function num(value, digits = 1, fallback = '-') {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return fallback;
  return Number(value).toFixed(digits);
}

function gameClock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

function kilo(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
  const number = Number(value);
  return number >= 1000 ? `${(number / 1000).toFixed(1)}<small>K</small>` : `${Math.round(number)}`;
}

function positionLabel(player, mode) {
  const gameMode = mode === undefined ? state.snapshot?.gameMode : mode;
  if (gameMode === 'ARAM') return '大乱斗';
  if (gameMode === 'ARENA') return '竞技场';
  if (player.position) return POSITION_NAMES[String(player.position).toLowerCase()] ?? player.position;
  const lane = player.games?.[0]?.position;
  return lane ? (LANE_NAMES[lane] ?? '补位') : '补位';
}

const POSITION_LANES = {
  top: 'TOP',
  jungle: 'JUNGLE',
  middle: 'MID',
  mid: 'MID',
  bottom: 'ADC',
  adc: 'ADC',
  utility: 'SUPPORT',
  support: 'SUPPORT',
};

function currentLaneOf(player) {
  const raw = String(player.position ?? '').toUpperCase();
  if (LANE_NAMES[raw]) return raw;
  const fromPosition = POSITION_LANES[String(player.position ?? '').toLowerCase()];
  if (fromPosition) return fromPosition;
  return player.games?.[0]?.position;
}

/** 当前分配位置与近期主玩位置不一致时给出提示 */
function mainPositionHint(player, mode) {
  if (mode === 'ARAM' || mode === 'ARENA') return '';
  const main = player.recent?.mainPosition;
  const share = player.recent?.mainPositionShare ?? 0;
  if (!main || share < 0.5) return '';
  const current = currentLaneOf(player);
  if (!current || current === main || current === 'UNKNOWN') return '';
  return `<span class="pos-main" title="近期 ${Math.round(
    share * 100,
  )}% 的对局走${LANE_NAMES[main] ?? main}">主玩${LANE_NAMES[main] ?? main}</span>`;
}

function rankLabel(rank) {
  if (!rank) return '未定级';
  const tier = TIER_NAMES[String(rank.tier).toUpperCase()] ?? rank.tier;
  const noDivision = ['大师', '宗师', '王者', '未定级'].includes(tier);
  const division = rank.division && !noDivision ? ` ${rank.division}` : '';
  const lp = Number(rank.leaguePoints) > 0 ? ` ${rank.leaguePoints}LP` : '';
  return `${tier}${division}${lp}`;
}

function champPath(championId) {
  return `/lol-game-data/assets/v1/champion-icons/${championId}.png`;
}

function iconHtml(assetPath, label, size, title, attrs = '') {
  const text = String(label ?? '?');
  const hue = hueFor(text);
  const image = assetPath
    ? `<img src="/api/asset?path=${encodeURIComponent(assetPath)}" alt="" loading="lazy" onerror="this.remove()" />`
    : '';
  return `<span class="icon ${size}"${attrs} title="${escapeHtml(
    title ?? '',
  )}" style="--hue:${hue}"><span class="fb">${escapeHtml(
    text.slice(0, 1),
  )}</span>${image}</span>`;
}

/** 英雄图标带上 id，点击时展示角色与技能 */
function champIconHtml(championId, label, size, title) {
  const id = Number(championId);
  const attrs = Number.isFinite(id) && id > 0 ? ` data-champ-id="${id}"` : '';
  return iconHtml(champPath(championId), label, size, title, attrs);
}

let itemIconsRequest = null;
let itemIconsRetryAt = 0;
function loadItemIcons() {
  // 已加载过且确实有数据就直接复用
  if (state.itemIcons && Object.keys(state.itemIcons).length) {
    return Promise.resolve(state.itemIcons);
  }
  if (itemIconsRequest) return itemIconsRequest;
  if (Date.now() < itemIconsRetryAt) return Promise.resolve(state.itemIcons ?? {});

  itemIconsRequest = fetch('/api/items', { cache: 'no-store' })
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .then((payload) => {
      const items =
        payload?.items && typeof payload.items === 'object' ? payload.items : {};
      if (!Object.keys(items).length) throw new Error('装备数据为空');
      state.itemIcons = items;
      itemIconsRetryAt = 0;
      refreshItemViews();
      return items;
    })
    .catch(() => {
      // 客户端可能还没连上，过几秒再重试，而不是永久显示数字
      itemIconsRetryAt = Date.now() + 5_000;
      return state.itemIcons ?? {};
    })
    .finally(() => {
      itemIconsRequest = null;
    });
  return itemIconsRequest;
}

let itemDetailsRequest = null;
let itemDetailsRetryAt = 0;
function loadItemDetails() {
  if (state.itemDetails && Object.keys(state.itemDetails).length) {
    return Promise.resolve(state.itemDetails);
  }
  if (itemDetailsRequest) return itemDetailsRequest;
  if (Date.now() < itemDetailsRetryAt) return Promise.resolve(null);

  itemDetailsRequest = fetch('/api/item-details', { cache: 'no-store' })
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .then((payload) => {
      const items = payload?.items && typeof payload.items === 'object' ? payload.items : {};
      if (!Object.keys(items).length) throw new Error('装备描述为空');
      state.itemDetails = items;
      itemDetailsRetryAt = 0;
      return items;
    })
    .catch(() => {
      itemDetailsRetryAt = Date.now() + 5_000;
      return null;
    })
    .finally(() => {
      itemDetailsRequest = null;
    });
  return itemDetailsRequest;
}

/** 点击某个英雄时才请求它的资料，结果按 id 缓存在内存里 */
const championInfoRequests = new Map();
const championInfoRetryAt = new Map();
function loadChampionInfo(id) {
  if (state.championInfo[id]) return Promise.resolve(state.championInfo[id]);
  if (championInfoRequests.has(id)) return championInfoRequests.get(id);
  if (Date.now() < (championInfoRetryAt.get(id) ?? 0)) return Promise.resolve(null);

  const request = fetch(`/api/champion-info?ids=${encodeURIComponent(id)}`, {
    cache: 'no-store',
  })
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .then((payload) => {
      const info = payload?.champions?.[String(id)] ?? null;
      if (info) state.championInfo[id] = info;
      championInfoRetryAt.delete(id);
      return info;
    })
    .catch(() => {
      championInfoRetryAt.set(id, Date.now() + 5_000);
      return null;
    })
    .finally(() => {
      championInfoRequests.delete(id);
    });
  championInfoRequests.set(id, request);
  return request;
}

function refreshItemViews() {
  if (state.matchDetail && state.matchTab === 'scoreboard') {
    renderScoreboard(state.matchDetail);
  }
  if (state.snapshot?.inGame && state.snapshot.players?.length) {
    cardCache.clear();
    render();
  }
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

function applySnapshot(snapshot) {
  // 服务端每 3 秒会推一次快照，数据没变时不要重绘，否则卡片动画会每 3 秒闪一下
  const signature = JSON.stringify({ ...snapshot, updatedAt: undefined });
  if (signature === state.snapshotSig) return;
  state.snapshotSig = signature;
  state.snapshot = snapshot;
  render();
}

function render() {
  const snapshot = state.snapshot;
  const players = snapshot?.players ?? [];
  const collecting = Boolean(snapshot?.collecting);
  const showSkeleton = !players.length && collecting;

  if (
    !snapshot?.inGame &&
    !snapshot?.inChampSelect &&
    (state.ai?.kind === 'live' || state.ai?.kind === 'champSelect')
  ) {
    resetAiView();
  }

  document.title = players.length ? `(${players.length}) 队友战绩 · LoL` : '队友战绩 · LoL';

  const hasAramChampions = Boolean(
    snapshot?.inChampSelect &&
      snapshot?.gameMode === 'ARAM' &&
      snapshot?.aramChampions?.length,
  );
  els.empty.classList.toggle(
    'hidden',
    players.length > 0 || showSkeleton || hasAramChampions,
  );
  els.board.classList.toggle('hidden', players.length === 0 && !showSkeleton);

  if (showSkeleton) {
    els.board.replaceChildren(...Array.from({ length: 5 }, () => skeletonCard()));
  } else if (players.length) {
    renderBoard(players);
  } else {
    els.board.replaceChildren();
    cardCache.clear();
  }

  renderAramChampions(snapshot);
  renderHeader(snapshot, players, collecting);
  renderEmpty(snapshot);
}

function renderBoard(players) {
  const localId = state.snapshot?.localPlayer?.summonerId;
  const localName = state.snapshot?.localPlayer?.displayName;
  const liveView = Boolean(state.snapshot?.inGame);
  const currentKeys = new Set([...els.board.children].map((node) => node.dataset.key));
  const nodes = players.map((player) => {
    const key = String(player.puuid ?? (player.summonerId || player.displayName));
    const isLocal = player.summonerId
      ? player.summonerId === localId
      : Boolean(localName && player.displayName === localName);
    const sig = `${key}|${isLocal}|${JSON.stringify(player)}`;
    const cached = cardCache.get(key);
    if (cached && cached.sig === sig) return cached.node;
    // 只有本局实时数据变化时，更新卡片里的实时区块即可；
    // 头像、历史战绩图标等静态内容保持不动，避免每 3 秒重建整块 DOM。
    const staticSig = `${key}|${isLocal}|${JSON.stringify({ ...player, live: undefined })}`;
    if (cached && cached.staticSig === staticSig && updateCardLive(cached.node, player)) {
      cached.sig = sig;
      return cached.node;
    }
    const node = buildCard(player, isLocal, {
      liveView,
      context: snapshotContext(),
    });
    node.dataset.key = key;
    // 只有新出现的卡片才播放入场动画，避免数据刷新时整块闪一下
    if (!currentKeys.has(key)) enterCard(node);
    cardCache.set(key, { sig, staticSig, node });
    return node;
  });

  const current = [...els.board.children];
  const sameOrder =
    current.length === nodes.length &&
    nodes.every((node, index) => current[index] === node);
  if (sameOrder) return;

  const currentOrder = current.map((node) => node.dataset.key).join('|');
  const nextOrder = nodes.map((node) => node.dataset.key).join('|');
  if (current.length !== nodes.length || currentOrder !== nextOrder) {
    els.board.replaceChildren(...nodes);
    return;
  }

  // 顺序没变时只替换真正变化的那张卡，其它卡片保持不动
  nodes.forEach((node, index) => {
    if (current[index] !== node) els.board.replaceChild(node, current[index]);
  });
}

/** 大乱斗选人阶段：当前英雄 + 替补席的整体/个人胜率 */
function renderAramChampions(snapshot) {
  const options = Array.isArray(snapshot?.aramChampions) ? snapshot.aramChampions : [];
  const show = Boolean(
    snapshot?.inChampSelect && snapshot?.gameMode === 'ARAM' && options.length,
  );
  els.aramPanel.classList.toggle('hidden', !show);
  if (!show) {
    els.aramList.replaceChildren();
    return;
  }

  els.aramHint.textContent = `当前英雄 + 替补席 ${options.length} 个 · 点击查看战绩，悬停看场次`;
  const nodes = options.map((option) => {
    const mine = option.games > 0 ? winRatePct(option.winRate) : '未使用';
    const overall = option.globalGames > 0 ? winRatePct(option.globalWinRate) : '-';
    const avgScore = Number(option.avgScore) || 0;
    const showScore = option.games > 0 && avgScore > 0;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `aram-champion${option.isCurrent ? ' current' : ''}`;
    button.title = `${option.championName}：本地存档整体 ${overall}${
      option.globalGames ? `（${option.globalGames} 场）` : ''
    }；我的 ${mine}${option.games ? `（${option.games} 场）` : ''}${
      showScore ? `，均分 ${avgScore.toFixed(1)}` : ''
    }`;
    button.innerHTML = `
      <span class="aram-champ-icon">${champIconHtml(
        option.championId,
        option.championName,
        'sm',
      )}</span>
      <span class="aram-champ-main">
        <span class="aram-champ-stats">
          <span class="aram-stat"><small>整体</small><b>${overall}</b></span>
          <span class="aram-stat mine"><small>我的</small><b>${mine}</b></span>
        </span>
        <span class="aram-champ-name">${escapeHtml(option.championName)}${
          option.isCurrent ? '<em class="aram-current">当前</em>' : ''
        }${option.isPriority ? '<em class="aram-priority">优先</em>' : ''}</span>
        ${
          showScore
            ? `<span class="aram-score" title="我的平均评分"><small>均分</small><b style="color:${ratingColor(
                avgScore,
              )}">${avgScore.toFixed(1)}</b></span>`
            : ''
        }
      </span>
    `;
    button.addEventListener('click', () =>
      openChampionMatches(option.championId, option.championName, { mode: 'ARAM' }),
    );
    return button;
  });
  els.aramList.replaceChildren(...nodes);
}

function enterCard(node) {
  node.classList.add('enter');
  node.addEventListener('animationend', () => node.classList.remove('enter'), {
    once: true,
  });
}

function skeletonCard() {
  const node = document.createElement('div');
  node.className = 'skeleton';
  return node;
}

/** 本局实时数据（每 3 秒会变）：单独抽出来，命中缓存时只刷新这一块 */
function liveRowsHtml(live, visionGame) {
  const liveExtras = [];
  if (live?.summonerSpells?.length) {
    liveExtras.push(`召唤师技能 ${live.summonerSpells.join(' / ')}`);
  }
  if (live?.runes) liveExtras.push(`符文 ${live.runes}`);
  if (live?.respawnTimer) liveExtras.push(`复活 ${Math.ceil(live.respawnTimer)}s`);
  if (live?.health !== undefined && live?.maxHealth !== undefined) {
    liveExtras.push(`血量 ${Math.round(live.health)}/${Math.round(live.maxHealth)}`);
  }
  if (
    live?.resourceValue !== undefined &&
    live?.resourceMax !== undefined &&
    live.resourceType !== 'NONE'
  ) {
    const label = live.resourceType === 'ENERGY' ? '能量' : '蓝量';
    liveExtras.push(`${label} ${Math.round(live.resourceValue)}/${Math.round(live.resourceMax)}`);
  }
  if (live?.currentGold !== undefined) liveExtras.push(`金币 ${kilo(live.currentGold)}`);
  if (live?.abilities?.length) {
    liveExtras.push(
      `技能 ${live.abilities.map((ability) => `${ability.key}${ability.level}`).join(' ')}`,
    );
  }
  const liveExtraRow = liveExtras.length
    ? `<div class="live-extra">${liveExtras.map((item) => escapeHtml(item)).join(' · ')}</div>`
    : '';
  const liveRow = live
    ? `<div class="live-row">
        <span class="live-tag">本局</span>
        <span class="live-kda">${live.kills} / <b class="loss">${live.deaths}</b> / ${live.assists}</span>
        <span class="live-stat">补刀 <b>${Math.round(live.cs ?? 0)}</b></span>
        <span class="live-stat">等级 <b>${live.championLevel ?? '-'}</b></span>
        ${
          live.gold !== undefined
            ? `<span class="live-stat">装备价值 <b>${kilo(live.gold)}</b></span>`
            : ''
        }
        ${
          visionGame
            ? `<span class="live-stat">视野 <b>${num(live.wardScore, 0)}</b></span>`
            : ''
        }
        ${live.isDead ? '<span class="live-dead">已阵亡</span>' : ''}
      </div>${liveExtraRow}`
    : '';
  return liveRow;
}

function liveMetricsHtml(live, visionGame) {
  if (!live) return '';
  return `<div class="metrics live-metrics">
      <div class="metric"><span>参团率</span><b>${pct(live.killParticipation)}</b></div>
      <div class="metric"><span>分均经济</span><b>${
        live.goldPerMin === undefined ? '-' : Math.round(live.goldPerMin)
      }</b></div>
      <div class="metric"><span>分均补刀</span><b>${num(live.csPerMin, 1)}</b></div>
      ${
        visionGame
          ? `<div class="metric"><span>分均视野</span><b>${num(live.visionPerMin, 2)}</b></div>`
          : ''
      }
      <div class="metric"><span>KDA</span><b>${num(live.kda, 2)}</b></div>
      <div class="metric"><span>队伍击杀</span><b>${live.teamKills ?? '-'}</b></div>
      <div class="metric pending-metric" title="官方实时接口不提供伤害与承伤，对局结算后才会出现在「本局详情」里">
        <span>伤害 / 承伤</span><b>结算后</b>
      </div>
    </div>`;
}

/** 装备图标行；装备数据可能比页面晚到（客户端刚启动），看到装备格时再补拉一次 */
function itemIconsHtml(itemIds) {
  if (!itemIds?.length) return '';
  if (!(state.itemIcons && Object.keys(state.itemIcons).length)) {
    void loadItemIcons();
  }
  return `<div class="items">${itemIds
    .map((itemId) => {
      const meta = state.itemIcons?.[String(itemId)];
      const attrs = ` data-item-id="${Number(itemId) || 0}"`;
      return iconHtml(meta?.icon ?? null, meta?.name ?? String(itemId), 'sm', meta?.name, attrs);
    })
    .join('')}</div>`;
}

function isVisionGameMode(mode) {
  return mode !== 'ARAM' && mode !== 'ARENA';
}

function buildCard(player, isLocal, options = {}) {
  const recent = player.recent;
  const games = player.games ?? [];
  // 对局详情里展示的是“本局评分”，而不是近期综合评分
  const thisGame = options.thisGame;
  const rating = thisGame?.score ?? player.rating;
  const grade = thisGame?.grade ?? player.grade;
  const color = ratingColor(rating, thisGame);
  // 本局评分排名：名次直接叠在评分环上，不占用卡片布局高度
  const rank = Number.isFinite(options.rank) ? options.rank : null;
  const rankBadge =
    rank !== null
      ? `<span class="ring-rank ${rankClass(rank)}" title="本局评分排名第 ${rank}${
          options.rankTotal ? ` / ${options.rankTotal}` : ''
        }">#${rank}</span>`
      : '';
  // 本局评分点击说明：带上这一局真实的定位和权重
  const scoreTipAttr =
    thisGame?.scoreRule && Number.isFinite(Number(rating))
      ? ` data-score-tip="${escapeHtml(
          JSON.stringify({
            score: rating,
            grade,
            color,
            position: thisGame.position,
            ...thisGame.scoreRule,
          }),
        )}"`
      : '';
  // 近期平均排名：只在展示近期综合数据的卡片上出现，对局详情的本局卡片用评分环上的单场名次
  const avgRankValue = !thisGame ? Number(player.recent?.avgRank) : Number.NaN;
  const avgRank =
    Number.isFinite(avgRankValue) && avgRankValue > 0 ? avgRankValue : null;
  const avgRankGames = Number(player.recent?.avgRankGames) || 0;
  const avgRankTone = avgRank !== null ? rankClass(Math.round(avgRank)) : null;
  const avgRankLine =
    avgRank !== null
      ? `<div class="avg-rank-line ${avgRankTone}" title="最近 ${avgRankGames || '若干'} 场平均评分排名第 ${avgRank.toFixed(
          1,
        )} 名（双方 10 人）">
          <span class="avg-rank-label">平均排名</span>
          <b class="avg-rank-value">#${avgRank.toFixed(1)}</b>
          <span class="avg-rank-sample">近 ${avgRankGames || '若干'} 场</span>
        </div>`
      : '';
  const name = player.displayName ?? '未知召唤师';
  const tag = player.tagLine;
  const rawLabels = thisGame ? thisGame.tags ?? [] : player.labels ?? [];
  const bestTag = thisGame
    ? rawLabels.includes('MVP')
      ? 'MVP'
      : rawLabels.includes('SVP')
        ? 'SVP'
        : null
    : null;
  const badTag = thisGame
    ? options.badTag ??
      rawLabels.find(
        (label) => label === '巨坑' || label === '很坑' || label === '坑' || label === '小坑',
      ) ??
      null
    : null;
  const labels = rawLabels
    .filter(
      (label) =>
        label !== 'MVP' &&
        label !== 'SVP' &&
        label !== '巨坑' &&
        label !== '很坑' &&
        label !== '坑' &&
        label !== '小坑',
    )
    .slice(0, 5);
  const risk = recent?.risk;
  const risky = Boolean(risk && (risk.level === 'high' || risk.level === 'severe'));
  const pitGames = Number.isFinite(Number(recent?.pitGames))
    ? Number(recent.pitGames)
    : risk?.badGames ?? 0;
  const baseline = player.baseline;
  const championStats = player.championStats;
  const cardMode = options.mode === undefined ? state.snapshot?.gameMode : options.mode;
  const modeName = options.modeLabel ?? currentModeLabel();
  // 大乱斗/竞技场没有常规眼位，不展示视野相关指标
  const visionGame = cardMode !== 'ARAM' && cardMode !== 'ARENA';

  const card = document.createElement('article');
  card.className = `card${isLocal ? ' is-local' : ''}${
    options.liveView ? ' metrics-collapsed' : ''
  }${!thisGame && risk?.level === 'severe' ? ' is-risk' : ''}${
    player.isEnemy ? ' is-enemy' : ''
  }${
    bestTag === 'MVP' ? ' is-mvp' : bestTag === 'SVP' ? ' is-svp' : ''
  }${
    badTag === '巨坑'
      ? ' is-bad-severe'
      : badTag === '很坑' || badTag === '坑'
        ? ' is-bad'
        : badTag === '小坑'
          ? ' is-bad-mild'
          : ''
  }`;
  card.style.setProperty('--ring-color', color);
  card.style.setProperty('--ring-glow', hexToRgba(color, 0.2));

  const profilePath = player.profileIconId
    ? `/lol-game-data/assets/v1/profile-icons/${player.profileIconId}.jpg`
    : null;

  const streak =
    !thisGame && recent?.streak && recent.streak.count >= 2
      ? `<span class="dot-sep">·</span><span>${recent.streak.count}${recent.streak.type === 'win' ? '连胜' : '连败'}</span>`
      : '';

  // 与个人长期基线比较：只看明显偏离，接近均值时轻描淡写
  const baselineChip = baseline
    ? baseline.z >= 1
      ? `<span class="chip baseline up" title="历史 ${baseline.games} 场均分 ${baseline.avgScore}">高于自身 +${baseline.z.toFixed(1)}σ</span>`
      : baseline.z <= -1
        ? `<span class="chip baseline down" title="历史 ${baseline.games} 场均分 ${baseline.avgScore}">低于自身 ${baseline.z.toFixed(1)}σ</span>`
        : `<span class="chip muted-chip" title="历史 ${baseline.games} 场均分 ${baseline.avgScore}">接近自身水平</span>`
    : '';

  const chips = labels.length || baselineChip
    ? `<div class="chips">${labels
        .map((label) => {
          const danger = [
            '很坑',
            '坑',
            '小坑',
            '巨坑',
            '偏坑',
            '有点坑',
            '疑似新手',
            '伤害过低',
            '常挂机',
            '疑似挂机',
            '逃跑',
          ].includes(label);
          const gold = label === '大腿' || label === 'MVP';
          const svp = label === 'SVP';
          const afkChip = label === '逃跑';
          const afkTitle =
            afkChip && thisGame?.afkReason
              ? ` title="${escapeHtml(thisGame.afkReason)}"`
              : '';
          return `<span class="chip${gold ? ' gold' : ''}${svp ? ' svp' : ''}${
            afkChip ? ' afk-chip' : danger ? ' danger' : ''
          }"${afkTitle}>${escapeHtml(label)}</span>`;
        })
        .join('')}${baselineChip}</div>`
    : !thisGame && recent
      ? `<div class="chips"><span class="chip muted-chip">近况平稳</span></div>`
      : '';

  const bestBadge = bestTag
    ? `<span class="best-badge detail-best ${bestTag === 'MVP' ? 'mvp' : 'svp'}">${bestTag}</span>`
    : '';
  const badBadge = badTag
    ? `<span class="detail-bad-badge ${
        badTag === '巨坑' ? 'severe' : badTag === '很坑' || badTag === '坑' ? 'bad' : 'mild'
      }">${badTag}</span>`
    : '';

  const record = thisGame
    ? `本局 · <b class="${thisGame.win ? 'win' : 'loss'}">${thisGame.win ? '胜' : '负'}</b> · ${
        durationMinutes(thisGame.durationMin) ?? '-'
      } 分钟`
    : recent
      ? `${modeName} ${recent.games} 场 · <b class="win">${recent.wins}胜</b> <b class="loss">${recent.losses}负</b> · 胜率 ${winRatePct(
          recent.winRate,
        )}`
      : '暂无战绩数据';

  const riskPill = !thisGame && risk && risky
    ? `<span class="risk-pill ${risk.level}" title="${escapeHtml(risk.reasons.join('；'))}">坑指数 ${risk.score}</span>`
    : '';
  const riskNote =
    risky && risk.reasons.length
      ? `<div class="risk-note"><span class="risk-label">${
          risk.level === 'severe' ? '高风险' : '注意'
        }</span><span>${escapeHtml(risk.reasons.join(' · '))}</span></div>`
      : '';

  const afkNote = recent?.afkGames
    ? `<div class="afk-note">⚠ 近 ${recent.games} 场有 ${recent.afkGames} 场疑似挂机（数据推断，仅供参考）</div>`
    : '';

  const gameChips = games
    .slice(0, 10)
    .map((game) => {
      const title = `${game.win ? '胜' : '负'} · ${game.championName} · ${game.kills}/${game.deaths}/${game.assists} · 评分 ${game.score} · ${game.queueName}`;
      return `<div class="game ${game.win ? 'win' : 'loss'}" title="${escapeHtml(
        title,
      )}">${champIconHtml(game.championId, game.championName, 'chip')}<span class="res">${
        game.win ? 'W' : 'L'
      }</span></div>`;
    })
    .join('');

  const pitMetric = recent
    ? `<div class="metric bad-metric${
        pitGames / Math.max(1, recent.games) >= 0.5 ? ' is-high' : ''
      }" title="近 ${recent.games} 场中 ${pitGames} 场单场评分 < 35，包含小坑 / 很坑 / 巨坑"><span>坑场次</span><b>${pitGames} / ${recent.games}</b></div>`
    : '';
  const metricCells = recent
    ? [
        `<div class="metric"><span>近期胜率</span><b>${winRatePct(recent.winRate)}</b></div>`,
        `<div class="metric"><span>KDA</span><b>${num(recent.avgKda, 2)}</b></div>`,
        `<div class="metric"><span>参团率</span><b>${pct(recent.avgKillParticipation)}</b></div>`,
        `<div class="metric"><span>分均伤害</span><b>${Math.round(recent.avgDamagePerMin ?? 0)}</b></div>`,
        `<div class="metric"><span>伤害占比</span><b>${pct(recent.avgDamageShare)}</b></div>`,
        `<div class="metric"><span>分均补刀</span><b>${num(recent.avgCsPerMin, 1)}</b></div>`,
        visionGame
          ? `<div class="metric"><span>分均视野</span><b>${num(recent.avgVisionPerMin, 2)}</b></div>`
          : '',
        `<div class="metric"><span>场均死亡</span><b>${num(recent.avgDeaths, 1)}</b></div>`,
        `<div class="metric"><span>场均伤害</span><b>${kilo(recent.avgDamage)}</b></div>`,
        `<div class="metric"><span>场均治疗</span><b>${kilo(recent.avgHeal ?? 0)}</b></div>`,
        recent.afkGames
          ? `<div class="metric afk-metric"><span>疑似挂机</span><b>${recent.afkGames} 场</b></div>`
          : '',
      ].join('')
    : '';

  // 对局阶段卡片太高：除坑场次外，其余指标默认收起，点按钮再展开
  const metricsSummary = options.liveView
    ? `<div class="metrics-summary">${pitMetric}<button type="button" class="metrics-toggle" data-action="metrics" aria-expanded="false">展开其余指标</button></div>`
    : '';
  const metrics = recent
    ? options.liveView
      ? `<div class="metrics recent-metrics">${metricCells}</div>`
      : `<div class="metrics">${metricCells}${risk ? pitMetric : ''}</div>`
    : '';

  // 大乱斗英雄随机，“常用英雄”没有参考意义
  const champions = cardMode !== 'ARAM' && recent?.topChampions?.length
    ? `<div class="champs"><span>常用</span>${recent.topChampions
        .map(
          (champion) =>
            `<span class="champ-mini">${champIconHtml(
              champion.championId,
              champion.name,
              'sm',
            )}<b>${escapeHtml(champion.name)}</b><em>${champion.games}场 ${winRatePct(champion.winRate)}</em></span>`,
        )
        .join('')}</div>`
    : '';

  const sparkBlock = !thisGame ? scoreSparkline(games) : '';

  const championUsage =
    !thisGame && championStats && championStats.games > 0
      ? `<div class="champ-usage">
          <span class="champ-usage-label">本英雄</span>
          <b>${championStats.games} 场</b>
          <span>胜率 ${winRatePct(championStats.winRate)}</span>
          <span>均分 ${num(championStats.avgScore, 1)}</span>
          ${
            championStats.bestScore
              ? `<span class="muted">最高 ${num(championStats.bestScore, 0)}</span>`
              : ''
          }
        </div>`
      : '';

  const detail = games.length && !thisGame
    ? `<button class="btn matches-btn" type="button" data-action="matches">查看最近 ${games.length} 场战绩</button>`
    : '';

  // 本人当前英雄（选人阶段的当前选择 / 对局详情里本局使用的英雄）的专属战绩
  const championId = thisGame?.championId ?? player.championId;
  const championName = thisGame?.championName ?? player.championName;
  const showChampionMatches = Boolean(isLocal && championId && !player.isBot);
  const pickedContent = `${champIconHtml(
    championId,
    championName ?? '?',
    'champ',
  )}<span class="champ-name">${escapeHtml(championName ?? '未选英雄')}</span>${
    showChampionMatches ? '<span class="champ-link-hint">战绩</span>' : ''
  }`;
  const picked = showChampionMatches
    ? `<button class="picked champ-link" type="button" data-action="champion-matches" title="查看 ${escapeHtml(
        championName ?? '该英雄',
      )} 的战绩" aria-label="查看 ${escapeHtml(
        championName ?? '该英雄',
      )} 的战绩">${pickedContent}</button>`
    : `<div class="picked">${pickedContent}</div>`;

  const error = player.error
    ? `<div class="card-error">${escapeHtml(player.error)}</div>`
    : '';

  const loading =
    player.loading && !recent
      ? '<div class="card-loading"><span class="spinner"></span>正在读取近期战绩…</div>'
      : '';

  const live = player.live;

  const gameRow = thisGame
    ? `<div class="live-row this-game-row ${thisGame.win ? 'win' : 'loss'}">
        <span class="live-kda">${thisGame.kills} / <b class="loss">${thisGame.deaths}</b> / ${thisGame.assists}</span>
        <span class="live-stat">补刀 <b>${thisGame.cs}</b></span>
        ${
          visionGame
            ? `<span class="live-stat">视野 <b>${thisGame.vision}</b></span>`
            : ''
        }
      </div>`
    : '';

  const radarBlock =
    thisGame && options.radar?.length
      ? `<div class="card-radar" title="${escapeHtml(
          options.radar.map((item) => item.title).join('；'),
        )}">${miniRadarSvg(options.radar)}</div>`
      : '';

  // 结算接口有 timeline 时，展示每 10 分钟的经济/对位补刀差
  const timeline = thisGame?.timeline;
  let timelinePhase = '';
  if (timeline && timeline.csDiffEarly !== undefined && timeline.csDiffLate !== undefined) {
    if (timeline.csDiffEarly <= -3 && timeline.csDiffLate >= 0) {
      timelinePhase = '对线落后，中后期追回';
    } else if (timeline.csDiffEarly >= 3 && timeline.csDiffLate <= 0) {
      timelinePhase = '前期领先，中后期被追';
    }
  }
  const timelineBlock =
    timeline && Array.isArray(timeline.segments) && timeline.segments.length
      ? `<div class="timeline-row">
          ${timeline.segments
            .slice(0, 4)
            .map(
              (segment) =>
                `<span class="timeline-seg"><em>${segment.startMin}-${segment.endMin}分</em><b>${kilo(
                  segment.goldPerMin,
                )}</b>${
                  segment.csDiffPerMin === undefined
                    ? ''
                    : `<i class="${segment.csDiffPerMin >= 0 ? 'up' : 'down'}">补刀差 ${
                        segment.csDiffPerMin >= 0 ? '+' : ''
                      }${num(segment.csDiffPerMin, 1)}</i>`
                }</span>`,
            )
            .join('')}
          ${
            timeline.idleMinutes >= 5
              ? `<span class="timeline-idle">中段 ${Math.round(
                  timeline.idleMinutes,
                )} 分钟几乎没有成长</span>`
              : ''
          }
          ${timelinePhase ? `<span class="timeline-phase">${timelinePhase}</span>` : ''}
        </div>`
      : '';

  const itemRow = thisGame ? itemIconsHtml(thisGame.items) : '';

  const thisGameMetrics = thisGame
    ? `<div class="metrics">
        <div class="metric"><span>分均伤害</span><b>${Math.round(thisGame.damagePerMin ?? 0)}</b></div>
        <div class="metric"><span>分均承伤</span><b>${Math.round(thisGame.damageTakenPerMin ?? 0)}</b></div>
        <div class="metric"><span>分均补刀</span><b>${num(thisGame.csPerMin, 1)}</b></div>
        <div class="metric"><span>分均经济</span><b>${Math.round(thisGame.goldPerMin ?? 0)}</b></div>
        ${
          visionGame
            ? `<div class="metric"><span>分均视野</span><b>${num(thisGame.visionPerMin, 2)}</b></div>`
            : ''
        }
      </div>`
    : '';

  const liveItems = itemIconsHtml(live?.items);
  const liveBlock =
    !thisGame && options.liveView && live
      ? `<div class="card-live" data-live-slot><div data-live-stats>${liveRowsHtml(
          live,
          visionGame,
        )}${liveMetricsHtml(live, visionGame)}</div>${
          liveItems ? `<div data-live-items>${liveItems}</div>` : ''
        }</div>`
      : '';

  card.innerHTML = `
    <div class="card-head">
      <div class="avatar-wrap">
        ${iconHtml(profilePath, name, 'avatar')}
        ${player.level ? `<span class="level">${player.level}</span>` : ''}
      </div>
      <div class="ident">
        <div class="name-row">
          <span class="name">${escapeHtml(name)}${
            tag ? `<span class="tag">#${escapeHtml(tag)}</span>` : ''
          }</span>
          ${isLocal ? '<span class="you-badge">你</span>' : ''}
          ${player.isBot ? '<span class="bot-badge">人机</span>' : ''}
        </div>
        <div class="sub">
          <span class="pos-pill">${escapeHtml(positionLabel(player, cardMode))}</span>
          ${!thisGame ? mainPositionHint(player, cardMode) : ''}
          ${player.isEnemy ? '<span class="side-badge enemy">敌方</span>' : ''}
          ${
            Number(player.premadeSize) >= 2
              ? `<span class="premade-badge" title="${
                  player.premadeSource === 'session'
                    ? `与另外 ${Number(player.premadeSize) - 1} 名玩家一起组队进入本局`
                    : `最近战绩中与另外 ${Number(player.premadeSize) - 1} 名玩家多次同队开局`
                }">开黑 ${Number(player.premadeSize)} 人</span>`
              : ''
          }
          <span>${escapeHtml(rankLabel(player.rank))}</span>
          ${streak}
        </div>
      </div>
      ${picked}
    </div>

    <div class="score-row">
      <div class="ring${!thisGame && player.loading && !recent ? ' loading' : ''}" style="--p:${rating ?? 0};--ring:${color}"${scoreTipAttr}>
        ${rankBadge}
        <div class="ring-inner"><b>${rating ?? '--'}</b><small>${thisGame ? '本局评分' : '评分'}</small></div>
      </div>
      <div class="score-meta">
        <div class="meta-top">
          ${bestBadge}
          ${badBadge}
          <span class="grade">${grade ?? '?'}</span>
          ${thisGame ? chips : `<span class="record">${record}</span>${riskPill}`}
        </div>
        ${thisGame ? '' : chips}
      </div>
    </div>

    ${thisGame ? '' : avgRankLine}
    ${thisGame ? gameRow : liveBlock}
    ${thisGame ? radarBlock : ''}
    ${thisGame ? timelineBlock : ''}
    ${thisGame ? thisGameMetrics : ''}
    ${thisGame ? itemRow : ''}
    ${thisGame ? '' : gameChips ? `<div class="games">${gameChips}</div>` : ''}
    ${thisGame ? '' : sparkBlock}
    ${thisGame ? '' : loading}
    ${thisGame ? '' : metricsSummary}
    ${thisGame ? '' : metrics}
    ${thisGame ? '' : riskNote}
    ${thisGame ? '' : afkNote}
    ${thisGame ? '' : championUsage}
    ${thisGame ? '' : champions}
    ${thisGame ? '' : error}
    ${detail}
  `;
  const liveSlot = card.querySelector('[data-live-slot]');
  if (liveSlot) liveSlot.dataset.items = (live?.items ?? []).join(',');
  const matchesButton = card.querySelector('[data-action="matches"]');
  if (matchesButton) {
    matchesButton.addEventListener('click', () => openMatches(player, options.context));
  }
  const metricsToggle = card.querySelector('[data-action="metrics"]');
  if (metricsToggle) {
    metricsToggle.addEventListener('click', () => {
      const collapsed = card.classList.toggle('metrics-collapsed');
      metricsToggle.textContent = collapsed ? '展开其余指标' : '收起其余指标';
      metricsToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    });
  }
  const championLinkEl = card.querySelector('[data-action="champion-matches"]');
  if (championLinkEl) {
    championLinkEl.addEventListener('click', () =>
      openChampionMatches(championId, championName),
    );
  }

  return card;
}

/** 命中缓存、只有实时数据变化时，原地刷新本局区块，不重建头像和历史战绩图标 */
function updateCardLive(node, player) {
  const slot = node.querySelector('[data-live-slot]');
  const live = player.live;
  if (!slot || !live) return false;
  const visionGame = isVisionGameMode(state.snapshot?.gameMode);
  const stats = slot.querySelector('[data-live-stats]');
  if (stats) {
    stats.innerHTML = `${liveRowsHtml(live, visionGame)}${liveMetricsHtml(live, visionGame)}`;
  }
  // 装备只在真正变化时才重画，避免每轮重建图标
  const itemsKey = (live.items ?? []).join(',');
  if (slot.dataset.items !== itemsKey) {
    const itemsHtml = itemIconsHtml(live.items);
    let holder = slot.querySelector('[data-live-items]');
    if (itemsHtml) {
      if (!holder) {
        holder = document.createElement('div');
        holder.dataset.liveItems = '';
        slot.append(holder);
      }
      holder.innerHTML = itemsHtml;
    } else {
      holder?.remove();
    }
    slot.dataset.items = itemsKey;
  }
  return true;
}

function renderHeader(snapshot, players, collecting) {
  const phase = snapshot?.phase ?? 'None';
  const label = PHASE_LABELS[phase] ?? phase;
  els.phase.textContent = label;
  els.phase.classList.toggle('phase-select', phase === 'ChampSelect');
  els.phase.classList.toggle(
    'phase-game',
    phase === 'InProgress' || phase === 'WaitingForStats' || phase === 'EndOfGame',
  );

  els.mode.classList.toggle('hidden', snapshot?.mode !== 'demo');
  const canChampSelectAi = Boolean(
    snapshot?.inChampSelect &&
      !collecting &&
      players.length > 0 &&
      snapshot.localPlayer,
  );
  const canLiveAi = Boolean(
    snapshot?.inGame && players.length > 0 && snapshot.localPlayer,
  );
  els.liveAi.classList.toggle('hidden', !(canChampSelectAi || canLiveAi));
  setAiButton(Boolean(state.ai?.running));
  if (snapshot?.region) {
    els.region.textContent = String(snapshot.region).toUpperCase();
    els.region.classList.remove('hidden');
  } else {
    els.region.classList.add('hidden');
  }

  if (!snapshot) {
    els.status.textContent = '正在连接客户端…';
  } else if (snapshot.inChampSelect) {
    if (collecting) {
      const total = players.length;
      const loaded = players.filter((player) => !player.loading).length;
      els.status.textContent = total
        ? `正在读取队友战绩… ${loaded}/${total}`
        : '正在读取队友战绩…';
    } else {
      const risky = players.filter(
        (player) => player.recent?.risk && player.recent.risk.level === 'severe',
      ).length;
      els.status.textContent = `${players.length} 名队友 · 数据已更新${
        risky ? ` · ${risky} 人高风险` : ''
      }`;
    }
  } else if (snapshot.inGame) {
    const allies = players.filter((player) => !player.isEnemy).length;
    const enemies = players.filter((player) => player.isEnemy).length;
    if (!players.length) {
      els.status.textContent = snapshot.message ?? '游戏进行中，等待对局数据…';
    } else if (collecting) {
      const loaded = players.filter((player) => !player.loading).length;
      els.status.textContent = `正在读取本局 10 名玩家战绩… ${loaded}/${players.length}`;
    } else {
      const risky = players.filter(
        (player) => player.recent?.risk && player.recent.risk.level === 'severe',
      ).length;
      const clock = snapshot.gameTime ? `${gameClock(snapshot.gameTime)} · ` : '';
      els.status.textContent = `本局 ${allies} 己方 / ${enemies} 敌方 · ${clock}实时数据${
        risky ? ` · ${risky} 人高风险` : ''
      }`;
    }
  } else {
    els.status.textContent = snapshot.message ?? PHASE_TITLES[phase] ?? '等待进入选人阶段…';
  }

  els.updated.textContent = snapshot?.updatedAt
    ? `更新 ${new Date(snapshot.updatedAt).toLocaleTimeString('zh-CN', { hour12: false })}`
    : '';

  if (snapshot?.error) {
    els.notice.textContent = snapshot.error;
    els.notice.classList.remove('hidden');
  } else {
    els.notice.classList.add('hidden');
  }

  const recent = players.find((player) => player.recent)?.recent;
  if (snapshot?.inChampSelect) {
    // 选人阶段 LCU 不返回对手身份，避免用户误以为漏读
    els.recentHint.textContent = recent
      ? `${currentModeLabel()}最近 ${recent.games} 场 · 评分 0-100 · 对手战绩进入对局后显示`
      : '选人阶段无法读取对手身份，进入对局后显示双方 10 人';
  } else {
    els.recentHint.textContent = recent
      ? `${currentModeLabel()}最近 ${recent.games} 场 · 评分 0-100`
      : snapshot?.inGame
        ? '本局实时数据 · 伤害与承伤需对局结算后才有'
        : '';
  }
}

function renderEmpty(snapshot) {
  if (!snapshot) return;
  const phase = snapshot.phase ?? 'None';
  if ((snapshot.inChampSelect || snapshot.inGame) && snapshot.players?.length) return;

  els.emptyIcon.textContent = PHASE_ICONS[phase] ?? '⌛';
  if (snapshot.inChampSelect) {
    els.emptyTitle.textContent = snapshot.collecting ? '正在读取队友战绩…' : '选人阶段';
    els.emptyDesc.textContent = snapshot.message ?? '正在准备队友数据…';
    return;
  }
  if (snapshot.inGame) {
    els.emptyTitle.textContent = '游戏进行中';
    els.emptyDesc.textContent = snapshot.message ?? '正在读取本局队友数据…';
    return;
  }
  els.emptyTitle.textContent = PHASE_TITLES[phase] ?? '等待进入选人阶段';
  els.emptyDesc.textContent =
    snapshot.message ??
    '启动英雄联盟客户端并进入选人阶段，这里会自动展示 5 名队友的近期战绩与评分。';
}

/* ------------------------------------------------------------------ */
/* 数据连接                                                            */
/* ------------------------------------------------------------------ */

function setLive(live) {
  state.live = live;
  els.liveDot.classList.toggle('offline', !live);
  els.liveDot.title = live ? '实时连接正常' : '实时连接断开，正在重连…';
  if (!live && state.snapshot) {
    els.status.textContent = '实时连接断开，正在重连…';
  }
}

async function fetchSnapshot() {
  try {
    const response = await fetch('/api/snapshot', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    applySnapshot(await response.json());
    setLive(true);
  } catch {
    setLive(false);
  }
}

function connectStream() {
  if (!('EventSource' in window)) {
    setInterval(fetchSnapshot, 5000);
    return;
  }

  const source = new EventSource('/api/stream');
  source.addEventListener('snapshot', (event) => {
    try {
      applySnapshot(JSON.parse(event.data));
      setLive(true);
    } catch {
      /* 忽略异常数据帧 */
    }
  });
  // 服务重启后复用已打开的页签：直接刷新当前页面，不再新开标签
  source.addEventListener('reload', () => {
    window.location.reload();
  });
  source.onopen = () => setLive(true);
  source.onerror = () => setLive(false);
}

async function refresh() {
  if (state.refreshing) return;
  state.refreshing = true;
  els.refresh.disabled = true;
  els.refresh.classList.add('spinning');
  els.notice.classList.add('hidden');

  try {
    const response = await fetch('/api/refresh', { method: 'POST' });
    const payload = await response.json().catch(() => ({}));
    if (payload?.snapshot) applySnapshot(payload.snapshot);
    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.error ?? `HTTP ${response.status}`);
    }
  } catch (error) {
    els.notice.textContent = `刷新失败：${error instanceof Error ? error.message : String(error)}`;
    els.notice.classList.remove('hidden');
    setTimeout(() => {
      if (!state.snapshot?.error) els.notice.classList.add('hidden');
    }, 5000);
  } finally {
    state.refreshing = false;
    els.refresh.disabled = false;
    els.refresh.classList.remove('spinning');
  }
}

/* ------------------------------------------------------------------ */
/* 玩家查询                                                            */
/* ------------------------------------------------------------------ */

function closeSearch() {
  els.searchPanel.classList.add('hidden');
  els.searchBoard.replaceChildren();
  state.searchPlayers = [];
  els.searchStatus.textContent = '';
  els.searchStatus.classList.remove('error');
}

function formatGameTime(value) {
  const date = new Date(Number(value));
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function stopLoadingTimer() {
  if (state.loadingTimer) {
    clearInterval(state.loadingTimer);
    state.loadingTimer = null;
  }
}

function setMatchProgress(text) {
  if (!els.matchProgress) return;
  els.matchProgress.textContent = text || '';
  els.matchProgress.classList.toggle('hidden', !text);
}

function beginMatchesLoading(text) {
  stopLoadingTimer();
  const started = Date.now();
  state.loadingProgress = null;
  els.matchesSummary?.classList.add('hidden');
  els.matchesRangeTabs?.classList.add('hidden');
  els.matchesList.className = 'match-list';
  els.matchesList.innerHTML = `<div class="search-status"><span class="spinner"></span><span class="match-loading">${escapeHtml(
    text,
  )}</span></div>`;
  const render = () => {
    const label = els.matchesList.querySelector('.match-loading');
    if (!label) return;
    const progress = state.loadingProgress;
    const suffix = progress?.total ? ` ${progress.done}/${progress.total}` : '';
    const seconds = Math.floor((Date.now() - started) / 1000);
    label.textContent = `${text}${suffix} · 已用时 ${seconds}s`;
  };
  render();
  state.loadingTimer = setInterval(render, 500);
}

async function readNdjson(response, onEvent) {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) onEvent(JSON.parse(line));
      index = buffer.indexOf('\n');
    }
  }
  const tail = buffer.trim();
  if (tail) onEvent(JSON.parse(tail));
}

/* ------------------------------------------------------------------ */
/* 本局 AI 分析                                                        */
/* ------------------------------------------------------------------ */

const AI_CONFIG_HINT =
  '在项目根目录的 .env 中设置 LOL_MATE_AI_API_KEY=你的 OpenCode Go API Key，然后重启面板。默认使用 deepseek-v4.1-flash。';

/** 对局中追问的预设问题；点一下就直接问，不用整篇重新分析 */
const AI_LIVE_QUESTIONS = [
  '现在最该做的 3 件事',
  '下一件装备出什么',
  '对面谁最肥，怎么针对',
  '这波团该不该接',
  '我怎么站位才能少死',
];

/** 同一局关闭弹窗再打开时保留追问节点 */
const liveFollowUpsBySession = new Map();

function liveFollowUpsFor(sessionKey) {
  if (!sessionKey) return [];
  let list = liveFollowUpsBySession.get(sessionKey);
  if (!list) {
    list = [];
    liveFollowUpsBySession.set(sessionKey, list);
  }
  return list;
}

/** 当前弹窗正在展示实时对局内容时，返回可用于追问的 sessionKey */
function aiAskSessionKey(ai, showLive) {
  if (!showLive || !state.snapshot?.inGame) return null;
  const key = ai.kind === 'live' ? ai.sessionKey : ai.live?.sessionKey;
  return key && key === state.snapshot.liveSessionId ? key : null;
}

function initAiAskChips() {
  els.aiAskChips.replaceChildren(
    ...AI_LIVE_QUESTIONS.map((question) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ai-ask-chip';
      button.textContent = question;
      button.addEventListener('click', () => void askLiveFollowUp(question));
      return button;
    }),
  );
}

function setAiButton(running) {
  const champSelect = Boolean(state.snapshot?.inChampSelect);
  const label = champSelect ? '✨ AI 选人' : '✨ AI 分析';
  for (const button of [els.matchesAi, els.liveAi]) {
    button.disabled = Boolean(running);
    button.classList.toggle('loading', Boolean(running));
    button.innerHTML = running
      ? '<span class="spinner"></span>分析中…'
      : button === els.liveAi
        ? label
        : '✨ AI 分析';
  }
  els.matchesAi.title = running
    ? '正在生成 AI 复盘分析…'
    : state.aiStatus?.enabled === false
      ? 'AI 分析未配置：在 .env 设置 LOL_MATE_AI_API_KEY 后重启面板'
      : `用 AI 复盘本局（${state.aiStatus?.model ?? 'DeepSeek V4.1 Flash'}）`;
  els.liveAi.title = running
    ? champSelect
      ? '正在生成选人建议…'
      : '正在生成出装和打法建议…'
    : state.aiStatus?.enabled === false
      ? 'AI 分析未配置：在 .env 设置 LOL_MATE_AI_API_KEY 后重启面板'
      : champSelect
        ? `AI 选人建议：阵容、符文、召唤师技能和出装（${state.aiStatus?.model ?? 'DeepSeek V4.1 Flash'}）`
        : `AI 出装、技能与打法建议（${state.aiStatus?.model ?? 'DeepSeek V4.1 Flash'}）`;
}

function hideAiView() {
  els.aiModal.classList.add('hidden');
}

function resetAiView() {
  state.ai?.controller?.abort();
  for (const list of liveFollowUpsBySession.values()) {
    for (const entry of list) {
      if (!entry.controller) continue;
      entry.controller.abort();
      entry.controller = null;
      entry.running = false;
    }
  }
  stopAiTimer();
  state.ai = null;
  els.aiBody.replaceChildren();
  els.aiMeta.textContent = '';
  els.aiModalTitle.textContent = '✨ AI 复盘';
  els.aiRerun.classList.add('hidden');
  els.aiTabs.classList.add('hidden');
  hideAiView();
  setAiButton(false);
}

function showAiView() {
  els.aiModal.classList.remove('hidden');
}

function stopAiTimer() {
  if (state.aiTimer) {
    clearInterval(state.aiTimer);
    state.aiTimer = null;
  }
}

function renderAiMeta(ai) {
  const elapsed = ai.started
    ? Math.max(0, Math.floor((Date.now() - ai.started) / 1000))
    : 0;
  els.aiMeta.textContent = ai.running
    ? `分析中… ${elapsed}s`
    : ai.error
      ? '失败'
      : ai.cached
        ? `${ai.model ?? 'AI'} · 已保存 ${formatGameTime(ai.savedAt)}`
        : `${ai.model ?? 'AI'} · 用时 ${elapsed}s${ai.saved ? ' · 已保存' : ''}`;
}

function startAiTimer(ai) {
  stopAiTimer();
  state.aiTimer = setInterval(() => {
    if (state.ai !== ai || !ai.running) {
      stopAiTimer();
      return;
    }
    if (activeAiTab(ai) !== 'live') renderAiMeta(ai);
  }, 1000);
}

/** 判断纯文本编号行是不是 AI 输出的一级章节标题 */
function isAiSectionLine(index, text) {
  const number = Number(index);
  const title = String(text ?? '').trim();
  if (!Number.isInteger(number) || number < 1 || number > 12 || !title) return false;
  const beforeColon = title.split(/[：:]/)[0].trim();
  if (beforeColon && beforeColon.length <= 18 && beforeColon.length < title.length) {
    return true;
  }
  return title.length <= 18 && !/[。；;]/.test(title);
}

function aiMarkdown(text) {
  const lines = escapeHtml(text).split(/\r?\n/);
  let html = '';
  let blockOpen = false;

  const closeBlock = () => {
    if (!blockOpen) return;
    html += '</section>';
    blockOpen = false;
  };
  const openBlock = (index, title) => {
    closeBlock();
    html += `<section class="ai-block"><h3 class="ai-block-title">${
      index ? `<span class="ai-block-no">${index}</span>` : ''
    }<span>${title}</span></h3>`;
    blockOpen = true;
  };

  for (const raw of lines) {
    let line = raw.trimEnd();
    if (!line.trim()) {
      if (!blockOpen) html += '<div class="ai-gap"></div>';
      continue;
    }
    line = line
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');

    const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const content = heading[2].trim();
      const numbered = /^(\d+)[.、)]\s*(.*)$/.exec(content);
      if (level <= 2) {
        openBlock(numbered ? numbered[1] : '', numbered ? numbered[2] : content);
      } else {
        html += `<h4 class="ai-subtitle">${content}</h4>`;
      }
      continue;
    }

    const numbered = /^\s*(\d+)[.、)]\s*(.*)$/.exec(line);
    if (numbered && isAiSectionLine(numbered[1], numbered[2])) {
      const content = numbered[2].trim();
      const colon = content.search(/[：:]/);
      if (colon > 0 && colon <= 18) {
        openBlock(numbered[1], content.slice(0, colon).trim());
        const rest = content.slice(colon + 1).trim();
        if (rest) html += `<p>${rest}</p>`;
      } else {
        openBlock(numbered[1], content);
      }
      continue;
    }
    if (numbered) {
      html += `<p class="ai-num"><span>${numbered[1]}</span>${numbered[2]}</p>`;
      continue;
    }

    const bullet = /^(\s*)[-*•]\s+(.*)$/.exec(line);
    if (bullet) {
      const nested = bullet[1].length >= 2 ? ' nested' : '';
      html += `<p class="ai-bullet${nested}">${bullet[2]}</p>`;
      continue;
    }

    html += `<p>${line.trim()}</p>`;
  }

  closeBlock();
  return html;
}

function followAnswerHtml(entry) {
  if (entry.error) return `<div class="ai-error">${escapeHtml(entry.error)}</div>`;
  if (!entry.answer) {
    return `<div class="ai-status"><span class="spinner"></span><span>${escapeHtml(
      entry.status ?? '正在思考…',
    )}</span></div>`;
  }
  const cursor = entry.running ? '<span class="ai-cursor"></span>' : '';
  return `<div class="ai-content">${aiMarkdown(entry.answer)}${cursor}</div>`;
}

/** 单个追问节点：问题在上，回答增量追加在下 */
function followUpHtml(entry, index) {
  return `<section class="ai-follow${entry.running ? ' running' : ''}" id="ai-follow-${index}" data-follow-index="${index}">
      <div class="ai-follow-q"><span class="ai-follow-no">Q${index + 1}</span><span>${escapeHtml(
        entry.question,
      )}</span></div>
      <div class="ai-follow-a" data-follow-answer="${index}">${followAnswerHtml(entry)}</div>
    </section>`;
}

function followUpsHtml(list) {
  if (!list.length) return '';
  return `<div class="ai-follows">${list.map(followUpHtml).join('')}</div>`;
}

function renderAiNodes(ai) {
  const list = ai?.followUps ?? [];
  els.aiNodeList.innerHTML = list.length
    ? list
        .map(
          (entry, index) =>
            `<button type="button" class="ai-node${entry.running ? ' running' : ''}" data-ai-node="${index}">
              <span class="ai-node-no">${index + 1}</span>
              <span class="ai-node-text">${escapeHtml(entry.question)}</span>
            </button>`,
        )
        .join('')
    : '<p class="ai-nodes-empty">还没有追问<br />点下方问题或自己输入</p>';
}

function renderAiAskPanel(ai, sessionKey) {
  const visible = Boolean(sessionKey);
  els.aiAsk.classList.toggle('hidden', !visible);
  els.aiNodes.classList.toggle('hidden', !visible);
  if (!visible) return;
  const blocked = Boolean(ai.running || ai.askRunning);
  els.aiAskInput.disabled = blocked;
  els.aiAskSend.disabled = blocked;
  for (const chip of els.aiAskChips.querySelectorAll('button')) chip.disabled = blocked;
  renderAiNodes(ai);
}

/** 流式回答时只更新当前节点，避免整块重新渲染打断阅读 */
function updateFollowEntry(ai, entry) {
  if (state.ai !== ai) return;
  const index = (ai.followUps ?? []).indexOf(entry);
  if (index < 0) return;
  const holder = els.aiBody.querySelector(`[data-follow-answer="${index}"]`);
  if (!holder) {
    renderAiView();
    return;
  }
  const nearBottom =
    els.aiBody.scrollHeight - els.aiBody.scrollTop - els.aiBody.clientHeight < 120;
  holder.innerHTML = followAnswerHtml(entry);
  holder.closest('.ai-follow')?.classList.toggle('running', Boolean(entry.running));
  renderAiNodes(ai);
  if (nearBottom) els.aiBody.scrollTop = els.aiBody.scrollHeight;
}

function scrollToFollow(index) {
  const section = els.aiBody.querySelector(`[data-follow-index="${index}"]`);
  if (!section) return;
  section.scrollIntoView({ block: 'start', behavior: 'smooth' });
  section.classList.add('flash');
  window.setTimeout(() => section.classList.remove('flash'), 1200);
}

/** 对局中追问：把回答增量追加到现有分析下方，不重新生成整篇 */
async function askLiveFollowUp(rawQuestion) {
  const ai = state.ai;
  if (!ai || ai.askRunning) return;
  const question = String(rawQuestion ?? '').trim().slice(0, 120);
  if (!question) return;
  const showLive = ai.kind === 'live' || activeAiTab(ai) === 'live';
  const sessionKey = aiAskSessionKey(ai, showLive);
  if (!sessionKey) return;

  const list = ai.followUps ?? (ai.followUps = liveFollowUpsFor(sessionKey));
  const entry = {
    question,
    answer: '',
    status: '正在整理实时数据…',
    error: '',
    running: true,
    controller: new AbortController(),
  };
  list.push(entry);
  ai.askRunning = true;
  els.aiAskInput.value = '';
  renderAiView();
  scrollToFollow(list.length - 1);

  try {
    const response = await fetch('/api/live/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
      signal: entry.controller.signal,
      cache: 'no-store',
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload?.error ?? `HTTP ${response.status}`);
    }
    await readNdjson(response, (event) => {
      if (state.ai !== ai || entry.controller?.signal.aborted) return;
      if (event.type === 'status') {
        entry.status = event.text ?? '';
        updateFollowEntry(ai, entry);
      } else if (event.type === 'delta') {
        entry.answer += event.text ?? '';
        entry.status = '';
        updateFollowEntry(ai, entry);
      } else if (event.type === 'done') {
        entry.running = false;
        entry.status = '';
        if (!entry.answer.trim()) entry.error = 'AI 没有返回内容，请再问一次。';
        updateFollowEntry(ai, entry);
      } else if (event.type === 'error') {
        throw new Error(event.error ?? 'AI 追问失败');
      }
    });
    if (entry.running) {
      entry.running = false;
      if (!entry.answer.trim()) entry.error = 'AI 没有返回内容，请再问一次。';
    }
  } catch (error) {
    if (!entry.controller?.signal.aborted) {
      entry.error = error instanceof Error ? error.message : String(error);
      entry.running = false;
    }
  } finally {
    entry.controller = null;
    if (state.ai === ai) {
      ai.askRunning = false;
      renderAiView();
    }
  }
}

function activeAiTab(ai) {
  return ai.live?.content && ai.tab === 'live' ? 'live' : 'match';
}

function renderAiView() {
  const ai = state.ai;
  if (!ai) return;
  const body = els.aiBody;
  if (!body) return;

  const hasLive = Boolean(ai.kind === 'match' && ai.live?.content?.trim());
  const tab = activeAiTab(ai);
  const liveTab = tab === 'live';
  const showLive = ai.kind === 'live' || liveTab;
  const askSessionKey = aiAskSessionKey(ai, showLive);
  const followUps = ai.followUps ?? [];

  els.aiModalTitle.textContent = ai.title
    ? `✨ ${ai.kind === 'champSelect' ? 'AI 选人建议' : 'AI 复盘'} · ${ai.title}`
    : `✨ ${ai.kind === 'champSelect' ? 'AI 选人建议' : 'AI 复盘'}`;
  els.aiTabs.classList.toggle('hidden', !hasLive);
  if (hasLive) {
    for (const button of els.aiTabs.querySelectorAll('[data-ai-tab]')) {
      button.classList.toggle('active', button.dataset.aiTab === tab);
    }
  }

  const canRerun = !ai.running;
  els.aiRerun.classList.toggle('hidden', !canRerun);
  els.aiRerun.disabled = ai.running;
  els.aiRerun.textContent =
    ai.kind === 'champSelect'
      ? '重新生成'
      : liveTab && !String(ai.text ?? '').trim()
        ? '生成赛后复盘'
        : '重新分析';

  if (liveTab) {
    const savedAt = ai.live.savedAt ? ` · 对局中保存 ${formatGameTime(ai.live.savedAt)}` : '';
    els.aiMeta.textContent = `${ai.live.model ?? ai.model ?? 'AI'}${savedAt}`;
  } else {
    renderAiMeta(ai);
  }
  const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
  const keepScroll = body.scrollTop;
  if (liveTab) {
    body.innerHTML = `<div class="ai-content">${aiMarkdown(ai.live.content)}</div>${followUpsHtml(followUps)}<div class="ai-foot">这段建议来自对局进行中的实时数据，赛后不会再更新</div>`;
  } else if (ai.error) {
    const hint = state.aiStatus?.enabled === false ? `<p class="ai-hint">${escapeHtml(AI_CONFIG_HINT)}</p>` : '';
    body.innerHTML = `<div class="ai-error">${escapeHtml(ai.error)}</div>${hint}`;
  } else if (!ai.text) {
    body.innerHTML = ai.running
      ? `<div class="ai-status"><span class="spinner"></span><span>${escapeHtml(
          ai.status ?? '正在分析…',
        )}</span></div>`
      : '<div class="ai-error">AI 没有返回正式内容（可能推理被截断），请点「重新分析」再试一次。</div>';
  } else {
    const cursor = ai.running ? '<span class="ai-cursor"></span>' : '';
    const foot =
      ai.running && ai.status
        ? `<div class="ai-foot">${escapeHtml(ai.status)}</div>`
        : `<div class="ai-foot">${
            ai.kind === 'champSelect'
              ? '内容由 AI 根据选人阶段数据生成，敌方阵容未知，仅供参考'
              : '内容由 AI 根据本局数据生成，仅供参考'
          }</div>`;
    const follows = ai.kind === 'live' ? followUpsHtml(followUps) : '';
    body.innerHTML = `<div class="ai-content">${aiMarkdown(ai.text)}${cursor}</div>${follows}${foot}`;
  }
  renderAiAskPanel(ai, askSessionKey);
  body.scrollTop = nearBottom ? body.scrollHeight : keepScroll;
}

async function loadSavedAiAnalysis(gameId) {
  try {
    const response = await fetch(`/api/match/${gameId}/ai`, { cache: 'no-store' });
    if (!response.ok) return null;
    const payload = await response.json().catch(() => ({}));
    const valid = (analysis) =>
      analysis && typeof analysis.content === 'string' && analysis.content.trim()
        ? analysis
        : null;
    const analysis = valid(payload?.analysis);
    const liveAnalysis = valid(payload?.liveAnalysis);
    if (!analysis && !liveAnalysis) return null;
    return { analysis, liveAnalysis };
  } catch {
    return null;
  }
}

function liveAiMeta(analysis) {
  if (!analysis?.content) return null;
  return {
    content: analysis.content,
    model: analysis.model || state.aiStatus?.model,
    savedAt: Number(analysis.createdAt) || 0,
    sessionKey: analysis.sessionKey,
  };
}

async function streamAiAnalysis(url, meta) {
  state.ai?.controller?.abort();
  const controller = new AbortController();
  const ai = {
    ...meta,
    followUps: meta.followUps ?? [],
    controller,
    text: '',
    status: '正在连接 AI 服务…',
    error: '',
    model: state.aiStatus?.model,
    running: true,
    done: false,
    started: Date.now(),
  };
  state.ai = ai;
  showAiView();
  setAiButton(true);
  renderAiView();
  startAiTimer(ai);

  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload?.error ?? `HTTP ${response.status}`);
    }

    let finished = false;
    await readNdjson(response, (event) => {
      if (event.type === 'status') {
        ai.status = event.text ?? '';
        renderAiView();
      } else if (event.type === 'progress') {
        ai.status = `正在读取玩家战绩 ${event.done}/${event.total}…`;
        renderAiView();
      } else if (event.type === 'delta') {
        ai.text += event.text ?? '';
        ai.status = '';
        renderAiView();
      } else if (event.type === 'done') {
        finished = true;
        ai.running = false;
        ai.done = true;
        ai.status = '';
        ai.saved = Boolean(event.saved);
        ai.savedAt = Date.now();
        ai.model = event.model ?? ai.model;
        if (!ai.text.trim()) {
          ai.error = 'AI 没有返回正式内容（可能推理被截断），请点「重新分析」再试一次。';
        }
        renderAiView();
      } else if (event.type === 'error') {
        throw new Error(event.error ?? 'AI 分析失败');
      }
    });
    if (!finished && !ai.error) {
      if (!ai.text) throw new Error('AI 没有返回内容');
      ai.running = false;
      ai.done = true;
      ai.status = '';
      renderAiView();
    }
  } catch (error) {
    if (controller.signal.aborted) return;
    ai.error = error instanceof Error ? error.message : String(error);
    ai.running = false;
    ai.status = '';
    renderAiView();
  } finally {
    ai.running = false;
    ai.controller = null;
    if (state.ai === ai) {
      stopAiTimer();
      setAiButton(false);
    }
  }
}

async function runAiAnalysis(options = {}) {
  const detail = state.matchDetail;
  if (!detail) return;
  const gameId = Number(detail.gameId);
  if (!Number.isFinite(gameId) || gameId <= 0) return;

  const existing = state.ai;
  if (
    !options.force &&
    existing &&
    existing.kind === 'match' &&
    existing.gameId === gameId &&
    !existing.error
  ) {
    // 已经分析过（或正在分析）这场，直接打开弹窗，避免重复请求
    showAiView();
    renderAiView();
    return;
  }
  if (state.aiLoading) return;

  const title = detail.queueName ?? '对局';
  let live = existing?.kind === 'match' && existing.gameId === gameId ? existing.live : null;

  if (!options.force) {
    state.aiLoading = true;
    try {
      const saved = await loadSavedAiAnalysis(gameId);
      if (state.matchDetail?.gameId !== gameId) return;
      live = liveAiMeta(saved?.liveAnalysis) ?? live;
      if (saved?.analysis) {
        state.ai = {
          kind: 'match',
          gameId,
          title,
          controller: null,
          text: saved.analysis.content,
          live,
          followUps: live?.sessionKey ? liveFollowUpsFor(live.sessionKey) : [],
          tab: 'match',
          status: '',
          error: '',
          model: saved.analysis.model || state.aiStatus?.model,
          running: false,
          done: true,
          cached: true,
          savedAt: saved.analysis.createdAt,
          started: 0,
        };
        showAiView();
        renderAiView();
        return;
      }
      // 还没有赛后复盘，但有比赛中的建议：先展示建议，避免白等一次 AI 请求
      if (live) {
        state.ai = {
          kind: 'match',
          gameId,
          title,
          controller: null,
          text: '',
          live,
          followUps: live?.sessionKey ? liveFollowUpsFor(live.sessionKey) : [],
          tab: 'live',
          status: '',
          error: '',
          model: live.model || state.aiStatus?.model,
          running: false,
          done: false,
          cached: true,
          savedAt: live.savedAt,
          started: 0,
        };
        showAiView();
        renderAiView();
        return;
      }
    } finally {
      state.aiLoading = false;
    }
  } else {
    // 重新生成赛后复盘时，也刷新一下已经保存的对局中建议（不会重新请求 AI）
    try {
      const saved = await loadSavedAiAnalysis(gameId);
      live = liveAiMeta(saved?.liveAnalysis) ?? live;
    } catch {
      /* 忽略：没有对局中建议时继续正常分析 */
    }
  }

  await streamAiAnalysis(`/api/match/${gameId}/ai`, {
    kind: 'match',
    gameId,
    title,
    live,
    followUps: live?.sessionKey ? liveFollowUpsFor(live.sessionKey) : [],
    tab: 'match',
  });
}

async function loadSavedLiveAiAnalysis() {
  try {
    const response = await fetch('/api/live/ai', { cache: 'no-store' });
    if (!response.ok) return null;
    const payload = await response.json().catch(() => ({}));
    const analysis = payload?.analysis;
    if (!analysis || typeof analysis.content !== 'string' || !analysis.content.trim()) {
      return null;
    }
    return analysis;
  } catch {
    return null;
  }
}

function liveAiTitle(snapshot) {
  const players = snapshot.players ?? [];
  const local = snapshot.localPlayer;
  const self =
    (local?.summonerId
      ? players.find((player) => player.summonerId === local.summonerId)
      : undefined) ?? players.find((player) => !player.isEnemy);
  const champion = self?.championName ?? local?.championName ?? '本局';
  return `${champion} · 本局出装与打法`;
}

function champSelectAiTitle(snapshot) {
  const players = snapshot.players ?? [];
  const local = snapshot.localPlayer;
  const self =
    (local?.summonerId
      ? players.find((player) => player.summonerId === local.summonerId)
      : undefined) ?? players.find((player) => !player.isEnemy);
  const champion = self?.championName ?? local?.championName ?? '本局';
  return `${champion} · 选人阶段`;
}

async function runChampSelectAiAnalysis(options = {}) {
  const snapshot = state.snapshot;
  if (!snapshot?.inChampSelect || !snapshot.players?.length || !snapshot.localPlayer) {
    return;
  }
  const title = champSelectAiTitle(snapshot);

  const existing = state.ai;
  if (!options.force && existing && existing.kind === 'champSelect' && !existing.error) {
    showAiView();
    renderAiView();
    return;
  }
  if (state.aiLoading) return;

  await streamAiAnalysis('/api/champ-select/ai', { kind: 'champSelect', title });
}

async function runLiveAiAnalysis(options = {}) {
  const snapshot = state.snapshot;
  if (snapshot?.inChampSelect) {
    await runChampSelectAiAnalysis(options);
    return;
  }
  if (
    !snapshot?.inGame ||
    !snapshot.players?.length ||
    !snapshot.liveSessionId ||
    !snapshot.localPlayer
  ) {
    return;
  }
  const sessionKey = snapshot.liveSessionId;
  const title = liveAiTitle(snapshot);

  if (options.force) {
    for (const entry of state.ai?.followUps ?? []) entry.controller?.abort();
    liveFollowUpsBySession.delete(sessionKey);
  }
  const existing = state.ai;
  if (!options.force && existing && existing.kind === 'live' && !existing.error) {
    showAiView();
    renderAiView();
    return;
  }
  if (state.aiLoading) return;

  if (!options.force) {
    state.aiLoading = true;
    try {
      const saved = await loadSavedLiveAiAnalysis();
      if (state.snapshot?.liveSessionId !== sessionKey) return;
      if (saved) {
        state.ai = {
          kind: 'live',
          sessionKey,
          title,
          controller: null,
          text: saved.content,
          followUps: liveFollowUpsFor(sessionKey),
          status: '',
          error: '',
          model: saved.model || state.aiStatus?.model,
          running: false,
          done: true,
          cached: true,
          savedAt: saved.createdAt,
          started: 0,
        };
        showAiView();
        renderAiView();
        return;
      }
    } finally {
      state.aiLoading = false;
    }
  }

  await streamAiAnalysis('/api/live/ai', {
    kind: 'live',
    sessionKey,
    title,
    followUps: liveFollowUpsFor(sessionKey),
  });
}

async function loadAiStatus() {
  try {
    const response = await fetch('/api/ai/status', { cache: 'no-store' });
    const payload = await response.json().catch(() => ({}));
    if (response.ok && payload?.ok !== false) state.aiStatus = payload;
  } catch {
    state.aiStatus = null;
  }
  setAiButton(false);
}

function matchFlagsHtml(tags) {
  return (tags ?? [])
    .map((tag) => {
      if (tag === '重开') {
        return `<b class="match-flag remake">${escapeHtml(tag)}</b>`;
      }
      if (tag === 'MVP') {
        return '<b class="match-flag mvp">MVP</b>';
      }
      if (tag === 'SVP') {
        return '<b class="match-flag svp">SVP</b>';
      }
      if (tag === '队友逃跑' || tag === '对手逃跑') {
        return `<b class="match-flag ${tag === '队友逃跑' ? 'afk' : 'enemy-afk'}">${escapeHtml(
          tag,
        )}</b>`;
      }
      const badMatch = /^(队友|敌方|自己)(小坑|很坑|坑|巨坑)$/.exec(tag);
      if (badMatch) {
        const side = badMatch[1];
        const level = badMatch[2] === '巨坑' ? 'severe' : badMatch[2] === '小坑' ? 'mild' : 'bad';
        const sideClass =
          side === '敌方' ? 'enemy-bad' : side === '自己' ? 'self-bad' : 'teammate-bad';
        return `<b class="match-flag ${sideClass} ${level}">${escapeHtml(tag)}</b>`;
      }
      return escapeHtml(tag);
    })
    .join(' / ');
}

function afkPlayerLabel(player) {
  const champion = player.championName ?? '未知英雄';
  const reason = player.reason ? ` · ${player.reason}` : '';
  return `${champion}（${player.name}${reason}）`;
}

function renderMatchFlags(detail) {
  const tags = detail.tags ?? [];
  const afk = detail.afkPlayers ?? [];
  const parts = [];
  if (tags.includes('重开')) {
    parts.push('<span class="match-flag remake">重开</span>');
  }
  if (tags.includes('自己逃跑')) {
    parts.push('<span class="match-flag self-afk">自己逃跑</span>');
  }
  const allies = afk.filter((player) => !player.isEnemy);
  const enemies = afk.filter((player) => player.isEnemy);
  if (allies.length) {
    parts.push(
      `<span class="match-flag afk">队友逃跑：${allies
        .map((player) => escapeHtml(afkPlayerLabel(player)))
        .join('、')}</span>`,
    );
  } else if (tags.includes('队友逃跑')) {
    parts.push('<span class="match-flag afk">队友逃跑</span>');
  }
  if (enemies.length) {
    parts.push(
      `<span class="match-flag enemy-afk">对手逃跑：${enemies
        .map((player) => escapeHtml(afkPlayerLabel(player)))
        .join('、')}</span>`,
    );
  } else if (tags.includes('对手逃跑')) {
    parts.push('<span class="match-flag enemy-afk">对手逃跑</span>');
  }
  const hasAfk =
    afk.length > 0 ||
    tags.some(
      (tag) => tag === '自己逃跑' || tag === '队友逃跑' || tag === '对手逃跑',
    );
  els.matchFlags.classList.toggle('has-afk', hasAfk);
  els.matchFlags.innerHTML = parts.join('');
  els.matchFlags.classList.toggle('hidden', parts.length === 0);
}

function renderMatchSummary(detail) {
  if (!els.matchSummary) return;
  const scoreboard = Array.isArray(detail.scoreboard) ? detail.scoreboard : [];
  const allies = scoreboard.filter((player) => !player.isEnemy);
  const enemies = scoreboard.filter((player) => player.isEnemy);
  if (!allies.length || !enemies.length) {
    clearMatchSummary();
    return;
  }

  const int = (value) => Math.round(Number(value) || 0).toLocaleString('zh-CN');
  const sum = (rows, key) =>
    rows.reduce((total, player) => total + (Number(player[key]) || 0), 0);
  const durationMin = Math.max(0, Math.round((Number(detail.gameDuration) || 0) / 60));
  const win = Boolean(allies[0]?.win);
  const metrics = [
    { key: 'kills', label: '击杀', better: 'high' },
    { key: 'assists', label: '助攻', better: 'high' },
    { key: 'damage', label: '总伤害', better: 'high' },
    { key: 'damageTaken', label: '总承伤', better: 'neutral' },
    { key: 'heal', label: '总治疗', better: 'high' },
    { key: 'gold', label: '总经济', better: 'high' },
  ];

  const cells = metrics
    .map((metric) => {
      const ally = sum(allies, metric.key);
      const enemy = sum(enemies, metric.key);
      const max = Math.max(ally, enemy, 1);
      const allyWidth = (ally / max) * 100;
      const enemyWidth = (enemy / max) * 100;
      const allyBetter =
        metric.better === 'high'
          ? ally > enemy
          : metric.better === 'low'
            ? ally < enemy
            : false;
      const enemyBetter =
        metric.better === 'high'
          ? enemy > ally
          : metric.better === 'low'
            ? enemy < ally
            : false;
      return `<div class="compare-metric">
        <div class="compare-name">${metric.label}</div>
        <div class="compare-line ally${allyBetter ? ' better' : ''}">
          <b class="compare-value">${int(ally)}</b>
          <span class="compare-track"><i style="width:${allyWidth.toFixed(1)}%"></i></span>
        </div>
        <div class="compare-line enemy${enemyBetter ? ' better' : ''}">
          <b class="compare-value">${int(enemy)}</b>
          <span class="compare-track"><i style="width:${enemyWidth.toFixed(1)}%"></i></span>
        </div>
      </div>`;
    })
    .join('');

  if (els.matchMeta) {
    els.matchMeta.innerHTML = `
      <span>时间 ${escapeHtml(formatGameTime(detail.gameCreation))}</span>
      ${durationMin ? `<span>时长 ${durationMin} 分钟</span>` : ''}
      <span>结果 <b class="${win ? 'win' : 'loss'}">${win ? '胜' : '负'}</b></span>
      <span class="team-summary-legend">
        <i class="ally"></i>我方
        <i class="enemy"></i>敌方
      </span>
    `;
    els.matchMeta.classList.remove('hidden');
  }
  els.matchSummary.innerHTML = `<div class="team-summary-grid">${cells}</div>`;
  els.matchSummary.classList.remove('hidden');
}

function clearMatchSummary() {
  if (els.matchMeta) {
    els.matchMeta.innerHTML = '';
    els.matchMeta.classList.add('hidden');
  }
  if (!els.matchSummary) return;
  els.matchSummary.innerHTML = '';
  els.matchSummary.classList.add('hidden');
}

function clearMatchFlags() {
  els.matchFlags.innerHTML = '';
  els.matchFlags.classList.remove('has-afk');
  els.matchFlags.classList.add('hidden');
  clearMatchSummary();
}

/** 对局时长统一按整数分钟展示，避免 17.3333 这类浮点数直接出现在界面 */
function durationMinutes(value) {
  const raw = Number(value);
  return Number.isFinite(raw) ? Math.round(raw) : null;
}

function matchRow(game, showScore) {
  const durationMin =
    durationMinutes(game.durationMin) ?? Math.round((Number(game.gameDuration) || 0) / 60);
  const score = showScore && Number.isFinite(Number(game.score)) ? Math.round(game.score) : null;
  // 该局在 10 人里的评分排名，和记分板卡片上的徽标一致
  const rank =
    showScore && Number.isFinite(Number(game.rank)) ? Math.round(Number(game.rank)) : null;
  const rankTotal = Number.isFinite(Number(game.rankTotal))
    ? Math.round(Number(game.rankTotal))
    : null;
  const rankHtml =
    rank === null
      ? ''
      : `<span class="rank ${rankClass(rank)}" title="本局评分排名第 ${rank}${
          rankTotal ? ` / ${rankTotal}` : ''
        }">#${rank}</span>`;
  const tags = game.tags ?? [];
  const remake = tags.includes('重开');
  const bestTag = remake ? null : tags.includes('MVP') ? 'MVP' : tags.includes('SVP') ? 'SVP' : null;
  const selfAfk = tags.includes('自己逃跑');
  const selfBadTag = remake
    ? null
    : tags.find((tag) => /^自己(小坑|很坑|坑|巨坑)$/.test(tag)) ?? null;
  const selfBadLevel = selfBadTag
    ? selfBadTag.includes('巨坑')
      ? 'severe'
      : selfBadTag.includes('小坑')
        ? 'mild'
        : 'bad'
    : null;
  const displayTags = (remake ? tags.filter((tag) => tag !== '重开') : tags).filter(
    (tag) =>
      tag !== 'MVP' &&
      tag !== 'SVP' &&
      tag !== selfBadTag &&
      tag !== '自己逃跑',
  );
  const selfAfkBadge = selfAfk
    ? '<span class="self-afk-badge">自己逃跑</span>'
    : '';
  const bestBadge = bestTag
    ? `<span class="best-badge ${bestTag === 'MVP' ? 'mvp' : 'svp'}">${bestTag}</span>`
    : '';
  const selfBadBadge = selfBadTag
    ? `<span class="self-bad-badge ${selfBadLevel}">${selfBadTag}</span>`
    : '';
  return `<button class="game-row match-item ${
    remake ? 'remake' : game.win ? 'win' : 'loss'
  }${bestTag ? ` has-${bestTag.toLowerCase()}` : ''}${
    selfBadTag ? ` has-self-bad self-bad-${selfBadLevel}` : ''
  }" type="button" data-game-id="${game.gameId}">
    <span class="result">${remake ? '重开' : game.win ? '胜' : '负'}</span>
    <span class="who">${champIconHtml(
      game.championId,
      game.championName,
      'sm',
    )}<b>${escapeHtml(game.championName ?? '未知英雄')}</b>${selfAfkBadge}${bestBadge}${selfBadBadge}<small>${escapeHtml(
      game.queueName ?? '',
    )} · ${durationMin} 分钟 · ${formatGameTime(game.gameCreation)}${
      displayTags?.length ? ` · ${matchFlagsHtml(displayTags)}` : ''
    }</small></span>
    <span class="kda">${game.kills}/${game.deaths}/${game.assists}</span>
    <span class="score-cell">${rankHtml}<span class="pts"${score === null ? '' : ` style="color:${ratingColor(score, game)}"`}>${
      score === null ? (showScore ? '--' : '›') : score
    }</span></span>
  </button>`;
}

function buildRadarContext(scoreboard) {
  if (!scoreboard.length) return null;

  const teamKills = (player) =>
    scoreboard
      .filter((item) => item.teamId === player.teamId)
      .reduce((sum, item) => sum + (Number(item.kills) || 0), 0);

  const metrics = [
    {
      label: '参团',
      value: (player) => {
        const kills = teamKills(player);
        return kills > 0 ? ((player.kills + player.assists) / kills) * 100 : 0;
      },
      format: (value) => `${Math.round(value)}%`,
    },
    { label: '经济', value: (player) => Number(player.gold) || 0, format: kilo },
    {
      label: 'KDA',
      value: (player) =>
        (Number(player.kills) + Number(player.assists)) / Math.max(1, Number(player.deaths)),
      format: (value) => num(value, 2),
    },
    {
      label: '承伤',
      value: (player) => Number(player.damageTaken) || 0,
      format: kilo,
      share: (player) => player.tankShare,
    },
    {
      label: '伤害',
      value: (player) => Number(player.damage) || 0,
      format: kilo,
      share: (player) => player.damageShare,
    },
    { label: '治疗', value: (player) => Number(player.heal) || 0, format: kilo },
  ];

  return metrics.map((metric) => {
    const entries = scoreboard.map((player) => ({
      teamId: player.teamId,
      value: metric.value(player),
    }));
    const values = entries.map((entry) => entry.value);
    // 六边形按各自阵营单独归一化，排名仍然把两边放在一起算
    const teams = new Map();
    for (const entry of entries) {
      const teamValues = teams.get(entry.teamId) ?? [];
      teamValues.push(entry.value);
      teams.set(entry.teamId, teamValues);
    }
    const groups = new Map(
      [...teams].map(([teamId, teamValues]) => [
        teamId,
        {
          max: Math.max(1, ...teamValues),
          avg:
            teamValues.reduce((sum, value) => sum + value, 0) / Math.max(1, teamValues.length),
        },
      ]),
    );
    return { ...metric, values, groups };
  });
}

function buildRadarSeries(player, context) {
  return context.map((metric) => {
    const value = metric.value(player);
    const group = metric.groups.get(player.teamId) ?? {
      max: Math.max(1, ...metric.values),
      avg:
        metric.values.reduce((sum, item) => sum + item, 0) / Math.max(1, metric.values.length),
    };
    const selfRatio = Math.max(0, Math.min(100, (value / group.max) * 100));
    const avgRatio = Math.max(0, Math.min(100, (group.avg / group.max) * 100));
    const plain = (input) => String(input).replace(/<[^>]*>/g, '');
    const valueText = plain(metric.format(value));
    const share = metric.share ? pct(metric.share(player)) : '';
    const display = share ? `${valueText} (${share})` : valueText;
    const rank = 1 + metric.values.filter((item) => item > value).length;
    return {
      label: `${metric.label}（第${rank}）`,
      rank,
      valueText: display,
      selfRatio,
      avgRatio,
      title: `${metric.label} 第${rank}名 · 玩家 ${display} · 队伍平均 ${plain(
        metric.format(group.avg),
      )}`,
    };
  });
}

/** 最近 N 场评分走势：左旧右新，上升/下降用颜色区分 */
function scoreSparkline(games) {
  const scores = (games ?? [])
    .slice(0, 10)
    .map((game) => Number(game.score))
    .filter((score) => Number.isFinite(score))
    .reverse();
  if (scores.length < 3) return '';

  const width = 120;
  const height = 30;
  const pad = 3;
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const span = Math.max(1, max - min);
  const points = scores.map((score, index) => [
    pad + (index * (width - pad * 2)) / (scores.length - 1),
    height - pad - ((score - min) / span) * (height - pad * 2),
  ]);
  const path = points
    .map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`)
    .join(' ');
  const [lastX, lastY] = points[points.length - 1];
  const trend = scores[scores.length - 1] >= scores[0] ? 'up' : 'down';

  return `<div class="spark ${trend}" title="最近 ${scores.length} 场评分走势（左旧右新）">
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
      <path d="${path}" class="spark-line" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="2.2" class="spark-dot"/>
    </svg>
    <span class="spark-label">近 ${scores.length} 场走势</span>
  </div>`;
}

function miniRadarSvg(series) {
  const width = 290;
  const height = 250;
  const cx = 145;
  const cy = 125;
  const radius = 76;
  const angle = (index) => -Math.PI / 2 + (index * Math.PI) / 3;
  const at = (index, ratio) => [
    cx + Math.cos(angle(index)) * radius * (ratio / 100),
    cy + Math.sin(angle(index)) * radius * (ratio / 100),
  ];
  const polygon = (ratios) =>
    ratios
      .map((ratio, index) =>
        at(index, Math.max(0, Math.min(100, ratio)))
          .map((value) => value.toFixed(1))
          .join(','),
      )
      .join(' ');

  const rings = [50, 100]
    .map((level) => `<polygon points="${polygon(series.map(() => level))}" class="radar-ring"/>`)
    .join('');
  const axes = series
    .map((_, index) => {
      const [x, y] = at(index, 100);
      return `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" class="radar-axis"/>`;
    })
    .join('');
  const labels = series
    .map((metric, index) => {
      const point = angle(index);
      const x = cx + Math.cos(point) * radius * 1.1;
      const y = cy + Math.sin(point) * radius * 1.1;
      const anchor =
        Math.cos(point) > 0.25 ? 'start' : Math.cos(point) < -0.25 ? 'end' : 'middle';
      const firstDy =
        Math.sin(point) < -0.6 ? '-1.05em' : Math.sin(point) > 0.6 ? '-0.15em' : '-0.35em';
      const labelTone =
        metric.rank === 1
          ? 'rank-1'
          : metric.rank <= 3
            ? 'rank-top'
            : metric.rank >= 8
              ? 'rank-low'
              : 'rank-mid';
      return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}" class="radar-label ${labelTone}">
        <tspan x="${x.toFixed(1)}" dy="${firstDy}">${metric.label}</tspan>
        <tspan x="${x.toFixed(1)}" dy="1.08em" class="radar-value">${metric.valueText}</tspan>
      </text>`;
    })
    .join('');

  // 图例放在六边形标签那一圈的上方，省掉底部一行
  const legend = `<g class="radar-legend">
    <circle cx="6" cy="7" r="2.4" class="radar-legend-dot self"/>
    <text x="11" y="9.7" class="radar-legend-label">玩家</text>
    <circle cx="${width - 48}" cy="7" r="2.4" class="radar-legend-dot avg"/>
    <text x="${width - 43}" y="9.7" class="radar-legend-label">队伍平均</text>
  </g>`;

  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="本局数据对比">
    ${rings}
    ${axes}
    <polygon points="${polygon(series.map((metric) => metric.avgRatio))}" class="radar-avg"/>
    <polygon points="${polygon(series.map((metric) => metric.selfRatio))}" class="radar-self"/>
    ${labels}
    ${legend}
  </svg>`;
}

/** 本局按评分给全部玩家排名，同分并列，返回每行名次和总人数 */
function scoreRankMap(scoreboard) {
  // 用精确分数排名，不能用展示时的整数，否则 74.6 和 74.8 都会被算成并列第 1
  const ranked = scoreboard
    .filter((row) => Number.isFinite(Number(row.score)))
    .map((row) => ({ row, score: Number(row.score) }))
    .sort((a, b) => b.score - a.score);
  const ranks = new Map();
  let lastScore = null;
  let lastRank = 0;
  ranked.forEach(({ row, score }, index) => {
    const rank = score === lastScore ? lastRank : index + 1;
    lastScore = score;
    lastRank = rank;
    ranks.set(row, rank);
  });
  return { ranks, total: ranked.length };
}

function renderScoreboard(detail) {
  const scoreboard = Array.isArray(detail.scoreboard) ? detail.scoreboard : [];
  const players = Array.isArray(detail.players) ? detail.players : [];
  if (!scoreboard.length) {
    els.matchesList.className = 'match-list';
    els.matchesList.innerHTML = '<div class="search-status">没有该局数据</div>';
    return;
  }
  if (
    !(state.itemIcons && Object.keys(state.itemIcons).length) &&
    scoreboard.some((row) => Array.isArray(row.items) && row.items.length)
  ) {
    void loadItemIcons();
  }

  const byPuuid = new Map(players.filter((player) => player.puuid).map((p) => [p.puuid, p]));
  const byName = new Map(players.map((player) => [player.displayName, player]));
  const selfPuuid = detail.selfPuuid ?? state.selfPuuid;
  const selfBadTag = (detail.tags ?? [])
    .find((tag) => /^自己(小坑|很坑|坑|巨坑)$/.test(tag))
    ?.replace(/^自己/, '');
  const radarContext = buildRadarContext(scoreboard);
  const { ranks, total: rankTotal } = scoreRankMap(scoreboard);

  const nodes = scoreboard.map((row) => {
    const report = (row.puuid && byPuuid.get(row.puuid)) || byName.get(row.name);
    const isLocal = Boolean(row.puuid && selfPuuid && row.puuid === selfPuuid);
    return buildCard(
      {
        ...(report ?? {}),
        puuid: row.puuid ?? report?.puuid,
        displayName: report?.displayName ?? row.name,
        championId: row.championId,
        championName: row.championName ?? report?.championName,
        position: row.position ?? report?.position,
        isEnemy: row.isEnemy,
        isBot: report?.isBot,
      },
      isLocal,
      {
        mode: detail.gameMode ?? null,
        modeLabel: detail.queueName ?? '本局',
        thisGame: row,
        rank: ranks.get(row),
        rankTotal,
        badTag: isLocal ? selfBadTag : undefined,
        radar: radarContext ? buildRadarSeries(row, radarContext) : undefined,
      },
    );
  });

  els.matchesList.className = 'match-list match-cards';
  els.matchesList.replaceChildren(...nodes);
}

function renderMatchTab(tab) {
  state.matchTab = tab;
  const detail = state.matchDetail;
  if (!detail) return;
  state.currentView = () => renderMatchDetailView(detail, tab);
  for (const button of els.matchTabs.querySelectorAll('[data-match-tab]')) {
    button.classList.toggle('active', button.dataset.matchTab === tab);
  }

  if (tab === 'scoreboard') {
    renderScoreboard(detail);
    return;
  }

  const selfPuuid = detail.selfPuuid ?? state.selfPuuid;
  const players = Array.isArray(detail.players) ? detail.players : [];
  if (!players.length) {
    els.matchesList.className = 'match-list';
    els.matchesList.innerHTML =
      '<div class="search-status"><span class="spinner"></span><span>正在加载近期战绩…</span></div>';
    return;
  }
  const nodes = players.map((player) =>
    buildCard(player, Boolean(selfPuuid && player.puuid === selfPuuid), {
      mode: detail.gameMode ?? null,
      modeLabel: detail.queueName ?? '近期',
      context: { queueId: detail.queueId, mode: detail.gameMode },
    }),
  );
  els.matchesList.className = 'match-list match-cards';
  els.matchesList.replaceChildren(...nodes);
}

function updateMatchesBackButton() {
  els.matchesBack.classList.toggle('hidden', state.backStack.length === 0);
}

/** 切换战绩弹窗宽度：列表视图用较宽的一档，本局详情用最宽的一档 */
function setMatchesCardWidth(width) {
  const card = els.matchesModal.querySelector('.modal-card');
  if (!card) return;
  card.classList.toggle('match-list-card', width === 'list');
  card.classList.toggle('wide', width === 'wide');
}

function applyMatchRange(games) {
  const range = state.matchesRange;
  return range > 0 ? (games ?? []).slice(0, range) : games ?? [];
}

/** 同步「近 10 / 20 / 50 / 100 / 200 / 全部」页签的显示与选中状态 */
function updateMatchesRangeTabs(visible) {
  if (!els.matchesRangeTabs) return;
  els.matchesRangeTabs.classList.toggle('hidden', !visible);
  if (!visible) return;
  for (const button of els.matchesRangeTabs.querySelectorAll('[data-match-range]')) {
    button.classList.toggle('active', Number(button.dataset.matchRange) === state.matchesRange);
  }
}

/** 当前范围需要更多对局时，自动继续翻页，直到满足场次或没有更多 */
async function fillMatchRange() {
  const range = state.matchesRange;
  if (!range || state.matchesRangeLoading) return;
  const token = state.matchesRangeToken + 1;
  state.matchesRangeToken = token;
  state.matchesRangeLoading = true;
  try {
    for (let guard = 0; guard < 20; guard += 1) {
      if (token !== state.matchesRangeToken) break;

      const page = state.playerMatches;
      if (page) {
        if (page.games.length >= range) break;
        if (page.archiveLoading) break;
        const remaining = Math.max(0, page.total - page.offset);
        if (page.archiveReady && remaining === 0) break;
        const before = page.games.length;
        await loadPlayerMatchesPage();
        if (state.playerMatches !== page || page.games.length <= before) break;
        continue;
      }

      if (filteredMyGames().length >= range) break;
      const hasMore = !state.lcuExhausted || state.archiveTotal > state.archiveLoaded;
      if (!hasMore) break;
      const button = els.matchesList.querySelector('[data-action="archive-more"]');
      if (!button) break;
      const before = state.myGames.length;
      await loadMoreArchive(button);
      if (state.myGames.length <= before) break;
    }
  } finally {
    if (token === state.matchesRangeToken) state.matchesRangeLoading = false;
  }
}

/** 战绩列表上方的汇总：只统计当前已加载、非重开的对局 */
function matchListSummary(games) {
  const played = (games ?? []).filter((game) => !(game.tags ?? []).includes('重开'));
  if (!played.length) return null;

  let scoreSum = 0;
  let scoreCount = 0;
  let best = null;
  let worst = null;
  let rankSum = 0;
  let rankCount = 0;
  let bestRank = null;
  let mvp = 0;
  let svp = 0;
  let bad = 0;
  let afk = 0;
  const scoreBands = MATCH_SCORE_BANDS.map(() => 0);

  for (const game of played) {
    const rawScore = game.score;
    const score = Number(rawScore);
    if (rawScore !== null && rawScore !== undefined && Number.isFinite(score)) {
      scoreSum += score;
      scoreCount += 1;
      scoreBands[matchScoreBandIndex(score)] += 1;
      if (best === null || score > best) best = score;
      if (worst === null || score < worst) worst = score;
    }

    const rank = Number(game.rank);
    if (Number.isFinite(rank) && rank > 0) {
      rankSum += rank;
      rankCount += 1;
      if (bestRank === null || rank < bestRank) bestRank = rank;
    }

    const tags = game.tags ?? [];
    if (tags.includes('MVP')) mvp += 1;
    if (tags.includes('SVP')) svp += 1;
    if (tags.some((tag) => /^自己(小坑|很坑|坑|巨坑)$/.test(tag))) bad += 1;
    if (tags.includes('自己逃跑')) afk += 1;
  }

  return {
    games: played.length,
    record: winRecord(played),
    avgScore: scoreCount ? scoreSum / scoreCount : null,
    best,
    worst,
    avgRank: rankCount ? rankSum / rankCount : null,
    bestRank,
    mvp,
    svp,
    bad,
    afk,
    scoreBands,
    scoreCount,
  };
}

/** 汇总里的评分最多保留 1 位小数，整数不补 .0 */
function summaryScore(value) {
  if (!Number.isFinite(Number(value))) return '-';
  const number = Number(value);
  return Number.isInteger(number) ? String(number) : number.toFixed(1);
}

/** 评分分段长条 + 图例：每段显示场次和百分比 */
function scoreBandsHtml(summary) {
  const total = summary.scoreCount;
  if (!total) return '';
  const segments = MATCH_SCORE_BANDS.map((band, index) => {
    const count = summary.scoreBands[index];
    if (!count) return '';
    const share = (count / total) * 100;
    return `<span class="score-band-seg ${band.className}" style="width:${share.toFixed(
      2,
    )}%" title="${band.label} 分：${count} 场 · ${Math.round(share)}%"></span>`;
  }).join('');
  const legend = MATCH_SCORE_BANDS.map((band, index) => {
    const count = summary.scoreBands[index];
    const share = Math.round((count / total) * 100);
    return `<span class="score-band-chip${count ? '' : ' score-band-zero'}">
      <i class="score-band-dot ${band.className}"></i>
      <span class="score-band-name">${band.label}</span>
      <b>${count}</b><span class="score-band-unit">场</span>
      <em>${share}%</em>
    </span>`;
  }).join('');
  return `<div class="score-bands">
    <div class="score-bands-head">
      <span class="score-bands-title">评分分段</span>
      <span class="score-bands-note">共 ${total} 场有评分</span>
    </div>
    <div class="score-band-bar">${segments}</div>
    <div class="score-band-legend">${legend}</div>
  </div>`;
}

function renderMatchesSummary(games) {
  if (!els.matchesSummary) return;
  const summary = matchListSummary(games);
  if (!summary) {
    els.matchesSummary.innerHTML = '';
    els.matchesSummary.classList.add('hidden');
    return;
  }

  const winRate = summary.record.winRate;
  const winTone = winRate === null ? '' : winRate >= 0.5 ? ' win' : ' loss';
  const scoreColor =
    summary.avgScore === null ? '' : ` style="color:${ratingColor(summary.avgScore, null)}"`;
  const scoreSub =
    summary.best === null
      ? '暂无评分'
      : `最高 ${summaryScore(summary.best)} · 最低 ${summaryScore(summary.worst)}`;
  const rankSub =
    summary.bestRank === null ? '暂无排名' : `最好 #${summary.bestRank}`;
  const cells = [
    `<div class="summary-cell">
      <span class="summary-label">场次</span>
      <b class="summary-value">${summary.games}</b>
      <span class="summary-sub">当前已加载 · 重开不计</span>
    </div>`,
    `<div class="summary-cell">
      <span class="summary-label">胜率</span>
      <b class="summary-value${winTone}">${winRatePct(winRate)}</b>
      <span class="summary-sub">${summary.record.wins}胜${summary.record.losses}负</span>
    </div>`,
    `<div class="summary-cell">
      <span class="summary-label">平均评分</span>
      <b class="summary-value"${scoreColor}>${
        summary.avgScore === null ? '-' : summary.avgScore.toFixed(1)
      }</b>
      <span class="summary-sub">${scoreSub}</span>
    </div>`,
    `<div class="summary-cell">
      <span class="summary-label">平均排名</span>
      <b class="summary-value">${
        summary.avgRank === null ? '-' : `第 ${summary.avgRank.toFixed(1)} 名`
      }</b>
      <span class="summary-sub">${rankSub}</span>
    </div>`,
    `<div class="summary-cell">
      <span class="summary-label">MVP / SVP</span>
      <b class="summary-value">${summary.mvp} / ${summary.svp}</b>
      <span class="summary-sub">最佳次数</span>
    </div>`,
    `<div class="summary-cell">
      <span class="summary-label">坑场次</span>
      <b class="summary-value${summary.bad ? ' loss' : ''}">${summary.bad}</b>
      <span class="summary-sub">${summary.afk ? `逃跑 ${summary.afk} 场` : '无逃跑'}</span>
    </div>`,
  ];
  els.matchesSummary.innerHTML = `<div class="matches-summary-grid">${cells.join(
    '',
  )}</div>${scoreBandsHtml(summary)}`;
  els.matchesSummary.classList.remove('hidden');
}

function renderMatchesView(games, title, showScore) {
  stopLoadingTimer();
  setMatchProgress('');
  state.matchDetail = null;
  state.matchTab = 'scoreboard';
  resetAiView();
  closeMatchTimeline();
  clearMatchFlags();
  els.matchesAi.classList.add('hidden');
  els.matchesTimeline.classList.add('hidden');
  els.matchesModal.classList.remove('hidden');
  setMatchesCardWidth('list');
  els.matchTabs.classList.add('hidden');
  els.myMatchesTabs?.classList.add('hidden');
  els.matchesTitle.textContent = title;
  updateMatchesRangeTabs(games.length > 0);
  renderMatchesSummary(showScore ? games : []);
  els.matchesList.className = 'match-list';
  els.matchesList.innerHTML = games.length
    ? games.map((game) => matchRow(game, showScore)).join('')
    : '<div class="search-status">没有对局记录</div>';
  updateMatchesBackButton();
}

function setMatchesRefresh(handler) {
  state.matchesRefreshHandler = typeof handler === 'function' ? handler : null;
  const available = Boolean(state.matchesRefreshHandler);
  els.matchesRefresh.classList.toggle('hidden', !available);
  els.matchesRefresh.disabled = false;
  els.matchesRefresh.classList.remove('spinning');
}

async function refreshMatchesView() {
  const handler = state.matchesRefreshHandler;
  if (!handler || state.matchesRefreshing) return;
  state.matchesRefreshing = true;
  els.matchesRefresh.disabled = true;
  els.matchesRefresh.classList.add('spinning');
  els.matchesRefresh.textContent = '更新中…';
  try {
    await handler();
  } catch (error) {
    els.notice.textContent = `更新失败：${
      error instanceof Error ? error.message : String(error)
    }`;
    els.notice.classList.remove('hidden');
    setTimeout(() => els.notice.classList.add('hidden'), 8000);
  } finally {
    state.matchesRefreshing = false;
    els.matchesRefresh.disabled = false;
    els.matchesRefresh.classList.remove('spinning');
    els.matchesRefresh.textContent = '更新';
  }
}

/** 本地列表的胜负统计：重开不计入胜负和胜率 */
function winRecord(games) {
  const played = (games ?? []).filter((game) => !(game.tags ?? []).includes('重开'));
  const wins = played.filter((game) => game.win).length;
  const losses = played.length - wins;
  return {
    games: played.length,
    wins,
    losses,
    winRate: played.length ? wins / played.length : null,
  };
}

/** “X胜Y负 · 胜率Z%”，没有有效对局时返回空串 */
function winRecordText(record) {
  if (!record?.games) return '';
  return `${record.wins}胜${record.losses}负 · 胜率 ${winRatePct(record.winRate)}`;
}

/** 从长期存档读取当前模式/英雄的总胜率 */
async function fetchModeRecord(puuid, context, championId) {
  const params = new URLSearchParams();
  if (puuid) params.set('puuid', puuid);
  if (context?.queueId) params.set('queueId', String(context.queueId));
  if (context?.mode) params.set('mode', context.mode);
  if (context?.group) params.set('group', context.group);
  if (championId) params.set('championId', String(championId));
  try {
    const response = await fetch(`/api/archive/record?${params}`, { cache: 'no-store' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false || !payload.record) return null;
    return { groupName: payload.groupName ?? '', ...payload.record };
  } catch {
    return null;
  }
}

/** 模式总胜率文案：极地大乱斗总胜率 51%（2500胜2400负） */
function modeRecordText(record) {
  if (!record?.games) return '';
  const label =
    !record.groupName || record.groupName === '全部模式'
      ? '总胜率'
      : `${record.groupName}总胜率`;
  return `${label} ${winRatePct(record.winRate)}（${record.wins}胜${record.losses}负）`;
}

function playerMatchesTitle(player, modeRecord) {
  const name = `${player.displayName ?? '玩家'}${player.tagLine ? `#${player.tagLine}` : ''}`;
  const local = winRecord(player.games);
  const count = local.games || (player.games ?? []).length;
  const stats = modeRecordText(modeRecord) || winRecordText(local);
  return `${name} · 最近 ${count} 场${stats ? ` · ${stats}` : ''}`;
}

/** 当前战绩列表对应的模式：优先取正在查看的对局，其次取当前游戏 */
function matchesContext() {
  const detail = state.matchDetail;
  if (detail && (detail.queueId || detail.gameMode)) {
    return { queueId: detail.queueId, mode: detail.gameMode };
  }
  return snapshotContext();
}

/** 把当前对局/模式换算成存档里的统计组 */
function queueGroupFromContext(context) {
  if (!context) return undefined;
  const mode = String(context.mode ?? '').toUpperCase();
  const queueId = Number(context.queueId) || 0;
  if (!mode && !queueId) return undefined;
  if (mode === 'ARAM' || queueId === 450 || queueId === 720) return 'aram';
  if (
    mode === 'ARENA' ||
    mode === 'CHERRY' ||
    queueId === 1700 ||
    queueId === 1710
  ) {
    return 'arena';
  }
  if (queueId === 420) return 'solo';
  if (queueId === 440) return 'flex';
  if (queueId === 400 || queueId === 430) return 'normal';
  return 'sr';
}

async function refreshPlayerMatches(player, context) {
  if (!player.summonerId) throw new Error('缺少玩家 ID，无法更新');
  const token = state.matchRequestToken;
  const params = new URLSearchParams({ summonerId: String(player.summonerId) });
  if (context?.queueId) params.set('queueId', String(context.queueId));
  if (context?.mode) params.set('mode', context.mode);

  const response = await fetch(`/api/player/refresh?${params}`, { method: 'POST' });
  const payload = await response.json().catch(() => ({}));
  if (token !== state.matchRequestToken) return;
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error ?? `HTTP ${response.status}`);
  }
  const updated = payload.player;
  if (!updated) throw new Error('没有返回战绩数据');

  // 保留当前页面才有的字段（位置、英雄、敌方标记、实时数据），其余用新报告覆盖
  mergeRefreshedPlayer(player, updated);

  const boardPlayer = state.snapshot?.players?.find(
    (item) => item.summonerId === player.summonerId,
  );
  if (boardPlayer) {
    if (boardPlayer !== player) mergeRefreshedPlayer(boardPlayer, updated);
    render();
  }
  if (state.searchPlayers.some((item) => item.summonerId === player.summonerId)) {
    for (const item of state.searchPlayers) {
      if (item.summonerId === player.summonerId) mergeRefreshedPlayer(item, updated);
    }
    renderSearchPlayers(state.searchPlayers);
  }
  const modeContext = context ?? (state.matchDetail ? matchesContext() : undefined);
  const modeRecord = await fetchModeRecord(player.puuid, modeContext);
  if (token !== state.matchRequestToken) return;
  state.playerMatches = {
    puuid: player.puuid,
    player,
    context,
    group: queueGroupFromContext(context),
    games: [...(player.games ?? [])],
    title: playerMatchesTitle(player, modeRecord),
    offset: 0,
    total: 0,
    archiveReady: false,
    archiveLoading: false,
  };
  renderPlayerMatches();
  void loadPlayerMatchesPage();
}

function mergeRefreshedPlayer(target, updated) {
  const keep = {
    position: target.position,
    championId: target.championId,
    championName: target.championName,
    isEnemy: target.isEnemy,
    isBot: target.isBot,
    live: target.live,
  };
  Object.assign(target, updated, keep);
  target.loading = false;
}

function archiveCursorParams(cursor) {
  if (!cursor) return null;
  return { before: String(cursor.gameCreation), beforeId: String(cursor.gameId) };
}

function playerArchiveQuery(page, limit, offset) {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  // 有游标时优先用 before，offset 只作为旧接口兜底
  const cursor = archiveCursorParams(page.cursor);
  if (cursor) {
    params.set('before', cursor.before);
    params.set('beforeId', cursor.beforeId);
  } else {
    params.set('offset', String(offset));
  }
  if (page.puuid) params.set('puuid', page.puuid);
  if (page.group) params.set('group', page.group);
  return `/api/archive/matches?${params.toString()}`;
}

function renderPlayerMatches() {
  const page = state.playerMatches;
  if (!page) return;
  const scrollTop = els.matchesList.scrollTop;
  const games = applyMatchRange(page.games);
  renderMatchesView(games, page.title, true);
  els.matchesList.scrollTop = scrollTop;
  state.currentView = renderPlayerMatches;
  setMatchesRefresh(
    page.player?.summonerId
      ? () => refreshPlayerMatches(page.player, page.context)
      : null,
  );

  if (!page.puuid) return;
  if (page.archiveLoading && !page.archiveReady) {
    els.matchesList.insertAdjacentHTML(
      'beforeend',
      '<div class="archive-more"><span>正在读取更早的战绩…</span></div>',
    );
    return;
  }
  const range = state.matchesRange;
  if (range > 0 && games.length >= range) {
    els.matchesList.insertAdjacentHTML(
      'beforeend',
      `<div class="archive-more"><span>已显示最近 ${range} 场</span></div>`,
    );
    return;
  }
  const remaining = Math.max(0, page.total - page.offset);
  if (page.archiveReady && remaining === 0) {
    els.matchesList.insertAdjacentHTML(
      'beforeend',
      `<div class="archive-more"><span>已加载全部历史战绩（共 ${page.games.length} 场）</span></div>`,
    );
    return;
  }
  els.matchesList.insertAdjacentHTML(
    'beforeend',
    `<div class="archive-more"><button class="btn" type="button" data-action="player-more">加载更早的战绩${
      page.archiveReady && remaining ? `（本地存档还有 ${remaining} 场）` : ''
    }</button></div>`,
  );
}

async function loadPlayerMatchesPage() {
  const page = state.playerMatches;
  if (!page || !page.puuid || page.archiveLoading) return;
  page.archiveLoading = true;
  const offset = page.offset;
  renderPlayerMatches();
  try {
    const response = await fetch(
      playerArchiveQuery(page, PLAYER_MATCH_PAGE, offset),
      { cache: 'no-store' },
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.error ?? `HTTP ${response.status}`);
    }
    if (state.playerMatches !== page) return;
    const archived = Array.isArray(payload.games) ? payload.games : [];
    page.total = Number(payload.total) || page.total || archived.length;
    page.cursor = payload.nextCursor ?? null;
    page.offset = archived.length
      ? Math.max(page.offset, offset + archived.length)
      : page.total;
    page.games = mergeMatchLists(page.games, archived);
    page.archiveReady = true;
  } catch (error) {
    if (state.playerMatches !== page) return;
    els.notice.textContent = `读取更早战绩失败：${
      error instanceof Error ? error.message : String(error)
    }`;
    els.notice.classList.remove('hidden');
    setTimeout(() => els.notice.classList.add('hidden'), 8000);
  } finally {
    if (state.playerMatches === page) {
      page.archiveLoading = false;
      renderPlayerMatches();
    }
  }
}

function openMatches(player, context) {
  state.matchRequestToken += 1;
  const token = state.matchRequestToken;
  state.modeRecord = null;
  state.matchesRangeToken += 1;
  state.matchesRangeLoading = false;

  // 在某一局详情里点玩家卡片时，把当前详情压栈，返回时回到原页签
  const inDetail =
    !els.matchesModal.classList.contains('hidden') &&
    Boolean(state.matchDetail) &&
    typeof state.currentView === 'function';
  if (inDetail) {
    state.backStack.push(state.currentView);
    state.backScrollStack.push(els.matchesList.scrollTop);
  } else {
    state.backStack = [];
    state.backScrollStack = [];
    state.currentView = null;
  }

  const page = {
    puuid: player.puuid,
    player,
    context,
    group: queueGroupFromContext(context),
    games: [...(player.games ?? [])],
    title: playerMatchesTitle(player),
    offset: 0,
    total: 0,
    cursor: null,
    archiveReady: false,
    archiveLoading: false,
  };
  state.playerMatches = page;
  renderPlayerMatches();

  // 标题里的模式总胜率来自长期存档，异步补上，不阻塞列表显示
  const modeContext = context ?? (state.matchDetail ? matchesContext() : undefined);
  void fetchModeRecord(player.puuid, modeContext).then((record) => {
    if (token !== state.matchRequestToken || !record || state.playerMatches !== page) {
      return;
    }
    page.title = playerMatchesTitle(player, record);
    els.matchesTitle.textContent = page.title;
  });
  void loadPlayerMatchesPage().then(() => fillMatchRange());
}

function goMatchesBack() {
  state.matchRequestToken += 1;
  const previous = state.backStack.pop();
  const scrollTop = state.backScrollStack.pop();
  if (previous) {
    previous();
    if (Number.isFinite(scrollTop)) {
      els.matchesList.scrollTop = scrollTop;
    }
  } else closeMatches();
}

function mergeMatchLists(...lists) {
  const byId = new Map();
  for (const list of lists) {
    for (const game of list ?? []) {
      if (!game || game.gameId === undefined) continue;
      const key = String(game.gameId);
      const previous = byId.get(key);
      byId.set(key, previous ? { ...previous, ...game } : game);
    }
  }
  return [...byId.values()].sort(
    (a, b) => (Number(b.gameCreation) || 0) - (Number(a.gameCreation) || 0),
  );
}

/** 把一场战绩归入大模式页签；归不进去的特殊模式只在「全部」里显示 */
function matchModeKey(game) {
  const queueId = Number(game?.queueId) || 0;
  const position = String(game?.position ?? '').toUpperCase();
  const mode = String(game?.gameMode ?? '').toUpperCase();
  if (mode === 'ARAM' || queueId === 450 || queueId === 720 || position === 'ARAM') {
    return 'ARAM';
  }
  if (mode === 'CHERRY' || queueId === 1700 || queueId === 1710 || position === 'ARENA') {
    return 'ARENA';
  }
  if (
    mode === 'CLASSIC' ||
    mode === 'SWIFTPLAY' ||
    mode === 'PRACTICETOOL' ||
    [400, 420, 430, 440, 890, 3140].includes(queueId) ||
    ['TOP', 'JUNGLE', 'MIDDLE', 'MID', 'BOTTOM', 'ADC', 'UTILITY', 'SUPPORT'].includes(
      position,
    )
  ) {
    return 'SR';
  }
  return undefined;
}

/** 召唤师峡谷子页签：排位 / 匹配 / 人机 / 快速模式 */
function matchSrGroupKey(game) {
  const queueId = Number(game?.queueId) || 0;
  const mode = String(game?.gameMode ?? '').toUpperCase();
  if (BOT_QUEUE_IDS.has(queueId)) return 'bot';
  if (queueId === 480) return 'swift';
  if (queueId === 3140 || mode === 'PRACTICETOOL') return 'practice';
  if (queueId === 420 || queueId === 440) return 'ranked';
  if (queueId === 400 || queueId === 430) return 'normal';
  return undefined;
}

/** 当前大模式页签 + 峡谷子页签是否命中 */
function matchesMyModeFilter(game) {
  if (!state.myMatchesMode || state.myMatchesMode === 'all') return true;
  if (matchModeKey(game) !== state.myMatchesMode) return false;
  if (state.myMatchesMode === 'SR' && state.myMatchesSrMode !== 'all') {
    return matchSrGroupKey(game) === state.myMatchesSrMode;
  }
  return true;
}

/** 存档接口过滤：峡谷子页签用 group，其它模式用 mode */
function myMatchesArchiveFilter() {
  if (
    state.myMatchesMode === 'SR' &&
    state.myMatchesSrMode &&
    state.myMatchesSrMode !== 'all'
  ) {
    return { group: state.myMatchesSrMode };
  }
  if (!state.myMatchesMode || state.myMatchesMode === 'all') return {};
  return { mode: state.myMatchesMode };
}

/** 只保留当前模式/子模式页签的对局 */
function filterGamesByMyMode(games) {
  return games.filter((game) => matchesMyModeFilter(game));
}

function filteredMyGames() {
  const filter = state.championFilter;
  const games = state.myGames ?? [];
  if (!filter) return filterGamesByMyMode(games);
  return games.filter((game) => Number(game.championId) === filter.championId);
}

/** 同步「我的战绩」模式页签的显示与选中状态 */
function updateMyMatchesTabs(visible) {
  if (!els.myMatchesTabs) return;
  els.myMatchesTabs.classList.toggle('hidden', !visible);
  if (els.mySrTabs) {
    const showSr = Boolean(visible && state.myMatchesMode === 'SR');
    els.mySrTabs.classList.toggle('hidden', !showSr);
    if (showSr) {
      for (const button of els.mySrTabs.querySelectorAll('[data-sr-mode]')) {
        button.classList.toggle(
          'active',
          button.dataset.srMode === (state.myMatchesSrMode ?? 'all'),
        );
      }
    }
  }
  if (!visible) return;
  for (const button of els.myMatchesTabs.querySelectorAll('[data-my-mode]')) {
    button.classList.toggle('active', button.dataset.myMode === state.myMatchesMode);
  }
}

function renderMyMatches() {
  const games = applyMatchRange(filteredMyGames());
  const filter = state.championFilter;
  const subLabel =
    !filter && state.myMatchesMode === 'SR' && state.myMatchesSrMode !== 'all'
      ? SR_MODE_LABELS[state.myMatchesSrMode] ?? ''
      : '';
  const modeStats = modeRecordText(state.modeRecord);
  const local = winRecord(games);
  const stats = modeStats
    ? ` · ${modeStats}`
    : local.games
      ? ` · ${winRecordText(local)}`
      : '';
  const count = modeStats ? '' : ` · ${local.games || games.length} 场`;
  // 重新渲染会重置滚动位置，先记住，避免“加载更早”后跳回顶部
  const scrollTop = els.matchesList.scrollTop;
  renderMatchesView(
    games,
    filter
      ? `${championFilterTitle(filter)}${count}${stats}`
      : `我的战绩${subLabel ? ` · ${subLabel}` : ''}${count}${stats}`,
    true,
  );
  updateMyMatchesTabs(!filter);
  els.matchesList.scrollTop = scrollTop;
  state.currentView = renderMyMatches;
  setMatchesRefresh(() =>
    openMyMatches({ keepFilter: true, keepMode: true, preserveNavigation: true }),
  );

  const range = state.matchesRange;
  const rangeReached = range > 0 && games.length >= range;
  const archiveRemaining = Math.max(0, state.archiveTotal - state.archiveLoaded);
  const hasMore = !rangeReached && (!state.lcuExhausted || archiveRemaining > 0);
  if (!games.length) {
    const empty = els.matchesList.querySelector('.search-status');
    if (empty) {
      const subject = filter
        ? filter.championName || '该英雄'
        : state.myMatchesMode === 'SR' && state.myMatchesSrMode !== 'all'
          ? SR_MODE_LABELS[state.myMatchesSrMode] ?? '召唤师峡谷'
          : CHAMPION_RANKING_MODE_LABELS[state.myMatchesMode] ?? '该模式';
      empty.textContent = hasMore
        ? `已加载的战绩里没有${subject}，可以继续加载更早的战绩`
        : `没有找到${subject}的战绩`;
    }
  }
  if (rangeReached) {
    els.matchesList.insertAdjacentHTML(
      'beforeend',
      `<div class="archive-more"><span>已显示最近 ${range} 场</span></div>`,
    );
  } else if (hasMore) {
    const hint =
      archiveRemaining > 0 ? `（本地存档还有 ${archiveRemaining} 场）` : '';
    els.matchesList.insertAdjacentHTML(
      'beforeend',
      `<div class="archive-more"><button class="btn" type="button" data-action="archive-more">加载更早的战绩${hint}</button></div>`,
    );
  } else {
    els.matchesList.insertAdjacentHTML(
      'beforeend',
      `<div class="archive-more"><span>已加载全部${
        filter ? '该英雄' : ''
      }历史战绩（共 ${games.length} 场）</span></div>`,
    );
  }
}

async function loadMoreArchive(button) {
  if (state.archiveLoading) return;
  state.archiveLoading = true;
  button.disabled = true;
  button.textContent = '正在读取更早的战绩…';
  try {
    const knownIds = new Set(state.myGames.map((game) => String(game.gameId)));
    const archiveFilter = myMatchesArchiveFilter();
    const hasNew = (list) => list.some((game) => !knownIds.has(String(game.gameId)));
    const hasNewForMode = (list) =>
      list.some(
        (game) => !knownIds.has(String(game.gameId)) && matchesMyModeFilter(game),
      );
    const championFilter = state.championFilter;
    let incoming = [];
    let added = false;

    // 本地存档读取快，而且通常存着更多更早的对局，优先翻存档
    if (state.archiveLoaded < state.archiveTotal) {
      let archiveUrl;
      if (championFilter) {
        archiveUrl = championArchiveQuery(
          championFilter,
          CHAMPION_MATCH_PAGE,
          state.archiveOffset,
          state.archiveCursor,
        );
      } else {
        const params = new URLSearchParams();
        params.set('limit', '100');
        if (archiveFilter.mode) params.set('mode', archiveFilter.mode);
        if (archiveFilter.group) params.set('group', archiveFilter.group);
        const cursorParams = archiveCursorParams(state.archiveCursor);
        if (cursorParams) {
          params.set('before', cursorParams.before);
          params.set('beforeId', cursorParams.beforeId);
        } else {
          params.set('offset', String(state.archiveOffset));
        }
        archiveUrl = `/api/archive/matches?${params.toString()}`;
      }
      const response = await fetch(archiveUrl, { cache: 'no-store' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.error ?? `HTTP ${response.status}`);
      }
      const archived = Array.isArray(payload.games) ? payload.games : [];
      state.archiveTotal = Number(payload.total) || state.archiveTotal;
      state.archiveCursor = payload.nextCursor ?? null;
      state.archiveOffset += archived.length;
      state.archiveLoaded += archived.length;
      if (!archived.length) state.archiveLoaded = state.archiveTotal;
      incoming = mergeMatchLists(incoming, archived);
      added = hasNew(archived);
    }

    // 存档没有新增时，再继续往前翻客户端战绩（英雄专属列表只查存档）
    if (!added && !state.lcuExhausted && !championFilter) {
      let lcuError = '';
      try {
        let pages = 0;
        let previousKey = '';
        while (!state.lcuExhausted && pages < 5) {
          pages += 1;
          const response = await fetch(
            `/api/me/matches?recent=${MY_MATCH_PAGE}&offset=${state.myLcuOffset}`,
            { cache: 'no-store' },
          );
          const payload = await response.json().catch(() => ({}));
          if (!response.ok || payload?.ok === false) {
            throw new Error(payload?.error ?? `HTTP ${response.status}`);
          }
          const page = Array.isArray(payload.games) ? payload.games : [];
          state.selfPuuid = payload.summoner?.puuid ?? state.selfPuuid;
          state.myLcuOffset += page.length;
          if (page.length < MY_MATCH_PAGE) state.lcuExhausted = true;
          if (!page.length) break;
          // 客户端没有按 offset 返回新的一页时，避免反复请求同一批对局
          const key = page.map((game) => String(game.gameId)).join(',');
          if (key === previousKey) {
            state.lcuExhausted = true;
            break;
          }
          previousKey = key;
          incoming = mergeMatchLists(incoming, page);
          if (hasNewForMode(page)) {
            added = true;
            break;
          }
        }
      } catch (error) {
        lcuError = error instanceof Error ? error.message : String(error);
        state.lcuExhausted = true;
      }
      if (!incoming.length && lcuError) throw new Error(lcuError);
    }

    state.myGames = mergeMatchLists(state.myGames, incoming);
    renderMyMatches();
  } catch (error) {
    els.notice.textContent = `读取更早战绩失败：${
      error instanceof Error ? error.message : String(error)
    }`;
    els.notice.classList.remove('hidden');
    setTimeout(() => els.notice.classList.add('hidden'), 8000);
    button.disabled = false;
    button.textContent = '加载更早的战绩';
  } finally {
    state.archiveLoading = false;
  }
}

/** 本人当前英雄的专属战绩列表（选人阶段/对局详情里的按钮） */
function championArchiveQuery(filter, limit, offset, cursor) {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  const cursorParams = archiveCursorParams(cursor);
  if (cursorParams) {
    params.set('before', cursorParams.before);
    params.set('beforeId', cursorParams.beforeId);
  } else {
    params.set('offset', String(offset));
  }
  params.set('championId', String(filter.championId));
  if (filter.mode) params.set('mode', filter.mode);
  return `/api/archive/matches?${params.toString()}`;
}

/** 英雄战绩弹窗标题，如「暗夜猎手 · 极地大乱斗 · 我的战绩」 */
function championFilterTitle(filter) {
  const name = filter?.championName || '该英雄';
  const mode = filter?.mode ? CHAMPION_RANKING_MODE_LABELS[filter.mode] : '';
  return `${name}${mode ? ` · ${mode}` : ''} · 我的战绩`;
}

function openChampionMatches(championId, championName, options = {}) {
  const id = Number(championId) || 0;
  if (!id) return;
  const inDetail =
    !els.matchesModal.classList.contains('hidden') &&
    Boolean(state.matchDetail) &&
    typeof state.currentView === 'function';
  if (options.back) {
    state.backStack.push(options.back);
    state.backScrollStack.push(els.matchesList.scrollTop);
  } else if (inDetail) {
    state.backStack.push(state.currentView);
    state.backScrollStack.push(els.matchesList.scrollTop);
  } else {
    state.backStack = [];
    state.backScrollStack = [];
  }
  state.championFilter = {
    championId: id,
    championName: String(championName ?? ''),
    mode:
      options.mode === 'SR' || options.mode === 'ARAM' || options.mode === 'ARENA'
        ? options.mode
        : undefined,
  };
  void openMyMatches({ keepFilter: true, preserveNavigation: true });
}

async function openMyMatches(options = {}) {
  if (!options.keepFilter) state.championFilter = null;
  if (!options.keepMode) {
    state.myMatchesMode = 'ARAM';
    state.myMatchesSrMode = 'all';
  }
  if (!options.preserveNavigation) {
    state.backStack = [];
    state.backScrollStack = [];
  }
  state.currentView = null;
  state.matchRequestToken += 1;
  const token = state.matchRequestToken;
  state.matchDetail = null;
  state.playerMatches = null;
  state.matchesRangeToken += 1;
  state.matchesRangeLoading = false;
  state.myGames = [];
  state.myLcuOffset = 0;
  state.lcuExhausted = false;
  state.archiveOffset = 0;
  state.archiveLoaded = 0;
  state.archiveTotal = 0;
  state.archiveCursor = null;
  state.modeRecord = null;
  state.matchTab = 'scoreboard';
  const filter = state.championFilter;
  els.matchesModal.classList.remove('hidden');
  setMatchesCardWidth('list');
  updateMatchesBackButton();
  els.matchesTitle.textContent = filter ? championFilterTitle(filter) : '我的最近战绩';
  updateMyMatchesTabs(!filter);
  setMatchesRefresh(null);
  beginMatchesLoading(
    filter ? '正在读取该英雄的战绩…' : '正在读取最近战绩和评分…',
  );

  let games = [];
  let lcuError = '';

  if (filter) {
    // 英雄专属战绩：直接按英雄 + 模式查存档，每页 20 场
    try {
      const response = await fetch(
        championArchiveQuery(filter, CHAMPION_MATCH_PAGE, 0, null),
        { cache: 'no-store' },
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.error ?? `HTTP ${response.status}`);
      }
      games = Array.isArray(payload.games) ? payload.games : [];
      state.archiveTotal = Number(payload.total) || games.length;
      state.archiveCursor = payload.nextCursor ?? null;
      state.archiveOffset = games.length;
      state.archiveLoaded = games.length;
      state.lcuExhausted = true;
    } catch (error) {
      lcuError = error instanceof Error ? error.message : String(error);
    }
  } else {
    try {
      // “我的战绩”只拉列表，不逐场分析；先取最近一页，往下可以继续翻页
      const response = await fetch(
        `/api/me/matches?recent=${MY_MATCH_PAGE}&offset=0`,
        { cache: 'no-store' },
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.error ?? `HTTP ${response.status}`);
      }
      state.selfPuuid = payload.summoner?.puuid ?? state.selfPuuid;
      games = Array.isArray(payload.games) ? payload.games : [];
      state.myLcuOffset = games.length;
      state.lcuExhausted = games.length < MY_MATCH_PAGE;
    } catch (error) {
      lcuError = error instanceof Error ? error.message : String(error);
    }

    try {
      // 客户端战绩读不到时，历史存档仍然可用
      const archiveParams = new URLSearchParams({ limit: '100', offset: '0' });
      const archiveFilter = myMatchesArchiveFilter();
      if (archiveFilter.mode) archiveParams.set('mode', archiveFilter.mode);
      if (archiveFilter.group) archiveParams.set('group', archiveFilter.group);
      const response = await fetch(`/api/archive/matches?${archiveParams.toString()}`, {
        cache: 'no-store',
      });
      const payload = await response.json().catch(() => ({}));
      if (response.ok && payload?.ok !== false) {
        const archived = Array.isArray(payload.games) ? payload.games : [];
        state.archiveTotal = Number(payload.total) || archived.length;
        state.archiveCursor = payload.nextCursor ?? null;
        state.archiveOffset = archived.length;
        state.archiveLoaded = archived.length;
        games = mergeMatchLists(games, archived);
      } else if (!games.length) {
        lcuError ||= payload?.error ?? `历史存档 HTTP ${response.status}`;
      }
    } catch (error) {
      if (!games.length) {
        lcuError ||= error instanceof Error ? error.message : String(error);
      }
    }
  }

  const championId = filter?.championId;
  const recordContext = filter
    ? filter.mode
      ? { mode: filter.mode }
      : undefined
    : state.myMatchesMode === 'all'
      ? undefined
      : state.myMatchesMode === 'SR' && state.myMatchesSrMode !== 'all'
        ? { group: state.myMatchesSrMode }
        : { mode: state.myMatchesMode };
  const modeRecord = await fetchModeRecord(undefined, recordContext, championId);
  if (token !== state.matchRequestToken) return;
  state.modeRecord = modeRecord;
  stopLoadingTimer();
  state.myGames = games;
  if (!games.length && !filter) {
    els.matchesList.innerHTML = `<div class="search-status${
      lcuError ? ' error' : ''
    }">${lcuError ? `读取失败：${escapeHtml(lcuError)}` : '还没有对局记录'}</div>`;
    els.matchesTitle.textContent = '我的战绩';
    setMatchesRefresh(() =>
      openMyMatches({ keepFilter: true, keepMode: true, preserveNavigation: true }),
    );
    return;
  }

  renderMyMatches();
  void fillMatchRange();
  if (lcuError) {
    els.notice.textContent = `客户端战绩读取失败，已显示历史存档：${lcuError}`;
    els.notice.classList.remove('hidden');
    setTimeout(() => els.notice.classList.add('hidden'), 8000);
  }
}

/** 首页「最近一局」：读取我最近一场对局并直接打开详情 */
async function openLatestMatch() {
  if (state.latestLoading) return;
  state.latestLoading = true;
  els.latestMatch.disabled = true;
  els.latestMatch.textContent = '读取中…';

  try {
    let gameId = 0;
    let lcuError = '';

    try {
      const response = await fetch('/api/me/matches?recent=1', { cache: 'no-store' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.error ?? `HTTP ${response.status}`);
      }
      state.selfPuuid = payload.summoner?.puuid ?? state.selfPuuid;
      const game = Array.isArray(payload.games) ? payload.games[0] : null;
      if (game?.gameId) gameId = Number(game.gameId);
    } catch (error) {
      lcuError = error instanceof Error ? error.message : String(error);
    }

    // 客户端战绩读不到时，用本地历史存档兜底
    if (!gameId) {
      const response = await fetch('/api/archive/matches?limit=1', { cache: 'no-store' });
      const payload = await response.json().catch(() => ({}));
      if (response.ok && payload?.ok !== false) {
        const game = Array.isArray(payload.games) ? payload.games[0] : null;
        if (game?.gameId) gameId = Number(game.gameId);
      } else if (!lcuError) {
        lcuError = payload?.error ?? `历史存档 HTTP ${response.status}`;
      }
    }

    if (!gameId) throw new Error(lcuError || '还没有可查看的对局记录');
    // 等待期间用户已经打开了别的弹窗，不要覆盖
    if (!els.matchesModal.classList.contains('hidden')) return;
    await openMatchDetail(gameId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    els.notice.textContent = `读取最近一局失败：${message}`;
    els.notice.classList.remove('hidden');
    setTimeout(() => els.notice.classList.add('hidden'), 8000);
  } finally {
    state.latestLoading = false;
    els.latestMatch.disabled = false;
    els.latestMatch.textContent = '最近一局';
  }
}

/* ------------------------------------------------------------------ */
/* 本局时间线                                                          */
/* ------------------------------------------------------------------ */

function timelineGoldText(value) {
  const number = Math.round(Number(value) || 0);
  if (Math.abs(number) >= 1000) return `${(number / 1000).toFixed(1)}k`;
  return String(number);
}

function timelineSelfPlayer(detail, timeline) {
  const players = Array.isArray(timeline?.players) ? timeline.players : [];
  const selfPuuid = detail?.selfPuuid ?? state.selfPuuid;
  if (!selfPuuid) return undefined;
  const own = players.find((player) => player.puuid && player.puuid === selfPuuid);
  if (own) return own;
  const self = (detail?.scoreboard ?? []).find((player) => player.puuid === selfPuuid);
  if (!self) return undefined;
  return players.find(
    (player) =>
      Number(player.championId) === Number(self.championId) &&
      String(player.name) === String(self.name),
  );
}

function timelinePlayerFor(detail, timeline) {
  const players = Array.isArray(timeline?.players) ? timeline.players : [];
  return timelineSelfPlayer(detail, timeline) ?? players[0];
}

/** 我排在最前，其余按己方、敌方分组，方便直接切换 */
function timelineOrderedPlayers(timeline, self) {
  const players = Array.isArray(timeline?.players) ? timeline.players : [];
  if (!self) return players;
  const teamId = Number(self.teamId);
  const others = players.filter((player) => player !== self);
  return [
    self,
    ...others.filter((player) => Number(player.teamId) === teamId),
    ...others.filter((player) => Number(player.teamId) !== teamId),
  ];
}

function timelinePlayersHtml(timeline, self, activeId) {
  const players = timelineOrderedPlayers(timeline, self);
  if (!players.length) return '';
  const selfId = Number(self?.participantId);
  const teamId = Number(self?.teamId);
  return players
    .map((player) => {
      const id = Number(player.participantId);
      const champion = player.championName ?? `玩家 ${id}`;
      const name = player.name ? String(player.name) : champion;
      const isSelf = Boolean(self) && id === selfId;
      const isEnemy = Boolean(self) && Number(player.teamId) !== teamId;
      const classes = ['timeline-player-tab'];
      if (id === Number(activeId)) classes.push('active');
      if (isSelf) classes.push('self');
      if (isEnemy) classes.push('enemy');
      const title = `${name} · ${champion}`;
      return `<button class="${classes.join(' ')}" type="button" role="tab" aria-selected="${
        id === Number(activeId)
      }" data-timeline-player="${id}" title="${escapeHtml(title)}">${champIconHtml(
        player.championId,
        champion,
        'sm',
        title,
      )}<span class="timeline-player-label">${escapeHtml(
        isSelf ? '我' : champion,
      )}</span></button>`;
    })
    .join('');
}

/** 时间线里的击杀者/助攻者只显示英雄头像，鼠标悬停再看英雄名 */
function timelineChampionIcon(participantId, playersById, selfParticipantId) {
  const player = playersById.get(Number(participantId));
  if (!player) return '';
  const label = player.championName ?? `玩家 ${participantId}`;
  const self = Number(participantId) === Number(selfParticipantId) ? ' self' : '';
  return `<span class="timeline-champ${self}">${champIconHtml(
    player.championId,
    label,
    'sm',
    label,
  )}</span>`;
}

/** 同步「时间线」按钮：demo 模式或没有本人数据时隐藏 */
function updateTimelineButton(detail) {
  const available =
    state.snapshot?.mode !== 'demo' &&
    Boolean(detail && (detail.selfPuuid || state.selfPuuid));
  els.matchesTimeline.classList.toggle('hidden', !available);
}

function closeMatchTimeline() {
  state.timelineToken += 1;
  els.timelineModal.classList.add('hidden');
}

/** 对方每个英雄：我击杀、我助攻、被其击杀 */
function timelineVersusHtml(player, timeline) {
  const players = Array.isArray(timeline?.players) ? timeline.players : [];
  const enemies = players.filter(
    (item) => Number(item.teamId) !== Number(player.teamId),
  );
  if (!enemies.length) return '';
  const playersById = new Map(
    players.map((item) => [Number(item.participantId), item]),
  );
  const count = (list, championId) =>
    (Array.isArray(list) ? list : [])
      .filter((item) => Number(item.championId) === Number(championId))
      .reduce((sum, item) => sum + (Number(item.count) || 0), 0);
  const columns = enemies
    .map((enemy) => ({
      enemy,
      kills: count(player.killedChampions, enemy.championId),
      assists: count(player.assistedChampions, enemy.championId),
      killedMe: count(player.killedBy, enemy.championId),
      assistedMe: count(player.assistedBy, enemy.championId),
    }))
    .sort(
      (a, b) =>
        b.kills +
          b.assists +
          b.killedMe +
          b.assistedMe -
          (a.kills + a.assists + a.killedMe + a.assistedMe) ||
        a.enemy.championId - b.enemy.championId,
    );
  const head = columns
    .map(({ enemy }) => {
      const label = enemy.championName ?? `#${enemy.championId}`;
      return `<th title="${escapeHtml(label)}">${timelineChampionIcon(
        enemy.participantId,
        playersById,
      )}</th>`;
    })
    .join('');
  const row = (label, key, className) =>
    `<tr class="${className}"><th>${label}</th>${columns
      .map((column) => {
        const value = Number(column[key]) || 0;
        return `<td class="${value ? className : 'zero'}">${value}</td>`;
      })
      .join('')}</tr>`;
  return `<div class="timeline-versus">
    <table class="timeline-versus-table">
      <thead><tr><th class="timeline-versus-corner">对方英雄</th>${head}</tr></thead>
      <tbody>
        ${row('击杀我', 'killedMe', 'neg')}
        ${row('助攻杀我', 'assistedMe', 'neg-soft')}
        ${row('我击杀', 'kills', 'pos')}
        ${row('我助攻', 'assists', 'assist')}
      </tbody>
    </table>
  </div>`;
}

/** “我”用带高亮描边的本人英雄头像 */
function timelineSelfBadge(selfParticipantId, playersById) {
  const player = playersById.get(Number(selfParticipantId));
  const label = player?.championName ?? '我';
  const icon = champIconHtml(player?.championId, label, 'sm', `我 · ${label}`);
  return `<span class="timeline-event-champ self" title="我 · ${escapeHtml(
    label,
  )}">${icon}</span>`;
}

function timelineEventChamp(
  participantId,
  championId,
  championName,
  playersById,
  selfParticipantId,
) {
  if (participantId && Number(participantId) === Number(selfParticipantId)) {
    return timelineSelfBadge(participantId, playersById);
  }
  const player = participantId
    ? playersById.get(Number(participantId))
    : undefined;
  const label = championName || player?.championName || `#${championId || '?'}`;
  const icon = participantId
    ? timelineChampionIcon(participantId, playersById)
    : champIconHtml(championId, label, 'sm', label);
  return `<span class="timeline-event-champ" title="${escapeHtml(label)}">${icon}</span>`;
}

/** 当前查看的玩家用普通头像；真正的“我”才用金色描边 */
function timelineActorBadge(participantId, playersById, selfParticipantId) {
  return timelineEventChamp(
    participantId,
    undefined,
    undefined,
    playersById,
    selfParticipantId,
  );
}

function timelineLifeHtml(life, playersById, actorParticipantId, selfParticipantId) {
  const death = life.death;
  const start = Number(life.startMs) || 0;
  const end = Number(life.endMs) || 0;
  const alive = Number(life.aliveMs) || 0;
  const respawn = Number(life.respawnMs) || 0;
  const approximate = respawn > 0 ? '约 ' : '';
  const index = Number(life.index) || 1;
  const killCount = Number(life.kills) || 0;
  const assistCount = Number(life.assists) || 0;
  const stats = [
    `<span class="timeline-kda"><b>${killCount}</b> / <b>${death ? 1 : 0}</b> / <b>${assistCount}</b></span>`,
    `<span>补刀 <b>+${Number(life.cs) || 0}</b></span>`,
    `<span>经济 <b>+${timelineGoldText(life.gold)}</b></span>`,
    life.level ? `<span>Lv <b>${Number(life.level)}</b></span>` : '',
  ].join('');
  let deathLine = '<span class="timeline-life-end ok">存活到对局结束</span>';
  if (death) {
    const killerIcon = timelineChampionIcon(
      death.killerId,
      playersById,
      selfParticipantId,
    );
    const assistIcons = (death.assistIds ?? [])
      .map((id) => timelineChampionIcon(id, playersById, selfParticipantId))
      .filter(Boolean)
      .join('');
    const killer = killerIcon
      ? `被 ${killerIcon} 击杀`
      : death.killerName
        ? `被 <b>${escapeHtml(death.killerName)}</b> 击杀`
        : '阵亡';
    const assist = assistIcons ? ` · 助攻 ${assistIcons}` : '';
    deathLine = `<span class="timeline-life-end dead">${killer}${assist}</span>`;
  }
  const respawnHint =
    respawn > 0
      ? `<span class="timeline-life-respawn">复活约 ${Math.round(respawn / 1000)} 秒</span>`
      : '';
  const events = Array.isArray(life.events) ? life.events : [];
  const actorBadge = timelineActorBadge(
    actorParticipantId,
    playersById,
    selfParticipantId,
  );
  const eventsHtml = events.length
    ? `<div class="timeline-life-events">${events
        .map((event) => {
          const clock = gameClock((Number(event.timestampMs) || 0) / 1000);
          const victim = timelineEventChamp(
            event.participantId,
            event.championId,
            event.championName,
            playersById,
            selfParticipantId,
          );
          const assistIds = Array.isArray(event.assistParticipantIds)
            ? event.assistParticipantIds
            : [];
          const assistChampionIds = Array.isArray(event.assistChampionIds)
            ? event.assistChampionIds
            : [];
          const assistNames = Array.isArray(event.assistChampionNames)
            ? event.assistChampionNames
            : [];
          const assistEntries = assistIds.map((id, index) => ({
            id,
            championId: assistChampionIds[index],
            name: assistNames[index],
          }));
          const assistHtml = (entry) =>
            timelineEventChamp(
              entry.id,
              entry.championId,
              entry.name,
              playersById,
              selfParticipantId,
            );
          if (event.type === 'kill') {
            const assisters = assistEntries.map(assistHtml).join('');
            return `<span class="timeline-event kill"><em>${clock}</em>${actorBadge} 击杀 ${victim}${
              assisters
                ? ` <span class="timeline-event-assist">· 助攻 ${assisters}</span>`
                : ''
            }</span>`;
          }
          const others = assistEntries.filter(
            (entry) => Number(entry.id) !== Number(actorParticipantId),
          );
          const meText = others.length
            ? `${actorBadge}${others.map(assistHtml).join('')}`
            : actorBadge;
          const killer = timelineEventChamp(
            event.killerParticipantId,
            event.killerChampionId,
            event.killerChampionName,
            playersById,
            selfParticipantId,
          );
          const label =
            Number(event.timestampMs) > end ? '助攻（阵亡后）' : '助攻';
          return `<span class="timeline-event assist"><em>${clock}</em>${meText} ${label} ${killer} 击杀 ${victim}</span>`;
        })
        .join('')}</div>`
    : '';
  return `<div class="timeline-life ${death ? 'dead' : 'alive'}">
    <div class="timeline-life-axis"><span class="timeline-dot"></span></div>
    <div class="timeline-life-card">
      <div class="timeline-life-head">
        <span class="timeline-life-index">第 ${index} 条命</span>
        <span class="timeline-life-range">${approximate}${gameClock(
          start / 1000,
        )} – ${gameClock(end / 1000)}</span>
        ${respawnHint}
        <span class="timeline-life-alive">存活 ${gameClock(alive / 1000)}</span>
      </div>
      <div class="timeline-life-stats">${stats}</div>
      ${eventsHtml}
      <div class="timeline-life-death">${deathLine}</div>
    </div>
  </div>`;
}

function timelineTeamGold(point, teamId) {
  const teams = Array.isArray(point?.teams) ? point.teams : [];
  const team = teams.find((item) => Number(item.teamId) === Number(teamId));
  return Number(team?.gold) || 0;
}

function timelineBuildingLabel(building) {
  const lane =
    {
      TOP_LANE: '上路',
      MID_LANE: '中路',
      BOT_LANE: '下路',
      NEXUS: '基地',
    }[building?.laneType] ?? '';
  if (building?.buildingType === 'INHIBITOR_BUILDING') return `${lane}水晶`;
  if (building?.buildingType === 'NEXUS_BUILDING') return '基地水晶';
  if (building?.buildingType === 'TOWER_BUILDING') {
    const tower =
      {
        OUTER_TURRET: '一塔',
        INNER_TURRET: '二塔',
        BASE_TURRET: '门牙塔',
        NEXUS_TURRET: '门牙塔',
      }[building?.towerType] ?? '防御塔';
    return `${lane}${tower}`;
  }
  return '建筑';
}

/** 双方经济差曲线；只在两人队伍模式下绘制，避免竞技场多队伍时误导 */
function timelineCurveHtml(timeline, player) {
  const series = Array.isArray(timeline?.series) ? timeline.series : [];
  if (series.length < 2) return '';
  const teamId = Number(player?.teamId);
  const teamIds = new Set();
  for (const point of series) {
    for (const team of Array.isArray(point?.teams) ? point.teams : []) {
      teamIds.add(Number(team.teamId));
    }
  }
  if (teamIds.size !== 2 || !teamIds.has(teamId)) return '';
  const enemyId = [...teamIds].find((id) => id !== teamId);
  if (enemyId === undefined) return '';

  const points = series.map((point) => {
    const timestampMs = Number(point.timestampMs) || 0;
    const mine = timelineTeamGold(point, teamId);
    const enemy = timelineTeamGold(point, enemyId);
    return { timestampMs, mine, enemy, diff: mine - enemy };
  });
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return '';
  const durationMs = Math.max(Number(timeline.durationMs) || 0, last.timestampMs, 1);
  const maxAbs = Math.max(1000, ...points.map((point) => Math.abs(point.diff)));
  const step = maxAbs > 8000 ? 4000 : maxAbs > 4000 ? 2000 : 1000;
  const bound = Math.max(step, Math.ceil(maxAbs / step) * step);
  const width = 760;
  const plot = {
    left: 34,
    right: width - 12,
    top: 20,
    bottom: 138,
    middle: (20 + 138) / 2,
  };
  const x = (timestampMs) =>
    plot.left +
    (Math.min(durationMs, Math.max(0, timestampMs)) / durationMs) *
      (plot.right - plot.left);
  const y = (diff) =>
    plot.middle - (diff / bound) * ((plot.bottom - plot.top) / 2);
  const path = points
    .map(
      (point, index) =>
        `${index ? 'L' : 'M'}${x(point.timestampMs).toFixed(1)},${y(
          point.diff,
        ).toFixed(1)}`,
    )
    .join(' ');
  const area = `M${x(first.timestampMs).toFixed(1)},${plot.middle.toFixed(
    1,
  )} L${points
    .map(
      (point) =>
        `${x(point.timestampMs).toFixed(1)},${y(point.diff).toFixed(1)}`,
    )
    .join(' L')} L${x(last.timestampMs).toFixed(1)},${plot.middle.toFixed(1)} Z`;

  const buildings = Array.isArray(timeline.buildings) ? timeline.buildings : [];
  const allies = buildings.filter((item) => Number(item.teamId) === teamId);
  const enemies = buildings.filter((item) => Number(item.teamId) === enemyId);
  const markers = [...allies, ...enemies]
    .filter((building) => {
      const timestampMs = Number(building.timestampMs) || 0;
      return timestampMs > 0 && timestampMs <= durationMs;
    })
    .map((building) => {
      const timestampMs = Number(building.timestampMs) || 0;
      const isMine = Number(building.teamId) === teamId;
      const label = `${gameClock(timestampMs / 1000)} ${
        isMine ? '我方' : '对方'
      }推掉${timelineBuildingLabel(building)}`;
      const markerX = x(timestampMs).toFixed(1);
      return `<line class="timeline-curve-marker ${
        isMine ? 'ally' : 'enemy'
      }" x1="${markerX}" y1="${plot.top}" x2="${markerX}" y2="${
        plot.bottom
      }"><title>${escapeHtml(label)}</title></line>`;
    })
    .join('');

  const grid = [plot.top, plot.middle, plot.bottom]
    .map(
      (lineY, index) =>
        `<line class="timeline-curve-grid${
          index === 1 ? ' zero' : ''
        }" x1="${plot.left}" y1="${lineY}" x2="${plot.right}" y2="${lineY}"></line>`,
    )
    .join('');
  const middleX = ((plot.left + plot.right) / 2).toFixed(1);
  const diffClass = last.diff >= 0 ? 'positive' : 'negative';
  const diffLabel = `${last.diff >= 0 ? '领先' : '落后'} ${timelineGoldText(
    Math.abs(last.diff),
  )}`;

  return `<div class="timeline-curve">
    <div class="timeline-curve-head">
      <span class="timeline-curve-title">经济差曲线 <em>（所在方 - 对方）</em></span>
      <span class="timeline-curve-total">所在方 <b>${timelineGoldText(
        last.mine,
      )}</b> · 对方 <b>${timelineGoldText(
        last.enemy,
      )}</b> · <b class="${diffClass}">${diffLabel}</b></span>
    </div>
    <svg viewBox="0 0 ${width} 160" role="img" aria-label="双方经济差曲线">
      ${grid}
      <line class="timeline-curve-grid zero" x1="${middleX}" y1="${
        plot.top
      }" x2="${middleX}" y2="${plot.bottom}"></line>
      <path class="timeline-curve-area" d="${area}"></path>
      <path class="timeline-curve-line" d="${path}"></path>
      ${markers}
      <circle class="timeline-curve-dot ${diffClass}" cx="${x(
        last.timestampMs,
      ).toFixed(1)}" cy="${y(last.diff).toFixed(1)}" r="3.2"></circle>
      <text class="timeline-curve-label" x="${plot.left}" y="154">0:00</text>
      <text class="timeline-curve-label" x="${middleX}" y="154" text-anchor="middle">${gameClock(
        durationMs / 2000,
      )}</text>
      <text class="timeline-curve-label" x="${plot.right}" y="154" text-anchor="end">${gameClock(
        durationMs / 1000,
      )}</text>
      <text class="timeline-curve-label" x="4" y="${plot.top + 4}">+${
        bound / 1000
      }k</text>
      <text class="timeline-curve-label" x="4" y="${plot.bottom}">-${
        bound / 1000
      }k</text>
    </svg>
    <div class="timeline-curve-legend">
      <span><i class="ally"></i>所在方推塔 ${allies.length}</span>
      <span><i class="enemy"></i>对方推塔 ${enemies.length}</span>
      <span>竖线为推塔时间</span>
    </div>
  </div>`;
}

function renderTimeline(timeline, detail, cached) {
  const self = timelineSelfPlayer(detail, timeline);
  const fallback = timelinePlayerFor(detail, timeline);
  const players = Array.isArray(timeline?.players) ? timeline.players : [];
  const requestedId = Number(state.timeline?.playerId);
  const player =
    players.find((item) => Number(item.participantId) === requestedId) ?? fallback;
  if (!player) {
    els.timelinePlayers.innerHTML = '';
    els.timelineSummary.innerHTML = '';
    els.timelineList.innerHTML =
      '<div class="timeline-status error">时间线里没有找到玩家数据</div>';
    return;
  }
  const lives = Array.isArray(player.lives) ? player.lives : [];
  const playersById = new Map(
    players.map((item) => [Number(item.participantId), item]),
  );
  const durationMs = Number(timeline.durationMs) || 0;
  els.timelinePlayers.innerHTML = timelinePlayersHtml(
    timeline,
    self,
    player.participantId,
  );
  els.timelineTitle.textContent = `本局时间线 · ${player.championName ?? '对局'}`;
  els.timelineMeta.textContent = `${gameClock(durationMs / 1000)} · ${
    lives.length
  } 条命 · ${cached ? '本地存档' : '实时读取'}`;

  const aliveList = lives.map((life) => Number(life.aliveMs) || 0);
  const longest = aliveList.length ? Math.max(...aliveList) : 0;
  const average = aliveList.length
    ? Math.round(aliveList.reduce((sum, value) => sum + value, 0) / aliveList.length)
    : 0;
  const totalCs = lives.reduce((sum, life) => sum + (Number(life.cs) || 0), 0);
  const totalGold = lives.reduce((sum, life) => sum + (Number(life.gold) || 0), 0);
  const summary = [
    ['条命', String(lives.length)],
    ['KDA', `${Number(player.kills) || 0} / ${Number(player.deaths) || 0} / ${Number(player.assists) || 0}`],
    ['最长存活', gameClock(longest / 1000)],
    ['平均存活', gameClock(average / 1000)],
    ['补刀', `+${totalCs}`],
    ['经济', `+${timelineGoldText(totalGold)}`],
    ['整局伤害', timelineGoldText(player.damage)],
    ['整局承伤', timelineGoldText(player.damageTaken)],
  ];
  els.timelineSummary.innerHTML = summary
    .map(
      ([label, value]) =>
        `<div class="timeline-summary-item"><small>${label}</small><b>${value}</b></div>`,
    )
    .join('');

  const perLifeDamage = lives.length
    ? Math.round((Number(player.damage) || 0) / lives.length)
    : 0;
  const perLifeTaken = lives.length
    ? Math.round((Number(player.damageTaken) || 0) / lives.length)
    : 0;
  const versus = timelineVersusHtml(player, timeline);
  const curve = timelineCurveHtml(timeline, player);
  els.timelineList.innerHTML = lives.length
    ? `${curve}${versus}<div class="timeline-lives">${lives
        .map((life) =>
          timelineLifeHtml(
            life,
            playersById,
            player.participantId,
            self?.participantId,
          ),
        )
        .join('')}</div>` +
      `<div class="timeline-note">整局造成 ${timelineGoldText(
        player.damage,
      )} 伤害 / 承受 ${timelineGoldText(
        player.damageTaken,
      )} 伤害；按 ${lives.length} 条命平均约 ${timelineGoldText(
        perLifeDamage,
      )} / ${timelineGoldText(
        perLifeTaken,
      )}。官方接口不提供每条命的伤害拆分，复活时间按等级估算，分钟级快照会有少量误差。</div>`
    : `${curve}<div class="timeline-status">这局没有解析出存活时间段</div>`;
  els.timelineList.scrollTop = 0;
}

async function openMatchTimeline() {
  const detail = state.matchDetail;
  if (!detail) return;
  const gameId = Number(detail.gameId);
  if (!Number.isFinite(gameId) || gameId <= 0) return;

  if (state.timeline?.gameId === gameId && state.timeline.data) {
    state.timeline.playerId = null;
    renderTimeline(state.timeline.data, detail, state.timeline.cached);
    els.timelineModal.classList.remove('hidden');
    return;
  }

  const token = state.timelineToken + 1;
  state.timelineToken = token;
  els.timelineModal.classList.remove('hidden');
  els.timelineTitle.textContent = '本局时间线';
  els.timelineMeta.textContent = '';
  els.timelinePlayers.innerHTML = '';
  els.timelineSummary.innerHTML = '';
  els.timelineList.innerHTML =
    '<div class="timeline-status"><span class="spinner"></span>正在读取本局时间线…</div>';

  try {
    const response = await fetch(`/api/match/${gameId}/timeline`, {
      cache: 'no-store',
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.error ?? `HTTP ${response.status}`);
    }
    if (token !== state.timelineToken) return;
    if (state.matchDetail?.gameId !== gameId) return;
    state.timeline = {
      gameId,
      data: payload.timeline,
      cached: Boolean(payload.cached),
      playerId: null,
    };
    renderTimeline(payload.timeline, detail, Boolean(payload.cached));
  } catch (error) {
    if (token !== state.timelineToken) return;
    els.timelineMeta.textContent = '';
    els.timelinePlayers.innerHTML = '';
    els.timelineSummary.innerHTML = '';
    els.timelineList.innerHTML = `<div class="timeline-status error">读取时间线失败：${escapeHtml(
      error instanceof Error ? error.message : String(error),
    )}</div>`;
  }
}

function renderMatchDetailView(detail, tab = 'scoreboard') {
  stopLoadingTimer();
  state.matchDetail = detail;
  state.matchTab = tab;
  els.matchesSummary?.classList.add('hidden');
  els.matchesRangeTabs?.classList.add('hidden');
  state.currentView = () => renderMatchDetailView(detail, tab);
  // 用点击时的当前页签，保证在「近期战绩」里更新后不会跳回「本局详情」
  setMatchesRefresh(() =>
    openMatchDetail(detail.gameId, { push: false, tab: state.matchTab, force: true }),
  );
  els.matchesModal.classList.remove('hidden');
  setMatchesCardWidth('wide');
  els.matchTabs.classList.remove('hidden');
  els.matchesAi.classList.remove('hidden');
  updateTimelineButton(detail);
  setAiButton(Boolean(state.ai?.running));
  els.matchesTitle.innerHTML = `${escapeHtml(detail.queueName ?? '对局')} · ${escapeHtml(
    formatGameTime(detail.gameCreation),
  )} · 对局详情${
    detail.tags?.length ? ` · ${matchFlagsHtml(detail.tags)}` : ''
  }`;
  renderMatchFlags(detail);
  renderMatchSummary(detail);
  updateMatchesBackButton();
  renderMatchTab(tab);
}

async function openMatchDetail(gameId, options = {}) {
  const push = options.push !== false;
  state.matchRequestToken += 1;
  const token = state.matchRequestToken;
  if (push && typeof state.currentView === 'function') {
    state.backStack.push(state.currentView);
    state.backScrollStack.push(els.matchesList.scrollTop);
  }

  els.matchesModal.classList.remove('hidden');
  setMatchesCardWidth('wide');
  els.matchTabs.classList.add('hidden');
  els.myMatchesTabs?.classList.add('hidden');
  resetAiView();
  closeMatchTimeline();
  clearMatchFlags();
  els.matchesAi.classList.add('hidden');
  els.matchesTimeline.classList.add('hidden');
  els.matchesTitle.textContent = '对局详情';
  updateMatchesBackButton();
  setMatchesRefresh(null);
  beginMatchesLoading('正在读取本局详情…');
  setMatchProgress('正在加载本局详情…');
  state.matchTab = options.tab ?? 'scoreboard';

  try {
    const refreshQuery = options.force ? '&refresh=1' : '';
    const response = await fetch(`/api/match/${gameId}/stream?recent=10${refreshQuery}`, {
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    let detail = null;
    await readNdjson(response, (event) => {
      if (event.type === 'partial') {
        if (token !== state.matchRequestToken || !event.data) return;
        setMatchProgress('正在加载近期战绩…');
        renderMatchDetailView(event.data, state.matchTab);
      } else if (event.type === 'progress') {
        state.loadingProgress = { done: event.done, total: event.total };
        setMatchProgress(
          event.total
            ? `近期战绩 ${event.done}/${event.total}${event.name ? ` · ${event.name}` : ''}`
            : '正在加载近期战绩…',
        );
      } else if (event.type === 'done') {
        detail = event.data;
      } else if (event.type === 'error') {
        throw new Error(event.error ?? '读取失败');
      }
    });

    // 浏览器不支持流式响应时退回到普通 JSON 接口
    if (!detail) {
      const fallback = await fetch(`/api/match/${gameId}?recent=10${refreshQuery}`, {
        cache: 'no-store',
      });
      const payload = await fallback.json().catch(() => ({}));
      if (!fallback.ok || payload?.ok === false) {
        throw new Error(payload?.error ?? `HTTP ${fallback.status}`);
      }
      detail = payload;
    }

    if (token !== state.matchRequestToken) return;
    setMatchProgress('');
    renderMatchDetailView(detail, state.matchTab);
  } catch (error) {
    if (token !== state.matchRequestToken) return;
    stopLoadingTimer();
    setMatchProgress('');
    state.matchDetail = null;
    els.matchTabs.classList.add('hidden');
    clearMatchFlags();
    els.matchesAi.classList.add('hidden');
    els.matchesTimeline.classList.add('hidden');
    els.matchesList.className = 'match-list';
    els.matchesList.innerHTML = `<div class="search-status error">读取失败：${escapeHtml(
      error instanceof Error ? error.message : String(error),
    )}</div>`;
    setMatchesRefresh(() => openMatchDetail(gameId, {
      push: false,
      tab: options.tab,
      force: options.force,
    }));
    updateMatchesBackButton();
  }
}

function closeMatches() {
  stopLoadingTimer();
  setMatchProgress('');
  state.matchRequestToken += 1;
  state.matchDetail = null;
  state.playerMatches = null;
  state.matchesRangeToken += 1;
  state.backStack = [];
  state.backScrollStack = [];
  state.currentView = null;
  state.championFilter = null;
  state.modeRecord = null;
  state.myGames = [];
  state.myLcuOffset = 0;
  state.lcuExhausted = false;
  state.archiveOffset = 0;
  state.archiveLoaded = 0;
  state.archiveTotal = 0;
  state.archiveCursor = null;
  resetAiView();
  closeMatchTimeline();
  state.timeline = null;
  els.matchesModal.classList.add('hidden');
  els.matchesList.replaceChildren();
  els.matchTabs.classList.add('hidden');
  els.matchesSummary?.classList.add('hidden');
  els.matchesRangeTabs?.classList.add('hidden');
  clearMatchFlags();
  els.matchesAi.classList.add('hidden');
  els.matchesTimeline.classList.add('hidden');
  els.matchesBack.classList.add('hidden');
  setMatchesRefresh(null);
  setMatchesCardWidth('');
}

function rankingClass(rank) {
  if (rank === 1) return 'rank-1';
  if (rank <= 3) return 'rank-top';
  if (rank >= 8) return 'rank-low';
  return 'rank-mid';
}

function renderChampionRanking(champions, mode = state.championRankingMode) {
  const sort = CHAMPION_RANKING_SORT_LABELS[state.championRankingSort]
    ? state.championRankingSort
    : 'avg';
  const number = (value) => Number(value) || 0;
  const list = (Array.isArray(champions) ? champions : [])
    .filter((item) => Number(item?.games) > 0)
    .sort((a, b) => {
      if (sort === 'games') {
        return number(b.games) - number(a.games) || number(b.avgScore) - number(a.avgScore);
      }
      if (sort === 'winRate') {
        return (
          number(b.winRate) - number(a.winRate) ||
          number(b.games) - number(a.games) ||
          number(b.avgScore) - number(a.avgScore)
        );
      }
      if (sort === 'best') {
        return number(b.bestScore) - number(a.bestScore) || number(b.avgScore) - number(a.avgScore);
      }
      if (sort === 'proficiency') {
        return (
          number(b.proficiency) - number(a.proficiency) ||
          number(b.avgScore) - number(a.avgScore) ||
          number(b.games) - number(a.games)
        );
      }
      return number(b.avgScore) - number(a.avgScore) || number(b.games) - number(a.games);
    });
  const modeLabel =
    CHAMPION_RANKING_MODE_LABELS[mode] ?? CHAMPION_RANKING_MODE_LABELS.all;
  const sortLabel = CHAMPION_RANKING_SORT_LABELS[sort];
  const totalGames = list.reduce((sum, item) => sum + (Number(item.games) || 0), 0);

  els.championRankingMeta.textContent = list.length
    ? `${modeLabel} · 按${sortLabel} · ${list.length} 个英雄 · ${totalGames} 场`
    : '';

  if (!list.length) {
    els.championRankingList.innerHTML = `<div class="search-status">${escapeHtml(
      modeLabel,
    )}还没有带评分的英雄战绩，多打几局后再来看看</div>`;
    return;
  }

  els.championRankingList.innerHTML = list
    .map((item, index) => {
      const rank = index + 1;
      const name = item.championName || '未知英雄';
      const avg = Number(item.avgScore) || 0;
      const prof = Number(item.proficiency) || 0;
      return `<button class="champion-rank-row" type="button" data-champion-id="${
        Number(item.championId) || 0
      }" data-champion-name="${escapeHtml(name)}">
        <span class="champion-rank-no ${rankingClass(rank)}">${rank}</span>
        ${champIconHtml(item.championId, name, 'sm')}
        <span class="champion-rank-main">
          <b>${escapeHtml(name)}</b>
          <small>${Number(item.games) || 0} 场 · 胜率 ${winRatePct(
            item.winRate,
          )} · <span class="champion-rank-prof" title="综合熟练度：场次经验 + 胜率、均分、最高分 × 样本置信度">熟练度 ${num(
            prof,
            0,
          )}</span></small>
        </span>
        <span class="champion-rank-stats">
          <span class="champion-rank-stat">
            <span class="champion-rank-score" style="color:${ratingColor(avg)}">${num(
              avg,
              1,
            )}</span>
            <small>平均分</small>
          </span>
          <span class="champion-rank-stat">
            <b class="champion-rank-avg" title="该英雄所有场次中，平均每局在双方有评分玩家中的排名">${
              Number(item.avgRank) > 0 ? num(item.avgRank, 1) : '-'
            }</b>
            <small>平均排名</small>
          </span>
        </span>
        <span class="champion-rank-extra">
          <span>最高 <b>${num(item.bestScore, 0)}</b></span>
          <span>最低 <b>${num(item.worstScore, 0)}</b></span>
        </span>
      </button>`;
    })
    .join('');
}

function updateChampionRankingTabs() {
  if (!els.championRankingTabs) return;
  for (const button of els.championRankingTabs.querySelectorAll('[data-ranking-mode]')) {
    button.classList.toggle(
      'active',
      button.dataset.rankingMode === state.championRankingMode,
    );
  }
}

async function loadChampionRanking() {
  const token = (state.championRankingToken ?? 0) + 1;
  state.championRankingToken = token;
  state.championRankingLoading = true;
  const mode = state.championRankingMode;
  els.championRankingMeta.textContent = '';
  els.championRankingList.innerHTML =
    '<div class="search-status"><span class="spinner"></span><span>正在统计英雄平均分…</span></div>';
  try {
    const params = new URLSearchParams();
    if (mode !== 'all') params.set('mode', mode);
    const query = params.toString();
    const response = await fetch(
      `/api/archive/champions${query ? `?${query}` : ''}`,
      { cache: 'no-store' },
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.error ?? `HTTP ${response.status}`);
    }
    if (token !== state.championRankingToken) return;
    state.selfPuuid = payload.puuid ?? state.selfPuuid;
    state.championRankingData = Array.isArray(payload.champions) ? payload.champions : [];
    renderChampionRanking(state.championRankingData, mode);
  } catch (error) {
    if (token !== state.championRankingToken) return;
    els.championRankingMeta.textContent = '';
    els.championRankingList.innerHTML = `<div class="search-status error">读取失败：${escapeHtml(
      error instanceof Error ? error.message : String(error),
    )}</div>`;
  } finally {
    if (token === state.championRankingToken) state.championRankingLoading = false;
  }
}

function openChampionRanking(options = {}) {
  if (!options.keepMode) state.championRankingMode = 'ARAM';
  if (els.championRankingSort) els.championRankingSort.value = state.championRankingSort;
  updateChampionRankingTabs();
  els.championRankingModal.classList.remove('hidden');
  void loadChampionRanking();
}

function closeChampionRanking() {
  state.championRankingToken = (state.championRankingToken ?? 0) + 1;
  state.championRankingLoading = false;
  els.championRankingModal.classList.add('hidden');
}

/* ------------------------------------------------------------------ */
/* 时段胜率                                                            */
/* ------------------------------------------------------------------ */

function timeStatsTone(period) {
  if (!period?.games) return 'empty';
  const rate = Number(period.winRate) || 0;
  if (rate >= 0.55) return 'good';
  if (rate >= 0.45) return 'even';
  if (rate >= 0.35) return 'warn';
  return 'bad';
}

function timeStatsScoreTone(period) {
  if (!period?.scoreGames) return 'empty';
  const avgScore = Number(period.avgScore) || 0;
  return (
    TIME_STATS_SCORE_TONES.find((tone) => avgScore >= tone.min)?.className ?? 'avg-low'
  );
}

function updateTimeStatsTabs() {
  if (!els.timeStatsTabs) return;
  for (const button of els.timeStatsTabs.querySelectorAll('[data-time-mode]')) {
    const active = button.dataset.timeMode === state.timeStatsMode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  }
  for (const button of els.timeStatsTabs.querySelectorAll('[data-time-view]')) {
    const active = button.dataset.timeView === state.timeStatsView;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  }
  if (els.timeStatsDimension) {
    els.timeStatsDimension.value = TIME_STATS_DIMENSION_LABELS[state.timeStatsDimension]
      ? state.timeStatsDimension
      : 'hour';
  }
}

function timeStatsEmptyHint(modeLabel) {
  return state.timeStatsSource === 'none'
    ? '没有读到历史战绩，先在「我的战绩」里加载一些对局，或启动客户端后再试'
    : `${modeLabel}还没有足够的对局，多打几局后再来看看`;
}

function timeStatsSourceNote() {
  return state.timeStatsSource === 'recent' ? ' · 最近 100 场（该模式暂无历史存档）' : '';
}

function timeStatsHighlight(label, period, detail) {
  return period
    ? `<div class="time-stat-highlight">
        <span>${label}</span>
        <b>${escapeHtml(period.label)}</b>
        <small>${detail}</small>
      </div>`
    : '';
}

function renderTimeStatsWinRate(data, modeLabel, dimensionLabel, periods) {
  els.timeStatsMeta.textContent = `${modeLabel} · ${dimensionLabel} · ${
    data.totalGames
  } 场 · 总胜率 ${winRatePct(data.winRate)}${timeStatsSourceNote()}`;

  const qualified = periods.filter((period) => Number(period.games) >= 3);
  const worst = qualified.length
    ? qualified.reduce((current, period) =>
        period.winRate < current.winRate ? period : current,
      )
    : null;
  const mostBad = qualified.length
    ? qualified.reduce((current, period) =>
        period.teammateBadRate > current.teammateBadRate ? period : current,
      )
    : null;
  const badPeriod = mostBad && mostBad.teammateBadGames > 0 ? mostBad : null;

  els.timeStatsSummary.innerHTML = `<div class="time-stat-highlights">
    ${timeStatsHighlight(
      '胜率最低',
      worst,
      `${worst?.games ?? 0} 场 · 胜率 ${winRatePct(worst?.winRate)}`,
    )}
    ${timeStatsHighlight(
      '最常遇到坑',
      badPeriod,
      `队友坑/逃 ${badPeriod?.teammateBadGames ?? 0} 场 · ${pct(
        badPeriod?.teammateBadRate,
      )}`,
    )}
  </div>`;

  els.timeStatsList.innerHTML = periods
    .map((period) => {
      const tone = timeStatsTone(period);
      const badRate = Number(period.teammateBadRate) || 0;
      const noisy = period.games >= 3 && badRate >= 0.5;
      const width = Math.max(0, Math.min(100, (Number(period.winRate) || 0) * 100));
      return `<div class="time-stat-row ${tone}${noisy ? ' noisy' : ''}">
        <span class="time-stat-range">${escapeHtml(period.label)}</span>
        <div class="time-stat-main">
          <div class="time-stat-bar"><span style="width:${width.toFixed(1)}%"></span></div>
          <div class="time-stat-sub">
            ${period.games} 场 · ${period.wins}胜${period.losses}负
            · 队友坑/逃 ${period.teammateBadGames} 场（${pct(badRate)}）
            ${
              period.selfBadGames
                ? `· 自己坑 ${period.selfBadGames} 场`
                : ''
            }
            ${noisy ? '<em class="time-stat-warning">坑多</em>' : ''}
          </div>
        </div>
        <span class="time-stat-rate">${winRatePct(period.winRate)}</span>
      </div>`;
    })
    .join('');
}

function renderTimeStatsScore(data, modeLabel, dimensionLabel, periods) {
  const scoreSummary = data.scoreGames
    ? `均分 ${Number(data.avgScore).toFixed(1)}（${data.scoreGames} 场有评分）`
    : '暂无评分';
  els.timeStatsMeta.textContent = `${modeLabel} · ${dimensionLabel} · ${data.totalGames} 场 · ${scoreSummary}${timeStatsSourceNote()}`;

  if (!data.scoreGames) {
    els.timeStatsSummary.innerHTML = '';
    els.timeStatsList.innerHTML = `<div class="search-status">${escapeHtml(
      `${modeLabel}还没有带评分的对局，多打几局后再来看看`,
    )}</div>`;
    return;
  }

  const qualified = periods.filter((period) => Number(period.scoreGames) >= 3);
  const best = qualified.length
    ? qualified.reduce((current, period) =>
        period.avgScore > current.avgScore ? period : current,
      )
    : null;
  const worst = qualified.length
    ? qualified.reduce((current, period) =>
        period.avgScore < current.avgScore ? period : current,
      )
    : null;

  els.timeStatsSummary.innerHTML = `<div class="time-stat-highlights">
    ${timeStatsHighlight(
      '评分最高',
      best,
      `${best?.scoreGames ?? 0} 场 · 均分 ${Number(best?.avgScore ?? 0).toFixed(1)}`,
    )}
    ${timeStatsHighlight(
      '评分最低',
      worst,
      `${worst?.scoreGames ?? 0} 场 · 均分 ${Number(worst?.avgScore ?? 0).toFixed(1)}`,
    )}
  </div>`;

  els.timeStatsList.innerHTML = periods
    .map((period) => {
      if (!period.scoreGames) {
        return `<div class="time-stat-row empty">
          <span class="time-stat-range">${escapeHtml(period.label)}</span>
          <div class="time-stat-main">
            <div class="time-stat-bar"><span style="width:0%"></span></div>
            <div class="time-stat-sub">${period.games} 场 · 暂无评分</div>
          </div>
          <span class="time-stat-rate">--</span>
        </div>`;
      }
      const tone = timeStatsScoreTone(period);
      const width = Math.max(0, Math.min(100, Number(period.avgScore) || 0));
      return `<div class="time-stat-row ${tone}">
        <span class="time-stat-range">${escapeHtml(period.label)}</span>
        <div class="time-stat-main">
          <div class="time-stat-bar"><span style="width:${width.toFixed(1)}%"></span></div>
          <div class="time-stat-sub">
            ${period.games} 场 · ${period.scoreGames} 场有评分
            · 最高 ${Number(period.bestScore).toFixed(1)}
            · 最低 ${Number(period.worstScore).toFixed(1)}
            · ${period.wins}胜${period.losses}负
          </div>
        </div>
        <span class="time-stat-rate">${Number(period.avgScore).toFixed(1)}</span>
      </div>`;
    })
    .join('');
}

function renderTimeStats(data, mode = state.timeStatsMode) {
  const modeLabel =
    CHAMPION_RANKING_MODE_LABELS[mode] ?? CHAMPION_RANKING_MODE_LABELS.all;
  const view = TIME_STATS_VIEW_LABELS[state.timeStatsView]
    ? state.timeStatsView
    : 'winRate';
  const dimension = TIME_STATS_DIMENSION_LABELS[state.timeStatsDimension]
    ? state.timeStatsDimension
    : 'hour';
  const dimensionLabel = TIME_STATS_DIMENSION_LABELS[dimension];
  const buckets = Array.isArray(data?.dimensions?.[dimension])
    ? data.dimensions[dimension]
    : [];
  if (!data || !data.totalGames || !buckets.length) {
    els.timeStatsMeta.textContent = `${modeLabel} · ${dimensionLabel}`;
    els.timeStatsSummary.innerHTML = '';
    els.timeStatsList.innerHTML = `<div class="search-status">${escapeHtml(
      timeStatsEmptyHint(modeLabel),
    )}</div>`;
    return;
  }

  const periods = buckets.filter((period) => Number(period.games) > 0);
  if (view === 'score') {
    renderTimeStatsScore(data, modeLabel, dimensionLabel, periods);
    return;
  }
  renderTimeStatsWinRate(data, modeLabel, dimensionLabel, periods);
}

async function loadTimeStats() {
  const token = (state.timeStatsToken ?? 0) + 1;
  state.timeStatsToken = token;
  state.timeStatsLoading = true;
  const mode = state.timeStatsMode;
  els.timeStatsMeta.textContent = '';
  els.timeStatsSummary.innerHTML = '';
  els.timeStatsList.innerHTML =
    '<div class="search-status"><span class="spinner"></span><span>正在统计各维度数据…</span></div>';
  try {
    const params = new URLSearchParams();
    if (mode !== 'all') params.set('mode', mode);
    const query = params.toString();
    const response = await fetch(
      `/api/archive/time-stats${query ? `?${query}` : ''}`,
      { cache: 'no-store' },
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.error ?? `HTTP ${response.status}`);
    }
    if (token !== state.timeStatsToken) return;
    state.selfPuuid = payload.puuid ?? state.selfPuuid;
    state.timeStatsSource = payload.source ?? '';
    state.timeStatsData = payload.stats ?? null;
    renderTimeStats(state.timeStatsData, mode);
  } catch (error) {
    if (token !== state.timeStatsToken) return;
    state.timeStatsData = null;
    state.timeStatsSource = 'none';
    els.timeStatsMeta.textContent = '';
    els.timeStatsList.innerHTML = `<div class="search-status error">读取失败：${escapeHtml(
      error instanceof Error ? error.message : String(error),
    )}</div>`;
  } finally {
    if (token === state.timeStatsToken) state.timeStatsLoading = false;
  }
}

function openTimeStats(options = {}) {
  if (!options.keepMode) {
    const context = snapshotContext();
    state.timeStatsMode =
      context?.mode === 'SR' || context?.mode === 'ARENA' || context?.mode === 'ARAM'
        ? context.mode
        : 'ARAM';
  }
  updateTimeStatsTabs();
  els.timeStatsModal.classList.remove('hidden');
  void loadTimeStats();
}

function closeTimeStats() {
  state.timeStatsToken = (state.timeStatsToken ?? 0) + 1;
  state.timeStatsLoading = false;
  els.timeStatsModal.classList.add('hidden');
}

function renderSearchPlayers(players) {
  state.searchPlayers = Array.isArray(players) ? players : [];
  els.searchBoard.replaceChildren(
    ...state.searchPlayers.map((player) =>
      buildCard(player, false, { mode: null, modeLabel: '近期' }),
    ),
  );
}

async function submitSearch(event) {
  event.preventDefault();
  const name = els.searchInput.value.trim();
  if (!name) {
    els.searchInput.focus();
    return;
  }

  els.searchPanel.classList.remove('hidden');
  els.searchTitle.textContent = `查询结果 · ${name}`;
  els.searchStatus.classList.remove('error');
  els.searchStatus.textContent = '正在读取战绩…';
  els.searchBoard.replaceChildren();

  try {
    const response = await fetch(`/api/scan?name=${encodeURIComponent(name)}`, {
      cache: 'no-store',
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.error ?? `HTTP ${response.status}`);
    }
    const players = Array.isArray(payload?.players) ? payload.players : [];
    if (!players.length) {
      els.searchStatus.textContent = '没有查到战绩';
      return;
    }

    renderSearchPlayers(players);
    const games = players[0]?.recent?.games;
    els.searchStatus.textContent = games
      ? `查到 ${players.length} 名玩家，最近 ${games} 场`
      : `查到 ${players.length} 名玩家`;
  } catch (error) {
    els.searchStatus.classList.add('error');
    els.searchStatus.textContent = `查询失败：${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

els.refresh.addEventListener('click', () => void refresh());
els.myMatches.addEventListener('click', () => void openMyMatches());
els.myMatchesTabs.addEventListener('click', (event) => {
  const button = event.target.closest('[data-my-mode]');
  if (!button) return;
  const mode = button.dataset.myMode;
  if (!CHAMPION_RANKING_MODE_LABELS[mode] || mode === state.myMatchesMode) return;
  state.myMatchesMode = mode;
  if (mode === 'SR') state.myMatchesSrMode = 'all';
  updateMyMatchesTabs(true);
  void openMyMatches({ keepFilter: true, keepMode: true, preserveNavigation: true });
});
els.mySrTabs.addEventListener('click', (event) => {
  const button = event.target.closest('[data-sr-mode]');
  if (!button || button.dataset.srMode === state.myMatchesSrMode) return;
  state.myMatchesSrMode = button.dataset.srMode;
  updateMyMatchesTabs(true);
  void openMyMatches({ keepFilter: true, keepMode: true, preserveNavigation: true });
});
els.matchesRangeTabs.addEventListener('click', (event) => {
  const button = event.target.closest('[data-match-range]');
  if (!button) return;
  const range = Number(button.dataset.matchRange) || 0;
  if (range === state.matchesRange) return;
  state.matchesRange = range;
  updateMatchesRangeTabs(true);
  if (state.playerMatches) {
    renderPlayerMatches();
    void fillMatchRange();
  } else if (state.currentView === renderMyMatches) {
    renderMyMatches();
    void fillMatchRange();
  }
});
els.championRanking.addEventListener('click', () => void openChampionRanking());
els.championRankingClose.addEventListener('click', closeChampionRanking);
els.timeStats.addEventListener('click', () => void openTimeStats());
els.timeStatsClose.addEventListener('click', closeTimeStats);
els.timeStatsTabs.addEventListener('click', (event) => {
  const viewButton = event.target.closest('[data-time-view]');
  if (viewButton) {
    const view = viewButton.dataset.timeView;
    if (!TIME_STATS_VIEW_LABELS[view] || view === state.timeStatsView) return;
    state.timeStatsView = view;
    updateTimeStatsTabs();
    if (state.timeStatsData) {
      renderTimeStats(state.timeStatsData, state.timeStatsMode);
    }
    return;
  }
  const button = event.target.closest('[data-time-mode]');
  if (!button) return;
  const mode = button.dataset.timeMode;
  if (!CHAMPION_RANKING_MODE_LABELS[mode] || mode === state.timeStatsMode) {
    return;
  }
  state.timeStatsMode = mode;
  updateTimeStatsTabs();
  void loadTimeStats();
});
els.timeStatsDimension.addEventListener('change', () => {
  const dimension = els.timeStatsDimension.value;
  if (!TIME_STATS_DIMENSION_LABELS[dimension]) return;
  state.timeStatsDimension = dimension;
  if (state.timeStatsData) {
    renderTimeStats(state.timeStatsData, state.timeStatsMode);
  }
});
els.championRankingTabs.addEventListener('click', (event) => {
  const button = event.target.closest('[data-ranking-mode]');
  if (!button) return;
  const mode = button.dataset.rankingMode;
  if (!CHAMPION_RANKING_MODE_LABELS[mode] || mode === state.championRankingMode) {
    return;
  }
  state.championRankingMode = mode;
  updateChampionRankingTabs();
  void loadChampionRanking();
});
els.championRankingSort.addEventListener('change', () => {
  const sort = els.championRankingSort.value;
  if (!CHAMPION_RANKING_SORT_LABELS[sort]) return;
  state.championRankingSort = sort;
  renderChampionRanking(state.championRankingData, state.championRankingMode);
});
els.championRankingList.addEventListener('click', (event) => {
  const row = event.target.closest('[data-champion-id]');
  if (!row) return;
  const championId = Number(row.dataset.championId) || 0;
  if (!championId) return;
  const championName = row.dataset.championName || '';
  const mode =
    state.championRankingMode === 'all' ? undefined : state.championRankingMode;
  closeChampionRanking();
  openChampionMatches(championId, championName, {
    mode,
    back: () => {
      closeMatches();
      openChampionRanking({ keepMode: true });
    },
  });
});
els.latestMatch.addEventListener('click', () => void openLatestMatch());
els.searchForm.addEventListener('submit', (event) => void submitSearch(event));
els.searchClose.addEventListener('click', closeSearch);
els.matchesClose.addEventListener('click', closeMatches);
els.matchesTimeline.addEventListener('click', () => void openMatchTimeline());
els.matchesAi.addEventListener('click', () => void runAiAnalysis());
els.timelineClose.addEventListener('click', closeMatchTimeline);
els.timelinePlayers?.addEventListener('click', (event) => {
  const button = event.target.closest?.('[data-timeline-player]');
  if (!button || !state.timeline?.data) return;
  const participantId = Number(button.dataset.timelinePlayer);
  if (!participantId || participantId === Number(state.timeline.playerId)) return;
  state.timeline.playerId = participantId;
  renderTimeline(state.timeline.data, state.matchDetail, state.timeline.cached);
});
els.liveAi.addEventListener('click', () => void runLiveAiAnalysis());
els.aiClose.addEventListener('click', hideAiView);
els.aiTabs.addEventListener('click', (event) => {
  const button = event.target.closest('[data-ai-tab]');
  if (!button || !state.ai) return;
  state.ai.tab = button.dataset.aiTab === 'live' ? 'live' : 'match';
  renderAiView();
});
els.aiRerun.addEventListener('click', () => {
  if (state.ai?.kind === 'live' || state.ai?.kind === 'champSelect') {
    void runLiveAiAnalysis({ force: true });
  } else void runAiAnalysis({ force: true });
});
els.aiAskForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void askLiveFollowUp(els.aiAskInput.value);
});
els.aiNodeList.addEventListener('click', (event) => {
  const button = event.target.closest?.('[data-ai-node]');
  if (!button) return;
  scrollToFollow(Number(button.dataset.aiNode));
});
els.matchesRefresh.addEventListener('click', () => void refreshMatchesView());
els.matchesBack.addEventListener('click', () => {
  goMatchesBack();
});
els.matchesList.addEventListener('scroll', () => {
  // 滚到接近底部时自动加载更早的对局
  if (state.archiveLoading) return;
  const nearBottom = () => {
    const { scrollTop, clientHeight, scrollHeight } = els.matchesList;
    return scrollTop + clientHeight >= scrollHeight - 200;
  };
  if (state.currentView === renderMyMatches) {
    const button = els.matchesList.querySelector('[data-action="archive-more"]');
    if (button && nearBottom()) void loadMoreArchive(button);
    return;
  }
  if (state.currentView === renderPlayerMatches && !state.playerMatches?.archiveLoading) {
    const button = els.matchesList.querySelector('[data-action="player-more"]');
    if (button && nearBottom()) void loadPlayerMatchesPage();
  }
});
els.matchesList.addEventListener('click', (event) => {
  const more = event.target.closest('[data-action="archive-more"]');
  if (more) {
    void loadMoreArchive(more);
    return;
  }
  const playerMore = event.target.closest('[data-action="player-more"]');
  if (playerMore) {
    void loadPlayerMatchesPage();
    return;
  }
  const row = event.target.closest('[data-game-id]');
  if (!row) return;
  void openMatchDetail(Number(row.dataset.gameId));
});
els.matchTabs.addEventListener('click', (event) => {
  const button = event.target.closest('[data-match-tab]');
  if (!button) return;
  renderMatchTab(button.dataset.matchTab);
});

// 评分、英雄头像和装备的说明都改成点击弹出，用事件委托避免给每张卡片重复绑定
const TIP_ANCHOR_SELECTOR = '[data-champ-id], [data-item-id], .ring[data-score-tip]';

/** 只有本身没有点击动作的头像/装备/评分环才弹说明，避免抢掉查看战绩、切换时间线玩家等操作 */
function tipAnchorFrom(target) {
  if (!(target instanceof Element)) return null;
  const anchor = target.closest(TIP_ANCHOR_SELECTOR);
  if (!anchor) return null;
  return anchor.closest('button, a') ? null : anchor;
}

function toggleTip(anchor) {
  if (anchor.matches('.ring[data-score-tip]')) {
    if (anchor === scoreTipRing) hideScoreTip();
    else showScoreTip(anchor);
    return;
  }
  if (anchor === infoTipAnchor) hideInfoTip();
  else void showInfoTip(anchor);
}

document.addEventListener(
  'click',
  (event) => {
    if (!(event.target instanceof Element)) return;
    // 点在弹窗内部不关闭，方便滚动长内容
    if (event.target.closest('.info-tip, .score-tip')) return;
    const anchor = tipAnchorFrom(event.target);
    if (anchor) {
      event.preventDefault();
      event.stopPropagation();
      toggleTip(anchor);
      return;
    }
    hideInfoTip();
    hideScoreTip();
  },
  true,
);
window.addEventListener(
  'scroll',
  (event) => {
    // 弹窗内部滚动不算页面滚动，否则长内容一滚就关
    if (event.target instanceof Element && event.target.closest('.info-tip, .score-tip')) return;
    hideScoreTip();
    hideInfoTip();
  },
  true,
);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !els.timelineModal.classList.contains('hidden')) {
    closeMatchTimeline();
    return;
  }
  if (event.key === 'Escape' && !els.timeStatsModal.classList.contains('hidden')) {
    closeTimeStats();
    return;
  }
  if (
    event.key === 'Escape' &&
    !els.championRankingModal.classList.contains('hidden')
  ) {
    closeChampionRanking();
    return;
  }
  if (event.key === 'Escape' && !els.aiModal.classList.contains('hidden')) {
    hideAiView();
    return;
  }
  if (event.key === 'Escape' && !els.searchPanel.classList.contains('hidden')) {
    closeSearch();
    return;
  }
  if (event.key.toLowerCase() !== 'r' || event.ctrlKey || event.metaKey || event.altKey) return;
  const target = event.target;
  if (target instanceof HTMLElement) {
    const tag = target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;
  }
  event.preventDefault();
  void refresh();
});

initAiAskChips();
fetchSnapshot();
void loadItemIcons();
void loadAiStatus();
if (!STATIC_MODE) {
  connectStream();
  setInterval(fetchSnapshot, 20_000);
}

const initialPlayer = new URLSearchParams(window.location.search).get('player');
if (initialPlayer) {
  els.searchInput.value = initialPlayer;
  void submitSearch({ preventDefault() {} });
}
