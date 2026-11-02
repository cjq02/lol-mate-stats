import type { MatchDetail, MatchScoreboardPlayer, PlayerReport, Snapshot } from './types.js';
import { queueName } from './stats/constants.js';

export interface AiConfig {
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** 是否为 OpenCode Go / Console 推理接口 */
  opencode: boolean;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const DEFAULT_BASE_URL = 'https://opencode.ai/inference/go/openai/v1';
const DEFAULT_MODEL = 'deepseek-v4.1-flash';

function firstEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** 读取 .env 里的 AI 配置；默认预设 OpenCode Go + DeepSeek V4.1 Flash */
export function getAiConfig(): AiConfig {
  const disabled = /^(1|true|yes|on)$/i.test(
    firstEnv('LOL_MATE_AI_DISABLED', 'OPENCODE_AI_DISABLED') ?? '',
  );
  const baseUrl = (firstEnv('LOL_MATE_AI_BASE_URL') || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const model = firstEnv('LOL_MATE_AI_MODEL') || DEFAULT_MODEL;
  const apiKey = firstEnv(
    'LOL_MATE_AI_API_KEY',
    'OPENCODE_GO_API_KEY',
    'OPENCODE_API_KEY',
  );
  const local = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/i.test(baseUrl);
  return {
    enabled: !disabled && Boolean(model) && Boolean(apiKey || local),
    baseUrl,
    model,
    apiKey,
    opencode: isOpencodeHost(baseUrl),
  };
}

function isOpencodeHost(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === 'opencode.ai' || host.endsWith('.opencode.ai');
  } catch {
    return false;
  }
}

const POSITION_NAMES: Record<string, string> = {
  TOP: '上单',
  JUNGLE: '打野',
  MIDDLE: '中单',
  MID: '中单',
  BOTTOM: 'ADC',
  ADC: 'ADC',
  UTILITY: '辅助',
  SUPPORT: '辅助',
  ARAM: '大乱斗',
  ARENA: '竞技场',
  UNKNOWN: '未知',
};

function lane(position?: string): string {
  if (!position) return '未知';
  return POSITION_NAMES[position.toUpperCase()] ?? position;
}

function fix(value: unknown, digits = 0): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  return digits > 0 ? n.toFixed(digits) : String(Math.round(n));
}

/** 0-1 的比例转百分比 */
function pct(value: unknown): string {
  const n = Number(value);
  return `${Math.round((Number.isFinite(n) ? n : 0) * 100)}%`;
}

function kdaText(row: MatchScoreboardPlayer): string {
  const games = Number(row.kills) + Number(row.assists);
  const kda = Number(row.deaths) > 0 ? games / Number(row.deaths) : games;
  return `${fix(row.kills)}/${fix(row.deaths)}/${fix(row.assists)}（KDA ${fix(kda, 2)}）`;
}

function itemsText(row: MatchScoreboardPlayer, itemName: (id: number) => string): string {
  if (!Array.isArray(row.items) || !row.items.length) return '无';
  return row.items.map((id) => itemName(Number(id)) || `#${id}`).join('、');
}

function formatTime(value?: number): string {
  if (!value) return '未知';
  try {
    return new Date(value).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return '未知';
  }
}

function recentText(report?: PlayerReport): string {
  const recent = report?.recent;
  if (!recent) return '';
  const lines = [
    `最近 ${fix(recent.games)} 场：${fix(recent.wins)}胜${fix(recent.losses)}负，胜率 ${pct(recent.winRate)}`,
    `场均评分 ${fix(recent.avgScore, 1)}；场均 KDA ${fix(recent.avgKda, 2)}；场均伤害 ${fix(
      recent.avgDamage,
    )}（分均 ${fix(recent.avgDamagePerMin)}）；参团 ${pct(recent.avgKillParticipation)}`,
    `场均补刀 ${fix(recent.avgCsPerMin, 1)}/分；场均视野 ${fix(
      recent.avgVisionPerMin,
      2,
    )}/分；场均死亡 ${fix(recent.avgDeaths, 1)}`,
  ];
  if (recent.labels?.length) lines.push(`近期标签：${recent.labels.join('、')}`);
  return `【我的近期】${lines.join('\n')}`;
}

function liveText(row: PlayerReport, itemName: (id: number) => string): string {
  const live = row.live;
  if (!live) return '暂无实时数据';
  const parts = [
    `KDA ${fix(live.kills)}/${fix(live.deaths)}/${fix(live.assists)}`,
    `补刀 ${fix(live.cs)}`,
    `等级 ${fix(live.championLevel ?? 0)}`,
  ];
  if (live.gold !== undefined) parts.push(`装备价值 ${fix(live.gold)}`);
  if (live.killParticipation !== undefined) parts.push(`参团 ${pct(live.killParticipation)}`);
  if (live.wardScore !== undefined) parts.push(`视野 ${fix(live.wardScore)}`);
  if (live.items?.length) {
    parts.push(
      `装备 ${live.items.map((id) => itemName(Number(id)) || `#${id}`).join('、')}`,
    );
  }
  return parts.join('，');
}

function rankText(report: PlayerReport | undefined): string {
  const rank = report?.rank;
  if (!rank) return '';
  const division = rank.division ? ` ${rank.division}` : '';
  return `；段位 ${rank.tier}${division} ${fix(rank.leaguePoints)}LP`;
}

/** 把进行中的对局压缩成实时出装/打法建议的提示词 */
export function buildLiveAnalysisMessages(
  snapshot: Snapshot,
  itemName: (id: number) => string = () => '',
): ChatMessage[] {
  const players = snapshot.players ?? [];
  const local = snapshot.localPlayer;
  const self =
    (local?.summonerId
      ? players.find((player) => player.summonerId === local.summonerId)
      : undefined) ?? players.find((player) => !player.isEnemy);
  const allies = players.filter((player) => !player.isEnemy);
  const enemies = players.filter((player) => player.isEnemy);
  const gameMinutes = Math.max(
    0,
    Number(snapshot.gameTime ?? 0) / 60 || self?.live?.gameMinutes || 0,
  );
  const champion = self?.championName ?? local?.championName ?? '未知英雄';
  const position = lane(self?.position);
  const selfLine = self ? liveText(self, itemName) : '未找到本人实时数据';

  const teamText = (rows: PlayerReport[], mine: boolean): string => {
    let mateIndex = 0;
    let enemyIndex = 0;
    return rows
      .map((row) => {
        const isSelf = row === self;
        const label = isSelf ? '我' : mine ? `队友${++mateIndex}` : `敌方${++enemyIndex}`;
        const rating =
          typeof row.rating === 'number' ? `；近期评分 ${fix(row.rating)}` : '';
        const tags = row.labels?.length ? `；标签 ${row.labels.join('、')}` : '';
        return `- ${label}（${row.championName ?? '未知英雄'} / ${lane(
          row.position,
        )}）：${liveText(row, itemName)}${rating}${tags}${rankText(row)}`;
      })
      .join('\n');
  };

  const user = [
    `【对局】模式：${queueName(snapshot.queueId)}${
      snapshot.gameMode ? `（${snapshot.gameMode}）` : ''
    }；已进行 ${fix(gameMinutes, 1)} 分钟；我方 ${allies.length} 人 / 敌方 ${enemies.length} 人`,
    `【我的英雄】${champion} / ${position}；${selfLine}`,
    recentText(self),
    '【我方】',
    teamText(allies, true),
    '【敌方】',
    teamText(enemies, false),
    '【请分析】重点围绕我的英雄给出装、技能加点和打法建议；当前装备与推荐不一致时，说明下一步如何调整。请按系统要求输出 6 个部分。',
  ]
    .filter(Boolean)
    .join('\n\n');

  const system = [
    '你是一名严谨、务实的英雄联盟实时对局教练，擅长根据双方阵容、当前装备和战况给出可执行的出装、技能加点和打法建议。',
    '只根据我提供的本局数据与英雄知识分析，不要编造未提供的敌方装备、符文、召唤师技能或具体战斗过程。',
    '大乱斗/竞技场模式不要用补刀、视野、分带等召唤师峡谷标准苛责；数据不足时直接说明。',
    '输出中文，分点清晰，必须引用具体英雄和数字。',
    '不要使用 Markdown 表格；每个部分单独成段，按纵向从上到下排列。固定输出 6 个部分：',
    '1. 局势判断（3-4 句：当前优劣势、双方阵容强势期、经济/等级/装备差、本局胜负手）',
    '2. 我的出装路线（核心装 2-3 件、鞋子、针对敌方关键英雄的防御/功能装、当前装备如何过渡、出装顺序和替换件；至少列出 5 件）',
    '3. 技能加点与连招（主加/副加、关键连招、对线或团战释放顺序与时机）',
    '4. 对线与节奏（对线细节/刷野路线、推线或控线、回城时机、视野、资源目标）',
    '5. 团战打法（站位、优先目标、开团/反打/保护，如何配合我方关键英雄，如何规避敌方关键威胁）',
    '6. 接下来 3-5 条可执行动作（带时间/目标/资源：推线、拿龙、抱团、回家出装等）',
    '要求：每个部分都要展开写，结合双方具体英雄和当前数据，总字数控制在 1200-1600 字。',
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** 把一局详情压缩成适合模型阅读的中文摘要（不含召唤师名字） */
export function buildAnalysisMessages(
  detail: MatchDetail,
  itemName: (id: number) => string = () => '',
): ChatMessage[] {
  const rows = (detail.scoreboard ?? []).slice(0, 10);
  const self =
    rows.find((row) => row.puuid && row.puuid === detail.selfPuuid) ??
    rows.find((row) => !row.isEnemy) ??
    rows[0];
  const myTeamId = self?.teamId;

  const reportByPuuid = new Map<string, PlayerReport>();
  for (const player of detail.players ?? []) {
    if (player.puuid) reportByPuuid.set(player.puuid, player);
  }
  const selfReport = self?.puuid ? reportByPuuid.get(self.puuid) : undefined;

  const teamText = (teamRows: MatchScoreboardPlayer[], mine: boolean): string => {
    let mateIndex = 0;
    let enemyIndex = 0;
    return teamRows
      .map((row) => {
        const isSelf = row === self;
        const label = isSelf ? '我' : mine ? `队友${++mateIndex}` : `对手${++enemyIndex}`;
        const report = row.puuid ? reportByPuuid.get(row.puuid) : undefined;
        const recentRating =
          typeof report?.rating === 'number' ? `近期评分 ${fix(report.rating)}；` : '';
        const tags = row.tags?.length ? `标签 ${row.tags.join('、')}；` : '';
        if (isSelf) {
          return `- ${label}（${row.championName ?? '未知英雄'} / ${lane(row.position)}）：本局评分 ${fix(
            row.score,
          )}；${recentRating}${tags}`;
        }
        return `- ${label}（${row.championName ?? '未知英雄'} / ${lane(row.position)}）：KDA ${kdaText(
          row,
        )}；补刀 ${fix(row.cs)}；经济 ${fix(row.gold)}；伤害 ${fix(row.damage)}；承伤 ${fix(
          row.damageTaken,
        )}；视野 ${fix(row.vision)}；评分 ${fix(row.score)}；${recentRating}${tags}装备 ${itemsText(
          row,
          itemName,
        )}`;
      })
      .join('\n');
  };

  const mineText = self
    ? [
        `【我的表现】英雄：${self.championName ?? '未知'}；位置：${lane(self.position)}；KDA：${kdaText(self)}`,
        `补刀 ${fix(self.cs)}（${fix(self.csPerMin, 1)}/分）；经济 ${fix(self.gold)}；伤害 ${fix(
          self.damage,
        )}（占比 ${pct(self.damageShare)}）；承伤 ${fix(self.damageTaken)}（占比 ${pct(
          self.tankShare,
        )}）；参团 ${pct(self.killParticipation)}；视野 ${fix(self.vision)}；治疗 ${fix(self.heal)}`,
        `评分 ${fix(self.score)}${self.grade ? `（${self.grade}）` : ''}；装备：${itemsText(
          self,
          itemName,
        )}`,
      ].join('\n')
    : '【我的表现】未找到本人数据';

  const myTeam = rows.filter((row) => row.teamId === myTeamId);
  const enemyTeam = rows.filter((row) => row.teamId !== myTeamId);
  const user = [
    `【对局】模式：${detail.queueName ?? '未知'}${
      detail.gameMode ? `（${detail.gameMode}）` : ''
    }；时长 ${fix((Number(detail.gameDuration) || 0) / 60, 1)} 分钟；结果：${
      self?.win ? '胜' : '负'
    }；时间：${formatTime(detail.gameCreation)}`,
    mineText,
    recentText(selfReport),
    '【我方】',
    teamText(myTeam, true),
    '【敌方】',
    teamText(enemyTeam, false),
    '【请分析】请按系统要求输出 7 个部分，重点分析“我”；数据不足时直接说明，不要编造。',
  ]
    .filter(Boolean)
    .join('\n\n');

  const system = [
    '你是一名严谨、务实的英雄联盟复盘教练。',
    '只根据我提供的本局结算数据和近期战绩分析，不要编造没有发生的事件（例如具体团战、视野布控过程）。',
    '输出中文，分点清晰，必须引用具体数字；大乱斗/竞技场模式不要用补刀、视野苛责。',
    '不要使用 Markdown 表格；每个部分单独成段，按纵向从上到下排列。固定输出 7 个部分：',
    '1. 局势总览（2-3 句：胜负主因、双方阵容与关键差距、本局节奏）',
    '2. 胜负关键（3-4 条，每条带具体数字和英雄/位置）',
    '3. 我的表现剖析（亮点 2-3 条 + 问题 2-3 条，带 KDA/伤害/参团/补刀/视野等数字）',
    '4. 队友与对手（分别点出 1-2 名关键玩家及其影响，不要只罗列数据）',
    '5. 出装与资源复盘（当前出装是否合理、可替换装备、经济/视野/资源节奏）',
    '6. 改进建议（4-5 条，覆盖对线/节奏/团战/出装/视野，具体可执行）',
    '7. 如果重来一次，最该改的一件事',
    '要求：每个部分都要展开写，不要只写一句话；总字数控制在 1200-1600 字。',
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** 调用 OpenAI 兼容的流式接口，把增量内容回调出去 */
export async function streamChatCompletion(
  config: AiConfig,
  messages: ChatMessage[],
  onDelta: (text: string) => void,
  signal: AbortSignal,
  sessionId?: string,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('AI 请求超时（180 秒）')), 180_000);
  const forwardAbort = () => controller.abort(signal.reason);
  if (signal.aborted) controller.abort(signal.reason);
  else signal.addEventListener('abort', forwardAbort, { once: true });

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'lol-mate-stats/0.1',
    };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    if (config.opencode && sessionId) headers['x-opencode-session'] = sessionId;

    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.model,
        messages,
        stream: true,
        temperature: 0.4,
        // DeepSeek V4.1 Flash 会先输出 reasoning_content，预算太小会导致正式回答为空
        max_tokens: 16000,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `AI 服务 HTTP ${response.status}${text ? `：${text.slice(0, 300)}` : ''}`,
      );
    }
    if (!response.body) throw new Error('AI 服务没有返回内容');
    await readCompletionStream(response.body, onDelta);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', forwardAbort);
  }
}

/** 解析 SSE 格式的 chat.completions 流 */
async function readCompletionStream(
  body: ReadableStream<Uint8Array>,
  onDelta: (text: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (line.startsWith('data:')) {
        total = handleSseData(line.slice(5).trim(), onDelta, total);
        if (total < 0) return;
      }
      index = buffer.indexOf('\n');
    }
  }
}

function handleSseData(data: string, onDelta: (text: string) => void, total: number): number {
  if (!data) return total;
  if (data.includes('DONE')) return -1;
  try {
    return parseChunk(data, onDelta, total);
  } catch {
    return total;
  }
}

function parseChunk(data: string, onDelta: (text: string) => void, total: number): number {
  const payload = JSON.parse(data) as Record<string, unknown>;
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const first = choices[0] as
    | { delta?: { content?: string }; message?: { content?: string } }
    | undefined;
  const delta = first?.delta?.content ?? first?.message?.content;
  if (typeof delta !== 'string' || !delta) return total;
  onDelta(delta);
  return total + delta.length;
}
