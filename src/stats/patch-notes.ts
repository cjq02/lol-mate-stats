import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DATA_DIR } from '../paths.js';
import { logTag } from '../util.js';

/**
 * 版本更新公告里的英雄加强 / 削弱。
 *
 * 数据来自官方补丁说明页面：只解析英文站，因为繁中页偶尔会退化成旧排版，
 * 英文页一直保持 `patch-change-block` + `change-detail-title` 这套结构。
 * 技能名、字段名的中文我们自己做映射，英雄名用面板里已有的简中名称。
 */

const PATCH_NOTES_LOCALE = 'en-us';
const PATCH_NOTES_ORIGIN = 'https://www.leagueoflegends.com';
const PATCH_NOTES_INDEX_URL = `${PATCH_NOTES_ORIGIN}/${PATCH_NOTES_LOCALE}/news/tags/patch-notes/`;
const PATCH_NOTES_SLUG_PATTERN = /\/news\/game-updates\/(league-of-legends-patch-\d+-\d+-notes)/;
const PATCH_NOTES_SECTION_TITLE = 'Champions';

const DDRAGON_VERSIONS_URL = 'https://ddragon.leagueoflegends.com/api/versions.json';
const DDRAGON_CDN_ORIGIN = 'https://ddragon.leagueoflegends.com/cdn';
const DDRAGON_CHAMPION_LOCALE = 'zh_CN';

const REQUEST_TIMEOUT_MS = 8_000;
/** 公告和英雄表都按 6 小时缓存，版本更新当天最多晚 6 小时看到 */
const DIGEST_TTL_MS = 6 * 60 * 60_000;
/** 拉取失败后 10 分钟内不再重试，避免每次打开弹窗都卡一次 */
const RETRY_AFTER_FAILURE_MS = 10 * 60_000;
const DIGEST_CACHE_PATH = join(DATA_DIR, 'patch-notes.json');
const REQUEST_HEADERS = { 'user-agent': 'lol-mate-stats/0.1 (local panel)' };

/** 技能槽位；基础属性和无法识别的分组各占一个值 */
export type PatchSlot = 'BASE' | 'P' | 'Q' | 'W' | 'E' | 'R' | 'OTHER';

/** 官方公告没有 buff/nerf 标记，方向由数值变化和字段语义推断 */
export type PatchChangeDirection = 'buff' | 'nerf' | 'mixed' | 'unknown';

export interface PatchChange {
  slot: PatchSlot;
  /** 展示用的分组名，例如「Q 宇宙束缚」「基础属性」 */
  section: string;
  label: string;
  before: string;
  after: string;
}

export interface ChampionPatchChange {
  championId: number;
  /** Data Dragon 里的英文别名，例如 Ezreal */
  championKey: string;
  direction: PatchChangeDirection;
  changes: PatchChange[];
}

export interface ChampionPatchDigest {
  /** 版本号，例如 26.23 */
  version: string;
  title: string;
  url: string;
  publishedAt: string;
  fetchedAt: number;
  champions: ChampionPatchChange[];
}

/** 解析后的原始公告条目，字段名保持英文，翻译在生成摘要时做 */
export interface ParsedPatchChange {
  slot: PatchSlot;
  section: string;
  label: string;
  before: string;
  after: string;
}

export interface ParsedPatchChampion {
  championKey: string;
  name: string;
  comment: string;
  changes: ParsedPatchChange[];
}

const HTML_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

const ENTITY_PATTERN = /&(#x?[0-9a-f]+|[a-z]+);/gi;

function decodeHtmlEntities(value: string): string {
  return value.replace(ENTITY_PATTERN, (match, code: string) => {
    const key = code.toLowerCase();
    let point = Number.NaN;
    if (key.startsWith('#x')) point = Number.parseInt(key.slice(2), 16);
    else if (key.startsWith('#')) point = Number.parseInt(key.slice(1), 10);
    else return HTML_ENTITIES[key] ?? match;
    return Number.isFinite(point) ? String.fromCodePoint(point) : match;
  });
}

function stripHtml(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 取「Champions」这一节：从该 h2 开始，到下一个 h2 之前。
 * 用标题文字定位而不是 id，因为部分版本的公告没有给 h2 加 id。
 */
function sliceChampionSection(html: string): string {
  const headings = [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)];
  for (let index = 0; index < headings.length; index += 1) {
    if (stripHtml(headings[index][1] ?? '') !== PATCH_NOTES_SECTION_TITLE) continue;
    const start = headings[index].index ?? 0;
    const next = headings[index + 1];
    return html.slice(start, next?.index ?? html.length);
  }
  return '';
}

/** 从 `Q - Cosmic Binding`、`Passive - X`、`Base Stats` 里识别槽位 */
export function patchSlotOfSection(section: string): PatchSlot {
  const text = section.trim();
  if (!text) return 'OTHER';
  if (/^base stats$/i.test(text)) return 'BASE';
  const match = text.match(/^(passive|[qwer])\b/i);
  if (!match) return 'OTHER';
  const key = (match[1] ?? '').toUpperCase();
  if (key === 'PASSIVE') return 'P';
  if (key === 'Q' || key === 'W' || key === 'E' || key === 'R') return key;
  return 'OTHER';
}

/** 一条改动长这样：<li><strong>Damage</strong>: 80 ⇒ <strong>90</strong></li> */
function splitChangeItem(inner: string): { label: string; before: string; after: string } | null {
  const parts = inner.split('⇒');
  if (parts.length < 2) return null;
  const tail = parts.slice(1).join('⇒');
  // 改动后的数值一般会加粗，后面可能还跟一句说明，取加粗部分即可
  const strongAfter = tail.match(/^\s*<strong>([\s\S]*?)<\/strong>/)?.[1];
  const after = stripHtml(strongAfter ?? tail);
  if (!after) return null;

  const strong = (parts[0] ?? '').match(/<strong>([\s\S]*?)<\/strong>/)?.[1] ?? '';
  let label = stripHtml(strong).replace(/[:：]\s*$/, '');
  let before = stripHtml(parts[0] ?? '');
  if (label) {
    if (before.startsWith(label)) {
      before = before.slice(label.length).replace(/^\s*[:：]\s*/, '').trim();
    }
  } else {
    const colon = before.match(/^([^:：]{1,40})[:：]\s*/);
    if (colon) {
      label = (colon[1] ?? '').trim();
      before = before.slice(colon[0].length).trim();
    }
  }
  if (!before) return null;
  return { label, before, after };
}

function parseSectionChanges(block: string): ParsedPatchChange[] {
  const changes: ParsedPatchChange[] = [];
  const sections = [...block.matchAll(/<h4[^>]*class="change-detail-title[^"]*"[^>]*>([\s\S]*?)<\/h4>/g)];
  for (let index = 0; index < sections.length; index += 1) {
    const section = stripHtml(sections[index][1] ?? '');
    const slot = patchSlotOfSection(section);
    const from = (sections[index].index ?? 0) + sections[index][0].length;
    const to = sections[index + 1]?.index ?? block.length;
    const chunk = block.slice(from, to);
    for (const item of chunk.matchAll(/<li>([\s\S]*?)<\/li>/g)) {
      const parsed = splitChangeItem(item[1] ?? '');
      if (!parsed) continue;
      changes.push({ slot, section, ...parsed });
    }
  }
  return changes;
}

/** 该页面是否存在「Champions」段落；区分「本版本没有英雄改动」和「解析失败」 */
export function championSectionHtml(html: string): string {
  return sliceChampionSection(html);
}

/** 解析公告正文，返回每个英雄的原始改动列表 */
export function parseChampionPatchSection(html: string): ParsedPatchChampion[] {
  const section = sliceChampionSection(html);
  if (!section) return [];
  const blocks = section.split('class="patch-change-block').slice(1);
  const result: ParsedPatchChampion[] = [];
  for (const block of blocks) {
    const championKey = block.match(/img\/champion\/([A-Za-z0-9]+)\.png/)?.[1];
    if (!championKey) continue;
    const name = stripHtml(block.match(/<h3[^>]*class="change-title"[^>]*>([\s\S]*?)<\/h3>/)?.[1] ?? '');
    const comment = stripHtml(
      block.match(/<blockquote[^>]*class="blockquote context"[^>]*>([\s\S]*?)<\/blockquote>/)?.[1] ?? '',
    );
    const changes = parseSectionChanges(block);
    if (!changes.length) continue;
    result.push({ championKey, name, comment, changes });
  }
  return result;
}

/** 数值变小反而是加强的字段，必须先于「越大越好」判断 */
const SMALLER_IS_BETTER = [
  /cooldown/i,
  /cast time/i,
  /channel time/i,
  /recharge/i,
  /respawn/i,
  /lockout/i,
  /\bcost\b/i,
  /\bdelay\b/i,
];

/** 数值变大就是加强的字段 */
const BIGGER_IS_BETTER = [
  /damage/i,
  /health/i,
  /regen/i,
  /mana/i,
  /armor/i,
  /resist/i,
  /attack speed/i,
  /move(ment)? speed/i,
  /range/i,
  /heal/i,
  /shield/i,
  /duration/i,
  /slow/i,
  /ratio/i,
  /lethality/i,
  /penetration/i,
  /omnivamp/i,
  /lifesteal/i,
  /tenacity/i,
  /\bgold\b/i,
  /experience/i,
];

const NUMBER_PATTERN = /-?\d+(?:\.\d+)?/g;

const ABILITY_SLOTS = new Set<PatchSlot>(['Q', 'W', 'E', 'R']);

/** 技能分组里的「Mana / Energy」指消耗，不是最大法力值 */
function isAbilityCostLabel(slot: PatchSlot | undefined, label: string): boolean {
  return Boolean(slot && ABILITY_SLOTS.has(slot)) && /^(mana|energy)$/i.test(label.trim());
}

function sumNumbers(value: string): number {
  const numbers = value.match(NUMBER_PATTERN);
  if (!numbers?.length) return Number.NaN;
  return numbers.reduce((sum, item) => sum + Number(item), 0);
}

/** 1 表示加强，-1 表示削弱，0 表示字段方向不明或数值没变 */
function voteDirection(label: string, before: string, after: string, slot?: PatchSlot): number {
  const beforeSum = sumNumbers(before);
  const afterSum = sumNumbers(after);
  if (!Number.isFinite(beforeSum) || !Number.isFinite(afterSum)) return 0;
  const diff = afterSum - beforeSum;
  if (Math.abs(diff) < 1e-9) return 0;
  if (isAbilityCostLabel(slot, label) || SMALLER_IS_BETTER.some((pattern) => pattern.test(label))) {
    return diff > 0 ? -1 : 1;
  }
  if (BIGGER_IS_BETTER.some((pattern) => pattern.test(label))) return diff > 0 ? 1 : -1;
  return 0;
}

/** 汇总一个英雄整页改动，给出加强 / 削弱 / 调整 */
export function classifyPatchDirection(
  changes: Array<{ label: string; before: string; after: string; slot?: PatchSlot }>,
  comment = '',
): PatchChangeDirection {
  let buffs = 0;
  let nerfs = 0;
  for (const change of changes) {
    const vote = voteDirection(change.label, change.before, change.after, change.slot);
    if (vote > 0) buffs += 1;
    else if (vote < 0) nerfs += 1;
  }
  if (buffs > 0 && nerfs === 0) return 'buff';
  if (nerfs > 0 && buffs === 0) return 'nerf';
  if (buffs > 0 && nerfs > 0) return 'mixed';

  // 纯机制改动没有可比数值时，退回设计师说明里的关键词
  const text = comment.toLowerCase();
  const buffWord = /\bbuff(s|ed|ing)?\b/.test(text);
  const nerfWord = /\bnerf(s|ed|ing)?\b/.test(text);
  if (buffWord && !nerfWord) return 'buff';
  if (nerfWord && !buffWord) return 'nerf';
  if (buffWord && nerfWord) return 'mixed';
  return 'unknown';
}

/** 常见字段的固定译名；未收录的会走下面的组合规则，再不行保留英文 */
const PATCH_LABEL_ZH: Record<string, string> = {
  damage: '伤害',
  cooldown: '冷却',
  'mana cost': '魔法消耗',
  health: '生命值',
  mana: '法力值',
  armor: '护甲',
  'magic resistance': '魔抗',
  'magic resist': '魔抗',
  'attack damage': '攻击力',
  'ability power': '法术强度',
  'attack speed': '攻速',
  'move speed': '移速',
  'movement speed': '移速',
  'attack range': '攻击距离',
  range: '距离',
  shield: '护盾',
  heal: '治疗量',
  healing: '治疗量',
  duration: '持续时间',
  slow: '减速',
  'slow amount': '减速幅度',
  'health regeneration': '生命回复',
  'mana regeneration': '法力回复',
  regen: '回复',
  'critical strike damage': '暴击伤害',
  'critical strike damage reduction': '暴击伤害减免',
  'damage reduction': '伤害减免',
  'true damage': '真实伤害',
  'magic damage': '魔法伤害',
  'physical damage': '物理伤害',
  'champion damage': '英雄伤害',
  'bonus damage': '额外伤害',
  'initial damage': '初始伤害',
  'explosion damage': '爆炸伤害',
  'on-hit damage': '命中伤害',
  'damage per second': '每秒伤害',
  'single target damage': '单体伤害',
  'monster damage': '野怪伤害',
  'damage modifier': '伤害系数',
  'mini damage': '迷你形态伤害',
  'mega damage': '巨型形态伤害',
  'subsequent bolt damage': '后续弹体伤害',
  'on hit / attack damage ratio': '命中 / 攻击力加成',
  'tibbers health': '提伯斯生命值',
  'tibbers attack damage': '提伯斯攻击力',
  'tibbers aura damage per second': '提伯斯光环每秒伤害',
  lifesteal: '生命偷取',
  'life steal': '生命偷取',
  'missile speed': '弹道速度',
  'shield amount': '护盾数值',
  'self heal': '自身治疗',
  'stat steal': '属性窃取',
  stacks: '层数',
  size: '体型',
  'model size': '模型体型',
  speed: '速度',
  'root duration': '禁锢持续时间',
  'sleep duration': '睡眠持续时间',
  knockup: '击飞',
};

/** 组合规则：Base / Bonus / Maximum 前缀，Growth / Ratio 后缀等 */
const PATCH_LABEL_PATTERNS: Array<[RegExp, (body: string) => string]> = [
  [/^base\s+(.+)$/i, (body) => `基础${body}`],
  [/^bonus\s+(.+)$/i, (body) => `额外${body}`],
  [/^maximum\s+(.+)$/i, (body) => `最大${body}`],
  [/^minimum\s+(.+)$/i, (body) => `最小${body}`],
  [/^total\s+(.+)$/i, (body) => `总${body}`],
  [/^(.+)\s+growth$/i, (body) => `${body}成长`],
  [/^(.+)\s+ratio$/i, (body) => `${body}加成`],
  [/^(.+)\s+modifier$/i, (body) => `${body}系数`],
  [/^(.+)\s+reduction$/i, (body) => `${body}减免`],
  [/^(.+)\s+bonus$/i, (body) => `${body}加成`],
  [/^(.+)\s+per\s+second$/i, (body) => `每秒${body}`],
  [/^(.+)\s+per\s+stack$/i, (body) => `每层${body}`],
  [/^(.+)\s+per\s+(?:hit|strike)$/i, (body) => `每次${body}`],
  [/^(.+)\s+duration$/i, (body) => `${body}持续时间`],
  [/^(.+?)\s*\(.+\)$/, (body) => body],
];

const CHINESE_PATTERN = /[\u4e00-\u9fff]/;

export function translatePatchLabel(label: string): string {
  const text = label.trim();
  if (!text) return '';
  const exact = PATCH_LABEL_ZH[text.toLowerCase()];
  if (exact) return exact;
  for (const [pattern, decorate] of PATCH_LABEL_PATTERNS) {
    const match = text.match(pattern);
    if (!match) continue;
    const body = translatePatchLabel(match[1] ?? '');
    // 主体没能翻译成中文时不要拼出「每秒Tibbers Aura Damage」这种半中半英
    if (!CHINESE_PATTERN.test(body)) continue;
    return decorate(body);
  }
  return text;
}

interface DdragonChampionEntry {
  key?: string;
  spells?: Array<{ name?: string }>;
  passive?: { name?: string };
}

interface DdragonChampionFull {
  data?: Record<string, DdragonChampionEntry>;
}

type ChampionSpellNames = Partial<Record<PatchSlot, string>>;

interface ChampionLookup {
  /** Data Dragon 别名（Ezreal）→ 英雄 ID */
  ids: Map<string, number>;
  /** Data Dragon 别名 → 技能中文名 */
  spells: Map<string, ChampionSpellNames>;
}

const SPELL_SLOTS = ['Q', 'W', 'E', 'R'] as const;
const SPELL_SLOT_INDEX: Record<(typeof SPELL_SLOTS)[number], number> = { Q: 0, W: 1, E: 2, R: 3 };

/** 用 Data Dragon 的简中数据补齐英雄 ID 和技能名，同一版本只拉一次 */
async function loadChampionLookup(): Promise<ChampionLookup> {
  const versions = await fetchJson<string[]>(DDRAGON_VERSIONS_URL);
  const version = versions[0];
  if (!version) throw new Error('Data Dragon 没有返回版本号');
  const source = await fetchJson<DdragonChampionFull>(
    `${DDRAGON_CDN_ORIGIN}/${version}/data/${DDRAGON_CHAMPION_LOCALE}/championFull.json`,
  );
  const ids = new Map<string, number>();
  const spells = new Map<string, ChampionSpellNames>();
  for (const [key, entry] of Object.entries(source.data ?? {})) {
    const id = Number(entry.key);
    if (Number.isFinite(id) && id > 0) ids.set(key, id);
    const names: ChampionSpellNames = { BASE: '基础属性', P: entry.passive?.name };
    for (const slot of SPELL_SLOTS) {
      names[slot] = entry.spells?.[SPELL_SLOT_INDEX[slot]]?.name;
    }
    spells.set(key, names);
  }
  return { ids, spells };
}

function displayChangeLabel(change: ParsedPatchChange): string {
  if (isAbilityCostLabel(change.slot, change.label)) {
    return /^energy$/i.test(change.label.trim()) ? '能量消耗' : '法力消耗';
  }
  return translatePatchLabel(change.label);
}

function sectionLabel(
  change: ParsedPatchChange,
  names: ChampionSpellNames | undefined,
): string {
  if (change.slot === 'BASE') return names?.BASE ?? '基础属性';
  if (change.slot === 'OTHER') return change.section;
  const name = names?.[change.slot];
  return name ? `${change.slot} ${name}` : change.section;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: REQUEST_HEADERS,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

async function fetchJson<T>(url: string): Promise<T> {
  return JSON.parse(await fetchText(url)) as T;
}

interface PatchNotesPage {
  version: string;
  title: string;
  publishedAt: string;
  html: string;
}

interface PatchNotesBlade {
  type?: string;
  fragmentId?: string;
  richText?: { body?: string };
}

interface PatchNotesNextData {
  props?: {
    pageProps?: {
      page?: {
        title?: string;
        displayedPublishDate?: string;
        blades?: PatchNotesBlade[];
      };
    };
  };
}

function readPatchNotesPage(raw: string): PatchNotesPage {
  const match = raw.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('公告页面缺少 __NEXT_DATA__');
  const data = JSON.parse(match[1] ?? '{}') as PatchNotesNextData;
  const page = data.props?.pageProps?.page;
  const blade = page?.blades?.find((item) => item.type === 'patchNotesRichText');
  const html = blade?.richText?.body ?? '';
  if (!html) throw new Error('公告页面没有正文');
  return {
    version: blade?.fragmentId ?? '',
    title: page?.title ?? '',
    publishedAt: page?.displayedPublishDate ?? '',
    html,
  };
}

async function fetchDigest(): Promise<ChampionPatchDigest> {
  const index = await fetchText(PATCH_NOTES_INDEX_URL);
  const slug = index.match(PATCH_NOTES_SLUG_PATTERN)?.[1];
  if (!slug) throw new Error('补丁列表里没有找到版本公告');
  const url = `${PATCH_NOTES_ORIGIN}/${PATCH_NOTES_LOCALE}/news/game-updates/${slug}`;
  const page = readPatchNotesPage(await fetchText(url));
  const parsed = parseChampionPatchSection(page.html);
  if (!parsed.length && !championSectionHtml(page.html)) {
    throw new Error(`${page.version || slug} 公告里没有找到英雄段落`);
  }

  const lookup = await loadChampionLookup();
  const champions: ChampionPatchChange[] = [];
  for (const item of parsed) {
    const championId = lookup.ids.get(item.championKey);
    if (!championId) continue;
    const names = lookup.spells.get(item.championKey);
    champions.push({
      championId,
      championKey: item.championKey,
      direction: classifyPatchDirection(item.changes, item.comment),
      changes: item.changes.map((change) => ({
        slot: change.slot,
        section: sectionLabel(change, names),
        label: displayChangeLabel(change),
        before: change.before,
        after: change.after,
      })),
    });
  }
  champions.sort((a, b) => a.championId - b.championId);
  if (parsed.length && !champions.length) {
    throw new Error('英雄改动没能对上面板里的英雄');
  }
  return {
    version: page.version,
    title: page.title,
    url,
    publishedAt: page.publishedAt,
    fetchedAt: Date.now(),
    champions,
  };
}

async function persistDigest(digest: ChampionPatchDigest): Promise<void> {
  try {
    await mkdir(dirname(DIGEST_CACHE_PATH), { recursive: true });
    await writeFile(DIGEST_CACHE_PATH, JSON.stringify(digest), 'utf8');
  } catch {
    /* 落盘失败只影响离线可用性，不影响面板 */
  }
}

async function readDiskDigest(): Promise<ChampionPatchDigest | null> {
  try {
    const parsed = JSON.parse(await readFile(DIGEST_CACHE_PATH, 'utf8')) as ChampionPatchDigest;
    if (!parsed?.version || !Array.isArray(parsed.champions)) return null;
    return parsed;
  } catch {
    return null;
  }
}

let digestCache: { at: number; digest: ChampionPatchDigest } | null = null;
let diskLoaded = false;
let failureAt = 0;
let loading: Promise<ChampionPatchDigest | null> | null = null;

async function ensureDiskCache(): Promise<void> {
  if (diskLoaded) return;
  diskLoaded = true;
  const cached = await readDiskDigest();
  if (cached && !digestCache) digestCache = { at: cached.fetchedAt, digest: cached };
}

/**
 * 当前版本的英雄改动摘要。拉不到时返回上一次缓存（可能为空），
 * 不影响英雄排名本身。
 */
export async function getChampionPatchDigest(): Promise<ChampionPatchDigest | null> {
  await ensureDiskCache();
  const now = Date.now();
  if (digestCache && now - digestCache.at < DIGEST_TTL_MS) return digestCache.digest;
  if (now - failureAt < RETRY_AFTER_FAILURE_MS) return digestCache?.digest ?? null;
  if (!loading) {
    loading = fetchDigest()
      .then(async (digest) => {
        digestCache = { at: Date.now(), digest };
        await persistDigest(digest);
        logTag('patch', `已更新 ${digest.version} 英雄改动（${digest.champions.length} 个英雄）`);
        return digest;
      })
      .catch((error: unknown) => {
        failureAt = Date.now();
        const message = error instanceof Error ? error.message : String(error);
        logTag('patch', `拉取版本公告失败，沿用本地缓存：${message}`);
        return digestCache?.digest ?? null;
      })
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}
