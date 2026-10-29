/* global EventSource, fetch */

const els = {
  board: document.getElementById('board'),
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
  myMatches: document.getElementById('my-matches'),
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

const state = {
  snapshot: null,
  snapshotSig: '',
  live: false,
  refreshing: false,
  selfPuuid: '',
  matchesBack: null,
  loadingTimer: null,
  loadingProgress: null,
};

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

function ratingColor(rating) {
  if (rating === null || rating === undefined) return '#5b6b8c';
  if (rating >= 75) return '#3ddc97';
  if (rating >= 65) return '#5eead4';
  if (rating >= 55) return '#f5c76a';
  if (rating >= 45) return '#ffab5e';
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

function num(value, digits = 1, fallback = '-') {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return fallback;
  return Number(value).toFixed(digits);
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

function iconHtml(assetPath, label, size) {
  const text = String(label ?? '?');
  const hue = hueFor(text);
  const image = assetPath
    ? `<img src="/api/asset?path=${encodeURIComponent(assetPath)}" alt="" loading="lazy" onerror="this.remove()" />`
    : '';
  return `<span class="icon ${size}" style="--hue:${hue}"><span class="fb">${escapeHtml(
    text.slice(0, 1),
  )}</span>${image}</span>`;
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

  document.title = players.length ? `(${players.length}) 队友战绩 · LoL` : '队友战绩 · LoL';

  els.empty.classList.toggle('hidden', players.length > 0 || showSkeleton);
  els.board.classList.toggle('hidden', players.length === 0 && !showSkeleton);

  if (showSkeleton) {
    els.board.replaceChildren(...Array.from({ length: 5 }, () => skeletonCard()));
  } else if (players.length) {
    renderBoard(players);
  } else {
    els.board.replaceChildren();
    cardCache.clear();
  }

  renderHeader(snapshot, players, collecting);
  renderEmpty(snapshot);
}

function renderBoard(players) {
  const localId = state.snapshot?.localPlayer?.summonerId;
  const localName = state.snapshot?.localPlayer?.displayName;
  const currentKeys = new Set([...els.board.children].map((node) => node.dataset.key));
  const nodes = players.map((player) => {
    const key = String(player.puuid ?? (player.summonerId || player.displayName));
    const isLocal = player.summonerId
      ? player.summonerId === localId
      : Boolean(localName && player.displayName === localName);
    const sig = `${key}|${isLocal}|${JSON.stringify(player)}`;
    const cached = cardCache.get(key);
    if (cached && cached.sig === sig) return cached.node;
    const node = buildCard(player, isLocal);
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
  const rating = player.rating;
  const color = ratingColor(rating);
  const name = player.displayName ?? '未知召唤师';
  const tag = player.tagLine;
  const labels = (player.labels ?? []).slice(0, 4);
  const risk = recent?.risk;
  const risky = Boolean(risk && (risk.level === 'high' || risk.level === 'severe'));
  const cardMode = options.mode === undefined ? state.snapshot?.gameMode : options.mode;
  const modeName = options.modeLabel ?? currentModeLabel();

  const card = document.createElement('article');
  card.className = `card${isLocal ? ' is-local' : ''}${risk?.level === 'severe' ? ' is-risk' : ''}${
    player.isEnemy ? ' is-enemy' : ''
  }`;
  card.style.setProperty('--ring-color', color);
  card.style.setProperty('--ring-glow', hexToRgba(color, 0.2));

  const profilePath = player.profileIconId
    ? `/lol-game-data/assets/v1/profile-icons/${player.profileIconId}.jpg`
    : null;

  const streak =
    recent?.streak && recent.streak.count >= 2
      ? `<span class="dot-sep">·</span><span>${recent.streak.count}${recent.streak.type === 'win' ? '连胜' : '连败'}</span>`
      : '';

  const chips = labels.length
    ? `<div class="chips">${labels
        .map((label) => {
          const danger = [
            '坑',
            '偏坑',
            '疑似新手',
            '伤害过低',
            '常挂机',
            '疑似挂机',
          ].includes(label);
          const gold = label === '大腿';
          return `<span class="chip${gold ? ' gold' : ''}${danger ? ' danger' : ''}">${escapeHtml(label)}</span>`;
        })
        .join('')}</div>`
    : recent
      ? `<div class="chips"><span class="chip muted-chip">近况平稳</span></div>`
      : '';

  const record = recent
    ? `${modeName} ${recent.games} 场 · <b class="win">${recent.wins}胜</b> <b class="loss">${recent.losses}负</b> · 胜率 ${pct(
        recent.winRate,
      )}`
    : '暂无战绩数据';

  const riskPill = risky
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
        <div class="metric"><span>近期胜率</span><b>${pct(recent.winRate)}</b></div>
        <div class="metric"><span>KDA</span><b>${num(recent.avgKda, 2)}</b></div>
        <div class="metric"><span>参团率</span><b>${pct(recent.avgKillParticipation)}</b></div>
        <div class="metric"><span>分均伤害</span><b>${Math.round(recent.avgDamagePerMin ?? 0)}</b></div>
        <div class="metric"><span>伤害占比</span><b>${pct(recent.avgDamageShare)}</b></div>
        <div class="metric"><span>分均补刀</span><b>${num(recent.avgCsPerMin, 1)}</b></div>
        <div class="metric"><span>分均视野</span><b>${num(recent.avgVisionPerMin, 2)}</b></div>
        <div class="metric"><span>场均死亡</span><b>${num(recent.avgDeaths, 1)}</b></div>
        <div class="metric"><span>场均伤害</span><b>${kilo(recent.avgDamage)}</b></div>
        ${
          recent.afkGames
            ? `<div class="metric afk-metric"><span>疑似挂机</span><b>${recent.afkGames} 场</b></div>`
            : ''
        }
      </div>`
    : '';

  const champions = recent?.topChampions?.length
    ? `<div class="champs"><span>常用</span>${recent.topChampions
        .map(
          (champion) =>
            `<span class="champ-mini">${iconHtml(
              champPath(champion.championId),
              champion.name,
              'sm',
            )}<b>${escapeHtml(champion.name)}</b><em>${champion.games}场 ${pct(champion.winRate)}</em></span>`,
        )
        .join('')}</div>`
    : '';

  const detail = games.length
    ? `<button class="btn matches-btn" type="button" data-action="matches">查看最近 ${games.length} 场战绩</button>`
    : '';

  const error = player.error
    ? `<div class="card-error">${escapeHtml(player.error)}</div>`
    : '';

  const loading =
    player.loading && !recent
      ? '<div class="card-loading"><span class="spinner"></span>正在读取近期战绩…</div>'
      : '';

  const live = player.live;
  const liveRow = live
    ? `<div class="live-row">
        <span class="live-tag">本局</span>
        <span class="live-kda">${live.kills} / <b class="loss">${live.deaths}</b> / ${live.assists}</span>
        <span class="live-stat">补刀 <b>${Math.round(live.cs ?? 0)}</b></span>
        <span class="live-stat">等级 <b>${live.championLevel ?? '-'}</b></span>
        <span class="live-stat">视野 <b>${num(live.wardScore, 0)}</b></span>
        ${live.isDead ? '<span class="live-dead">已阵亡</span>' : ''}
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
          ${player.isEnemy ? '<span class="side-badge enemy">敌方</span>' : ''}
          ${player.isBot ? '<span class="bot-badge">人机</span>' : ''}
        </div>
        <div class="sub">
          <span class="pos-pill">${escapeHtml(positionLabel(player, cardMode))}</span>
          <span>${escapeHtml(rankLabel(player.rank))}</span>
          ${streak}
        </div>
      </div>
      <div class="picked">
        ${iconHtml(player.championId ? champPath(player.championId) : null, player.championName ?? '?', 'champ')}
        <span class="champ-name">${escapeHtml(player.championName ?? '未选英雄')}</span>
      </div>
    </div>

    <div class="score-row">
      <div class="ring${player.loading && !recent ? ' loading' : ''}" style="--p:${rating ?? 0};--ring:${color}">
        <div class="ring-inner"><b>${rating ?? '--'}</b><small>评分</small></div>
      </div>
      <div class="score-meta">
        <div class="meta-top">
          <span class="grade">${player.grade ?? '?'}</span>
          <span class="record">${record}</span>
          ${riskPill}
        </div>
        ${chips}
      </div>
    </div>

    ${liveRow}
    ${gameChips ? `<div class="games">${gameChips}</div>` : ''}
    ${loading}
    ${metrics}
    ${riskNote}
    ${afkNote}
    ${champions}
    ${error}
    ${detail}
  `;

  const matchesButton = card.querySelector('[data-action="matches"]');
  if (matchesButton) {
    matchesButton.addEventListener('click', () => openMatches(player));
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
      els.status.textContent = `本局 ${allies} 己方 / ${enemies} 敌方 · 实时数据${
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
  els.recentHint.textContent = recent
    ? `${currentModeLabel()}最近 ${recent.games} 场 · 评分 0-100`
    : snapshot?.inGame
      ? '本局实时数据 · 评分来自最近对局'
      : '';
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

/* ------------------------------------------------------------------ */
/* 玩家查询                                                            */
/* ------------------------------------------------------------------ */

function closeSearch() {
  els.searchPanel.classList.add('hidden');
  els.searchBoard.replaceChildren();
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

function matchRow(game, showScore) {
  const durationMin = game.durationMin ?? Math.round((Number(game.gameDuration) || 0) / 60);
  const score = showScore && Number.isFinite(Number(game.score)) ? Math.round(game.score) : null;
  return `<button class="game-row match-item ${game.win ? '' : 'loss'}" type="button" data-game-id="${
    game.gameId
  }">
    <span class="result">${game.win ? '胜' : '负'}</span>
    <span class="who">${iconHtml(
      champPath(game.championId),
      game.championName,
      'sm',
    )}<b>${escapeHtml(game.championName ?? '未知英雄')}</b><small>${escapeHtml(
      game.queueName ?? '',
    )} · ${durationMin} 分钟 · ${formatGameTime(game.gameCreation)}${
      game.tags?.length ? ` · ${escapeHtml(game.tags.join(' / '))}` : ''
    }</small></span>
    <span class="kda">${game.kills}/${game.deaths}/${game.assists}</span>
    <span class="pts"${score === null ? '' : ` style="color:${ratingColor(score)}"`}>${
      score === null ? '›' : score
    }</span>
  </button>`;
}

function showMatchesList(games, title, showScore, back) {
  stopLoadingTimer();
  state.matchesBack = back;
  els.matchesModal.classList.remove('hidden');
  els.matchesModal.querySelector('.modal-card')?.classList.remove('wide');
  els.matchesBack.classList.add('hidden');
  els.matchesTitle.textContent = title;
  els.matchesList.className = 'match-list';
  els.matchesList.innerHTML = games.length
    ? games.map((game) => matchRow(game, showScore)).join('')
    : '<div class="search-status">没有对局记录</div>';
}

function openMatches(player) {
  const games = player.games ?? [];
  const name = `${player.displayName ?? '玩家'}${player.tagLine ? `#${player.tagLine}` : ''}`;
  const title = `${name} · 最近 ${games.length} 场`;
  const back = () => showMatchesList(games, title, true, back);
  showMatchesList(games, title, true, back);
}

async function openMyMatches() {
  state.matchesBack = null;
  els.matchesModal.classList.remove('hidden');
  els.matchesModal.querySelector('.modal-card')?.classList.remove('wide');
  els.matchesBack.classList.add('hidden');
  els.matchesTitle.textContent = '我的最近战绩';
  beginMatchesLoading('正在读取最近战绩…');

  try {
    const response = await fetch('/api/me/matches?recent=20', { cache: 'no-store' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.error ?? `HTTP ${response.status}`);
    }
    state.selfPuuid = payload.summoner?.puuid ?? state.selfPuuid;
    const games = Array.isArray(payload.games) ? payload.games : [];
    const title = `我的最近 ${games.length} 场`;
    const back = () => showMatchesList(games, title, false, back);
    showMatchesList(games, title, false, back);
  } catch (error) {
    stopLoadingTimer();
    els.matchesList.innerHTML = `<div class="search-status error">读取失败：${escapeHtml(
      error instanceof Error ? error.message : String(error),
    )}</div>`;
  }
}

async function openMatchDetail(gameId) {
  els.matchesModal.classList.remove('hidden');
  els.matchesModal.querySelector('.modal-card')?.classList.add('wide');
  els.matchesBack.classList.toggle('hidden', !state.matchesBack);
  els.matchesTitle.textContent = '对局详情';
  beginMatchesLoading('正在读取 10 名玩家的战绩…');

  try {
    const response = await fetch(`/api/match/${gameId}/stream?recent=20`, {
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    let detail = null;
    await readNdjson(response, (event) => {
      if (event.type === 'progress') {
        state.loadingProgress = { done: event.done, total: event.total };
      } else if (event.type === 'done') {
        detail = event.data;
      } else if (event.type === 'error') {
        throw new Error(event.error ?? '读取失败');
      }
    });

    // 浏览器不支持流式响应时退回到普通 JSON 接口
    if (!detail) {
      const fallback = await fetch(`/api/match/${gameId}?recent=20`, { cache: 'no-store' });
      const payload = await fallback.json().catch(() => ({}));
      if (!fallback.ok || payload?.ok === false) {
        throw new Error(payload?.error ?? `HTTP ${fallback.status}`);
      }
      detail = payload;
    }

    stopLoadingTimer();
    const selfPuuid = detail.selfPuuid ?? state.selfPuuid;
    const players = Array.isArray(detail.players) ? detail.players : [];
    const nodes = players.map((player) =>
      buildCard(player, Boolean(selfPuuid && player.puuid === selfPuuid), {
        mode: detail.gameMode ?? null,
        modeLabel: detail.queueName ?? '近期',
      }),
    );
    els.matchesList.className = 'match-list match-cards';
    els.matchesList.replaceChildren(...nodes);
    els.matchesTitle.textContent = `${detail.queueName ?? '对局'} · ${formatGameTime(
      detail.gameCreation,
    )} · 对局详情`;
    els.matchesBack.classList.toggle('hidden', !state.matchesBack);
  } catch (error) {
    stopLoadingTimer();
    els.matchesList.className = 'match-list';
    els.matchesList.innerHTML = `<div class="search-status error">读取失败：${escapeHtml(
      error instanceof Error ? error.message : String(error),
    )}</div>`;
  }
}

function closeMatches() {
  stopLoadingTimer();
  els.matchesModal.classList.add('hidden');
  els.matchesList.replaceChildren();
  els.matchesBack.classList.add('hidden');
  els.matchesModal.querySelector('.modal-card')?.classList.remove('wide');
  state.matchesBack = null;
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

    const nodes = players.map((player) =>
      buildCard(player, false, { mode: null, modeLabel: '近期' }),
    );
    els.searchBoard.replaceChildren(...nodes);
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
els.searchForm.addEventListener('submit', (event) => void submitSearch(event));
els.searchClose.addEventListener('click', closeSearch);
els.matchesClose.addEventListener('click', closeMatches);
els.matchesBack.addEventListener('click', () => {
  if (typeof state.matchesBack === 'function') state.matchesBack();
});
els.matchesList.addEventListener('click', (event) => {
  const row = event.target.closest('[data-game-id]');
  if (!row) return;
  void openMatchDetail(Number(row.dataset.gameId));
});

document.addEventListener('keydown', (event) => {
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
if (!STATIC_MODE) {
  connectStream();
  setInterval(fetchSnapshot, 20_000);
}

const initialPlayer = new URLSearchParams(window.location.search).get('player');
if (initialPlayer) {
  els.searchInput.value = initialPlayer;
  void submitSearch({ preventDefault() {} });
}
