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
  matchTabs: document.getElementById('match-tabs'),
  matchMeta: document.getElementById('match-meta'),
  matchProgress: document.getElementById('match-progress'),
  matchSummary: document.getElementById('match-summary'),
  matchFlags: document.getElementById('match-flags'),
  aiModal: document.getElementById('ai-modal'),
  aiModalTitle: document.getElementById('ai-modal-title'),
  aiMeta: document.getElementById('ai-meta'),
  aiBody: document.getElementById('ai-body'),
  aiTabs: document.getElementById('ai-tabs'),
  aiClose: document.getElementById('ai-close'),
  aiRerun: document.getElementById('ai-rerun'),
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
  clearCache: document.getElementById('clear-cache'),
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

const CHAMPION_RANKING_SORT_LABELS = {
  avg: '平均分',
  games: '场次',
  winRate: '胜率',
  best: '最高分',
};

const TIME_STATS_DIMENSION_LABELS = {
  hour: '按时段',
  weekday: '按星期',
  week: '按周',
  month: '按月',
  position: '按位置',
  type: '按类型',
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
  /** “我的战绩”当前模式的总胜负（来自历史存档） */
  modeRecord: null,
  /** 非空时“我的战绩”只显示该英雄的对局 */
  championFilter: null,
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
  /** 时段胜率统计维度：hour / weekday / week / month */
  timeStatsDimension: 'hour',
  timeStatsData: null,
  timeStatsSource: '',
  timeStatsToken: 0,
  timeStatsLoading: false,
  /** 查看玩家战绩时的分页状态 */
  playerMatches: null,
  itemIcons: null,
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

function ratingColor(rating, stats) {
  if (rating === null || rating === undefined) return '#5b6b8c';
  if (isInactiveKda(stats)) return '#7c8aa5';
  if (rating >= 80) return '#3ddc97';
  if (rating >= 70) return '#5eead4';
  if (rating >= 60) return '#f5c76a';
  if (rating >= 50) return '#ffab5e';
  if (rating >= 40) return '#d46a8f';
  return '#ff6b81';
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

function iconHtml(assetPath, label, size, title) {
  const text = String(label ?? '?');
  const hue = hueFor(text);
  const image = assetPath
    ? `<img src="/api/asset?path=${encodeURIComponent(assetPath)}" alt="" loading="lazy" onerror="this.remove()" />`
    : '';
  return `<span class="icon ${size}" title="${escapeHtml(title ?? '')}" style="--hue:${hue}"><span class="fb">${escapeHtml(
    text.slice(0, 1),
  )}</span>${image}</span>`;
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

  if (!snapshot?.inGame && state.ai?.kind === 'live') resetAiView();

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
    const node = buildCard(player, isLocal, {
      liveView,
      context: snapshotContext(),
    });
    node.dataset.key = key;
    // 只有新出现的卡片才播放入场动画，避免数据刷新时整块闪一下
    if (!currentKeys.has(key)) enterCard(node);
    cardCache.set(key, { sig, node });
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

  els.aramHint.textContent = `当前英雄 + 替补席 ${options.length} 个 · 点击查看我的英雄战绩`;
  const nodes = options.map((option) => {
    const mine = option.games > 0 ? winRatePct(option.winRate) : '未使用';
    const overall = option.globalGames > 0 ? winRatePct(option.globalWinRate) : '-';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `aram-champion${option.isCurrent ? ' current' : ''}`;
    button.title = `${option.championName}：本地存档整体 ${overall}${
      option.globalGames ? `（${option.globalGames} 场）` : ''
    }；我的 ${mine}${option.games ? `（${option.games} 场）` : ''}`;
    button.innerHTML = `
      <span class="aram-champ-icon">${iconHtml(
        champPath(option.championId),
        option.championName,
        'sm',
      )}</span>
      <span class="aram-champ-main">
        <span class="aram-champ-name">${escapeHtml(option.championName)}${
          option.isCurrent ? '<em class="aram-current">当前</em>' : ''
        }${option.isPriority ? '<em class="aram-priority">优先</em>' : ''}</span>
        <span class="aram-champ-stats">
          <span class="aram-stat"><small>整体</small><b>${overall}</b>${
            option.globalGames ? `<em>${option.globalGames}场</em>` : ''
          }</span>
          <span class="aram-stat mine"><small>我的</small><b>${mine}</b>${
            option.games ? `<em>${option.games}场</em>` : ''
          }</span>
        </span>
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

function buildCard(player, isLocal, options = {}) {
  const recent = player.recent;
  const games = player.games ?? [];
  // 对局详情里展示的是“本局评分”，而不是近期综合评分
  const thisGame = options.thisGame;
  const rating = thisGame?.score ?? player.rating;
  const grade = thisGame?.grade ?? player.grade;
  const color = ratingColor(rating, thisGame);
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
      rawLabels.find((label) => label === '巨坑' || label === '坑' || label === '小坑') ??
      null
    : null;
  const labels = rawLabels
    .filter(
      (label) =>
        label !== 'MVP' &&
        label !== 'SVP' &&
        label !== '巨坑' &&
        label !== '坑' &&
        label !== '小坑',
    )
    .slice(0, 5);
  const risk = recent?.risk;
  const risky = Boolean(risk && (risk.level === 'high' || risk.level === 'severe'));
  const baseline = player.baseline;
  const championStats = player.championStats;
  const cardMode = options.mode === undefined ? state.snapshot?.gameMode : options.mode;
  const modeName = options.modeLabel ?? currentModeLabel();
  // 大乱斗/竞技场没有常规眼位，不展示视野相关指标
  const visionGame = cardMode !== 'ARAM' && cardMode !== 'ARENA';

  const card = document.createElement('article');
  card.className = `card${isLocal ? ' is-local' : ''}${
    !thisGame && risk?.level === 'severe' ? ' is-risk' : ''
  }${player.isEnemy ? ' is-enemy' : ''}${
    bestTag === 'MVP' ? ' is-mvp' : bestTag === 'SVP' ? ' is-svp' : ''
  }${
    badTag === '巨坑'
      ? ' is-bad-severe'
      : badTag === '坑'
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
          return `<span class="chip${gold ? ' gold' : ''}${svp ? ' svp' : ''}${danger ? ' danger' : ''}">${escapeHtml(label)}</span>`;
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
        badTag === '巨坑' ? 'severe' : badTag === '坑' ? 'bad' : 'mild'
      }">${badTag}</span>`
    : '';

  const record = thisGame
    ? `本局 · <b class="${thisGame.win ? 'win' : 'loss'}">${thisGame.win ? '胜' : '负'}</b> · ${
        thisGame.durationMin ?? '-'
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
      return `<div class="game ${game.win ? 'win' : 'loss'}" title="${escapeHtml(title)}">${iconHtml(
        champPath(game.championId),
        game.championName,
        'chip',
      )}<span class="res">${game.win ? 'W' : 'L'}</span></div>`;
    })
    .join('');

  const metrics = recent
    ? `<div class="metrics">
        <div class="metric"><span>近期胜率</span><b>${winRatePct(recent.winRate)}</b></div>
        <div class="metric"><span>KDA</span><b>${num(recent.avgKda, 2)}</b></div>
        <div class="metric"><span>参团率</span><b>${pct(recent.avgKillParticipation)}</b></div>
        <div class="metric"><span>分均伤害</span><b>${Math.round(recent.avgDamagePerMin ?? 0)}</b></div>
        <div class="metric"><span>伤害占比</span><b>${pct(recent.avgDamageShare)}</b></div>
        <div class="metric"><span>分均补刀</span><b>${num(recent.avgCsPerMin, 1)}</b></div>
        ${
          visionGame
            ? `<div class="metric"><span>分均视野</span><b>${num(recent.avgVisionPerMin, 2)}</b></div>`
            : ''
        }
        <div class="metric"><span>场均死亡</span><b>${num(recent.avgDeaths, 1)}</b></div>
        <div class="metric"><span>场均伤害</span><b>${kilo(recent.avgDamage)}</b></div>
        <div class="metric"><span>场均治疗</span><b>${kilo(recent.avgHeal ?? 0)}</b></div>
        ${
          recent.afkGames
            ? `<div class="metric afk-metric"><span>疑似挂机</span><b>${recent.afkGames} 场</b></div>`
            : ''
        }
      </div>`
    : '';

  // 大乱斗英雄随机，“常用英雄”没有参考意义
  const champions = cardMode !== 'ARAM' && recent?.topChampions?.length
    ? `<div class="champs"><span>常用</span>${recent.topChampions
        .map(
          (champion) =>
            `<span class="champ-mini">${iconHtml(
              champPath(champion.championId),
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
  const pickedContent = `${iconHtml(
    championId ? champPath(championId) : null,
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
    : liveRow;

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

  const itemIds = thisGame
    ? thisGame.items
    : options.liveView
      ? live?.items
      : undefined;
  // 装备数据可能比页面晚到（客户端刚启动），看到装备格时再补拉一次
  if (itemIds?.length && !(state.itemIcons && Object.keys(state.itemIcons).length)) {
    void loadItemIcons();
  }
  const itemRow =
    itemIds?.length
      ? `<div class="items">${itemIds
          .map((itemId) => {
            const meta = state.itemIcons?.[String(itemId)];
            return iconHtml(meta?.icon ?? null, meta?.name ?? String(itemId), 'sm', meta?.name);
          })
          .join('')}</div>`
      : '';

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

  const liveMetrics = options.liveView && live
    ? `<div class="metrics live-metrics">
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
      </div>`
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
          <span>${escapeHtml(rankLabel(player.rank))}</span>
          ${streak}
        </div>
      </div>
      ${picked}
    </div>

    <div class="score-row">
      <div class="ring${!thisGame && player.loading && !recent ? ' loading' : ''}" style="--p:${rating ?? 0};--ring:${color}">
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

    ${thisGame ? gameRow : liveRow}
    ${thisGame ? radarBlock : ''}
    ${thisGame ? timelineBlock : ''}
    ${thisGame ? thisGameMetrics : liveMetrics}
    ${thisGame || options.liveView ? itemRow : ''}
    ${thisGame ? '' : gameChips ? `<div class="games">${gameChips}</div>` : ''}
    ${thisGame ? '' : sparkBlock}
    ${thisGame ? '' : loading}
    ${thisGame ? '' : metrics}
    ${thisGame ? '' : riskNote}
    ${thisGame ? '' : afkNote}
    ${thisGame ? '' : championUsage}
    ${thisGame ? '' : champions}
    ${thisGame ? '' : error}
    ${detail}
  `;
  const matchesButton = card.querySelector('[data-action="matches"]');
  if (matchesButton) {
    matchesButton.addEventListener('click', () => openMatches(player, options.context));
  }
  const championLinkEl = card.querySelector('[data-action="champion-matches"]');
  if (championLinkEl) {
    championLinkEl.addEventListener('click', () =>
      openChampionMatches(championId, championName),
    );
  }

  return card;
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
  els.liveAi.classList.toggle(
    'hidden',
    !(snapshot?.inGame && players.length > 0 && snapshot.localPlayer),
  );
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

async function clearCache() {
  if (els.clearCache.disabled) return;
  els.clearCache.disabled = true;
  els.notice.classList.add('hidden');
  try {
    const response = await fetch('/api/cache/clear', { method: 'POST' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.error ?? `HTTP ${response.status}`);
    }
    els.notice.textContent = '战绩缓存已清空，下次读取会重新拉取';
    els.notice.classList.remove('hidden');
    setTimeout(() => els.notice.classList.add('hidden'), 5000);
  } catch (error) {
    els.notice.textContent = `清缓存失败：${
      error instanceof Error ? error.message : String(error)
    }`;
    els.notice.classList.remove('hidden');
    setTimeout(() => els.notice.classList.add('hidden'), 8000);
  } finally {
    els.clearCache.disabled = false;
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

function setAiButton(running) {
  for (const button of [els.matchesAi, els.liveAi]) {
    button.disabled = Boolean(running);
    button.classList.toggle('loading', Boolean(running));
    button.innerHTML = running
      ? '<span class="spinner"></span>分析中…'
      : '✨ AI 分析';
  }
  els.matchesAi.title = running
    ? '正在生成 AI 复盘分析…'
    : state.aiStatus?.enabled === false
      ? 'AI 分析未配置：在 .env 设置 LOL_MATE_AI_API_KEY 后重启面板'
      : `用 AI 复盘本局（${state.aiStatus?.model ?? 'DeepSeek V4.1 Flash'}）`;
  els.liveAi.title = running
    ? '正在生成出装和打法建议…'
    : state.aiStatus?.enabled === false
      ? 'AI 分析未配置：在 .env 设置 LOL_MATE_AI_API_KEY 后重启面板'
      : `AI 出装、技能与打法建议（${state.aiStatus?.model ?? 'DeepSeek V4.1 Flash'}）`;
}

function hideAiView() {
  els.aiModal.classList.add('hidden');
}

function resetAiView() {
  state.ai?.controller?.abort();
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

function aiMarkdown(text) {
  const lines = escapeHtml(text).split(/\r?\n/);
  let html = '';
  for (const raw of lines) {
    let line = raw.trimEnd();
    if (!line.trim()) {
      html += '<div class="ai-gap"></div>';
      continue;
    }
    line = line
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      html += `<h4>${heading[1]}</h4>`;
      continue;
    }
    const numbered = /^(\d+)[.、)]\s+(.*)$/.exec(line);
    if (numbered) {
      html += `<p class="ai-num"><span>${numbered[1]}</span>${numbered[2]}</p>`;
      continue;
    }
    if (/^[-*•]\s*/.test(line)) {
      html += `<p class="ai-bullet">${line.replace(/^[-*•]\s*/, '')}</p>`;
      continue;
    }
    html += `<p>${line}</p>`;
  }
  return html;
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

  els.aiModalTitle.textContent = ai.title ? `✨ AI 复盘 · ${ai.title}` : '✨ AI 复盘';
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
    liveTab && !String(ai.text ?? '').trim() ? '生成赛后复盘' : '重新分析';

  if (liveTab) {
    const savedAt = ai.live.savedAt ? ` · 对局中保存 ${formatGameTime(ai.live.savedAt)}` : '';
    els.aiMeta.textContent = `${ai.live.model ?? ai.model ?? 'AI'}${savedAt}`;
  } else {
    renderAiMeta(ai);
  }

  const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
  if (liveTab) {
    body.innerHTML = `<div class="ai-content">${aiMarkdown(ai.live.content)}</div><div class="ai-foot">这段建议来自对局进行中的实时数据，赛后不会再更新</div>`;
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
        : `<div class="ai-foot">内容由 AI 根据本局数据生成，仅供参考</div>`;
    body.innerHTML = `<div class="ai-content">${aiMarkdown(ai.text)}${cursor}</div>${foot}`;
  }
  if (nearBottom) body.scrollTop = body.scrollHeight;
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

async function runLiveAiAnalysis(options = {}) {
  const snapshot = state.snapshot;
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

  await streamAiAnalysis('/api/live/ai', { kind: 'live', sessionKey, title });
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
      const badMatch = /^(队友|敌方|自己)(小坑|坑|巨坑)$/.exec(tag);
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
  return `${champion}（${player.name}）`;
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
  els.matchFlags.classList.add('hidden');
  clearMatchSummary();
}

function matchRow(game, showScore) {
  const durationMin = game.durationMin ?? Math.round((Number(game.gameDuration) || 0) / 60);
  const score = showScore && Number.isFinite(Number(game.score)) ? Math.round(game.score) : null;
  const tags = game.tags ?? [];
  const remake = tags.includes('重开');
  const bestTag = remake ? null : tags.includes('MVP') ? 'MVP' : tags.includes('SVP') ? 'SVP' : null;
  const selfBadTag = remake
    ? null
    : tags.find((tag) => /^自己(小坑|坑|巨坑)$/.test(tag)) ?? null;
  const selfBadLevel = selfBadTag
    ? selfBadTag.includes('巨坑')
      ? 'severe'
      : selfBadTag.includes('小坑')
        ? 'mild'
        : 'bad'
    : null;
  const displayTags = (remake ? tags.filter((tag) => tag !== '重开') : tags).filter(
    (tag) => tag !== 'MVP' && tag !== 'SVP' && tag !== selfBadTag,
  );
  const bestBadge = bestTag
    ? `<span class="best-badge ${bestTag === 'MVP' ? 'mvp' : 'svp'}">${bestTag}</span>`
    : '';
  const selfBadBadge = selfBadTag
    ? `<span class="self-bad-badge ${selfBadLevel}">${selfBadTag}</span>`
    : '';
  return `<button class="game-row match-item ${
    remake ? 'remake' : game.win ? '' : 'loss'
  }${bestTag ? ` has-${bestTag.toLowerCase()}` : ''}${
    selfBadTag ? ` has-self-bad self-bad-${selfBadLevel}` : ''
  }" type="button" data-game-id="${game.gameId}">
    <span class="result">${remake ? '重开' : game.win ? '胜' : '负'}</span>
    <span class="who">${iconHtml(
      champPath(game.championId),
      game.championName,
      'sm',
    )}<b>${escapeHtml(game.championName ?? '未知英雄')}</b>${bestBadge}${selfBadBadge}<small>${escapeHtml(
      game.queueName ?? '',
    )} · ${durationMin} 分钟 · ${formatGameTime(game.gameCreation)}${
      displayTags?.length ? ` · ${matchFlagsHtml(displayTags)}` : ''
    }</small></span>
    <span class="kda">${game.kills}/${game.deaths}/${game.assists}</span>
    <span class="pts"${score === null ? '' : ` style="color:${ratingColor(score, game)}"`}>${
      score === null ? (showScore ? '--' : '›') : score
    }</span>
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
      const rankClass =
        metric.rank === 1
          ? 'rank-1'
          : metric.rank <= 3
            ? 'rank-top'
            : metric.rank >= 8
              ? 'rank-low'
              : 'rank-mid';
      return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}" class="radar-label ${rankClass}">
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
    .find((tag) => /^自己(小坑|坑|巨坑)$/.test(tag))
    ?.replace(/^自己/, '');
  const radarContext = buildRadarContext(scoreboard);

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

function renderMatchesView(games, title, showScore) {
  stopLoadingTimer();
  setMatchProgress('');
  state.matchDetail = null;
  state.matchTab = 'scoreboard';
  resetAiView();
  clearMatchFlags();
  els.matchesAi.classList.add('hidden');
  els.matchesModal.classList.remove('hidden');
  els.matchesModal.querySelector('.modal-card')?.classList.remove('wide');
  els.matchTabs.classList.add('hidden');
  els.matchesTitle.textContent = title;
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
  renderMatchesView(page.games, page.title, true);
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
  void loadPlayerMatchesPage();
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

function filteredMyGames() {
  const filter = state.championFilter;
  const games = state.myGames ?? [];
  if (!filter) return games;
  return games.filter((game) => Number(game.championId) === filter.championId);
}

function renderMyMatches() {
  const games = filteredMyGames();
  const filter = state.championFilter;
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
      : `我的战绩${count}${stats}`,
    true,
  );
  els.matchesList.scrollTop = scrollTop;
  state.currentView = renderMyMatches;
  setMatchesRefresh(() =>
    openMyMatches({ keepFilter: true, preserveNavigation: true }),
  );

  const archiveRemaining = Math.max(0, state.archiveTotal - state.archiveLoaded);
  const hasMore = !state.lcuExhausted || archiveRemaining > 0;
  if (filter && !games.length) {
    const empty = els.matchesList.querySelector('.search-status');
    if (empty) {
      empty.textContent = hasMore
        ? `已加载的战绩里没有 ${filter.championName || '该英雄'}，可以继续加载更早的战绩`
        : `没有找到 ${filter.championName || '该英雄'} 的战绩`;
    }
  }
  if (hasMore) {
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
    const hasNew = (list) => list.some((game) => !knownIds.has(String(game.gameId)));
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
          if (hasNew(page)) {
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
  if (!options.preserveNavigation) {
    state.backStack = [];
    state.backScrollStack = [];
  }
  state.currentView = null;
  state.matchRequestToken += 1;
  const token = state.matchRequestToken;
  const context = matchesContext();
  state.matchDetail = null;
  state.playerMatches = null;
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
  els.matchesModal.querySelector('.modal-card')?.classList.remove('wide');
  updateMatchesBackButton();
  els.matchesTitle.textContent = filter ? championFilterTitle(filter) : '我的最近战绩';
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
      const response = await fetch('/api/archive/matches?limit=100&offset=0', {
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

  const recordContext =
    context ?? (games[0]?.queueId ? { queueId: games[0].queueId } : undefined);
  const championId = filter?.championId;
  const modeRecord = await fetchModeRecord(
    undefined,
    championId
      ? filter?.mode
        ? { mode: filter.mode }
        : undefined
      : recordContext,
    championId,
  );
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
      openMyMatches({ keepFilter: true, preserveNavigation: true }),
    );
    return;
  }

  renderMyMatches();
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

function renderMatchDetailView(detail, tab = 'scoreboard') {
  stopLoadingTimer();
  state.matchDetail = detail;
  state.matchTab = tab;
  state.currentView = () => renderMatchDetailView(detail, tab);
  // 用点击时的当前页签，保证在「近期战绩」里更新后不会跳回「本局详情」
  setMatchesRefresh(() =>
    openMatchDetail(detail.gameId, { push: false, tab: state.matchTab, force: true }),
  );
  els.matchesModal.classList.remove('hidden');
  els.matchesModal.querySelector('.modal-card')?.classList.add('wide');
  els.matchTabs.classList.remove('hidden');
  els.matchesAi.classList.remove('hidden');
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
  els.matchesModal.querySelector('.modal-card')?.classList.add('wide');
  els.matchTabs.classList.add('hidden');
  resetAiView();
  clearMatchFlags();
  els.matchesAi.classList.add('hidden');
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
  els.matchesModal.classList.add('hidden');
  els.matchesList.replaceChildren();
  els.matchTabs.classList.add('hidden');
  clearMatchFlags();
  els.matchesAi.classList.add('hidden');
  els.matchesBack.classList.add('hidden');
  setMatchesRefresh(null);
  els.matchesModal.querySelector('.modal-card')?.classList.remove('wide');
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
      return `<button class="champion-rank-row" type="button" data-champion-id="${
        Number(item.championId) || 0
      }" data-champion-name="${escapeHtml(name)}">
        <span class="champion-rank-no ${rankingClass(rank)}">${rank}</span>
        ${iconHtml(champPath(item.championId), name, 'sm')}
        <span class="champion-rank-main">
          <b>${escapeHtml(name)}</b>
          <small>${Number(item.games) || 0} 场 · 胜率 ${winRatePct(item.winRate)}</small>
        </span>
        <span class="champion-rank-stats">
          <span class="champion-rank-score" style="color:${ratingColor(avg)}">${num(
            avg,
            1,
          )}</span>
          <small>平均分</small>
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

function updateTimeStatsTabs() {
  if (!els.timeStatsTabs) return;
  for (const button of els.timeStatsTabs.querySelectorAll('[data-time-mode]')) {
    button.classList.toggle('active', button.dataset.timeMode === state.timeStatsMode);
  }
  if (els.timeStatsDimension) {
    els.timeStatsDimension.value = TIME_STATS_DIMENSION_LABELS[state.timeStatsDimension]
      ? state.timeStatsDimension
      : 'hour';
  }
}

function renderTimeStats(data, mode = state.timeStatsMode) {
  const modeLabel =
    CHAMPION_RANKING_MODE_LABELS[mode] ?? CHAMPION_RANKING_MODE_LABELS.all;
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
    const hint =
      state.timeStatsSource === 'none'
        ? '没有读到历史战绩，先在「我的战绩」里加载一些对局，或启动客户端后再试'
        : `${modeLabel}还没有足够的对局，多打几局后再来看看`;
    els.timeStatsList.innerHTML = `<div class="search-status">${escapeHtml(hint)}</div>`;
    return;
  }

  const sourceNote =
    state.timeStatsSource === 'recent' ? ' · 最近 100 场（该模式暂无历史存档）' : '';
  els.timeStatsMeta.textContent = `${modeLabel} · ${dimensionLabel} · ${
    data.totalGames
  } 场 · 总胜率 ${winRatePct(data.winRate)}${sourceNote}`;

  const periods = buckets.filter((period) => Number(period.games) > 0);
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

  const highlight = (label, period, detail) =>
    period
      ? `<div class="time-stat-highlight">
          <span>${label}</span>
          <b>${escapeHtml(period.label)}</b>
          <small>${detail}</small>
        </div>`
      : '';

  els.timeStatsSummary.innerHTML = `<div class="time-stat-highlights">
    ${highlight(
      '胜率最低',
      worst,
      `${worst?.games ?? 0} 场 · 胜率 ${winRatePct(worst?.winRate)}`,
    )}
    ${highlight(
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

async function loadTimeStats() {
  const token = (state.timeStatsToken ?? 0) + 1;
  state.timeStatsToken = token;
  state.timeStatsLoading = true;
  const mode = state.timeStatsMode;
  els.timeStatsMeta.textContent = '';
  els.timeStatsSummary.innerHTML = '';
  els.timeStatsList.innerHTML =
    '<div class="search-status"><span class="spinner"></span><span>正在统计各维度胜率…</span></div>';
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
els.championRanking.addEventListener('click', () => void openChampionRanking());
els.championRankingClose.addEventListener('click', closeChampionRanking);
els.timeStats.addEventListener('click', () => void openTimeStats());
els.timeStatsClose.addEventListener('click', closeTimeStats);
els.timeStatsTabs.addEventListener('click', (event) => {
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
els.timeStatsModal.addEventListener('click', (event) => {
  if (event.target === els.timeStatsModal) closeTimeStats();
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
els.championRankingModal.addEventListener('click', (event) => {
  if (event.target === els.championRankingModal) closeChampionRanking();
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
els.clearCache.addEventListener('click', () => void clearCache());
els.searchForm.addEventListener('submit', (event) => void submitSearch(event));
els.searchClose.addEventListener('click', closeSearch);
els.matchesClose.addEventListener('click', closeMatches);
els.matchesAi.addEventListener('click', () => void runAiAnalysis());
els.liveAi.addEventListener('click', () => void runLiveAiAnalysis());
els.aiClose.addEventListener('click', hideAiView);
els.aiTabs.addEventListener('click', (event) => {
  const button = event.target.closest('[data-ai-tab]');
  if (!button || !state.ai) return;
  state.ai.tab = button.dataset.aiTab === 'live' ? 'live' : 'match';
  renderAiView();
});
els.aiRerun.addEventListener('click', () => {
  if (state.ai?.kind === 'live') void runLiveAiAnalysis({ force: true });
  else void runAiAnalysis({ force: true });
});
els.aiModal.addEventListener('click', (event) => {
  if (event.target === els.aiModal) hideAiView();
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

document.addEventListener('keydown', (event) => {
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
