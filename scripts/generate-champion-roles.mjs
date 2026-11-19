/**
 * 从客户端本地英雄数据生成 src/stats/champion-roles.ts。
 *
 * 客户端 `/lol-game-data/assets/v1/champions/{id}.json` 的 `roles` 是官方多定位数组，
 * 顺序与 Data Dragon 一致（主定位在前），本项目不再手工维护这张表。
 *
 * 运行：npm run build && node scripts/generate-champion-roles.mjs
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import '../dist/env.js';
import { LcuApi } from '../dist/lcu/api.js';
import { discoverConnection } from '../dist/lcu/discover.js';

/** 官方 6 类 → 评分模板；法师/射手/刺客共用 carry 权重 */
const ROLE_BY_CLASS = {
  tank: 'tank',
  fighter: 'fighter',
  support: 'support',
  mage: 'carry',
  marksman: 'carry',
  assassin: 'carry',
};

/**
 * 个别英雄按实际打法调整主定位，而不是照搬官方标签顺序：
 * - 莫甘娜 / 赛娜：官方把辅助排在前面，但评分按输出更贴近实际出装
 * - 卡尔玛：实际以软辅为主，治疗和参团权重更合适
 * - 锤石：坦克出装，承伤权重比纯软辅更合适
 * 副定位由官方第二个分类自动推导，不需要写在这里。
 */
const OVERRIDES = {
  25: { primary: 'carry' }, // 莫甘娜
  43: { primary: 'support' }, // 卡尔玛
  235: { primary: 'carry' }, // 赛娜
  412: { primary: 'tank' }, // 锤石
};

/**
 * 辅助模板只做主定位：官方 Support 也包含火男、泽拉斯、慧这类输出型辅助，
 * 把治疗/承伤权重混进输出英雄会系统性压低他们的评分。
 */
const SECONDARY_UNSUPPORTED = new Set(['support']);

/** 特殊模式（Jade_ 前缀）英雄的别名和基础英雄不一致时手动补一条 */
const LEGACY_ALIAS = { wukong: 'monkeyking' };

/** 特殊模式英雄 ID 一律是 60000 + 基础英雄 ID */
const LEGACY_OFFSET = 60_000;

const outputPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'stats',
  'champion-roles.ts',
);

const connection = await discoverConnection();
const api = new LcuApi(connection);

try {
  const summary = (
    await api.http.get('/lol-game-data/assets/v1/champion-summary.json', 20_000)
  ).filter((champion) => champion.id > 0);

  const rolesById = new Map();
  for (const champion of summary) {
    if (champion.id >= LEGACY_OFFSET) continue;
    const detail = await api.http.get(
      `/lol-game-data/assets/v1/champions/${champion.id}.json`,
      10_000,
    );
    rolesById.set(champion.id, detail.roles ?? []);
  }

  const baseByAlias = new Map(
    summary
      .filter((champion) => champion.id < LEGACY_OFFSET)
      .map((champion) => [String(champion.alias).toLowerCase(), champion]),
  );

  const resolveRoles = (champion) => {
    const own = rolesById.get(champion.id);
    if (own) return own;
    if (champion.id < LEGACY_OFFSET) return [];
    const alias = String(champion.alias ?? '')
      .replace(/^Jade_/i, '')
      .toLowerCase();
    const base = baseByAlias.get(LEGACY_ALIAS[alias] ?? alias);
    return base ? rolesById.get(base.id) ?? [] : [];
  };

  const entries = summary
    .map((champion) => {
      const official = resolveRoles(champion).map((role) => String(role).toLowerCase());
      const mapped = official.map((role) => ROLE_BY_CLASS[role]).filter(Boolean);
      const override = OVERRIDES[champion.id] ?? OVERRIDES[champion.id - LEGACY_OFFSET];
      const primary = override?.primary ?? mapped[0] ?? 'default';
      const secondary =
        override?.secondary ??
        mapped.find(
          (role) => role !== primary && !SECONDARY_UNSUPPORTED.has(role),
        ) ??
        undefined;
      return {
        id: champion.id,
        name: champion.name,
        alias: champion.alias,
        official,
        primary,
        secondary: secondary === primary ? undefined : secondary,
      };
    })
    .sort((a, b) => a.id - b.id);

  const lines = entries.map((entry) => {
    const profile = entry.secondary
      ? `{ primary: '${entry.primary}', secondary: '${entry.secondary}' }`
      : `{ primary: '${entry.primary}' }`;
    const official = entry.official.length ? `[${entry.official.join(',')}]` : '[未知]';
    return `  ${entry.id}: ${profile}, // ${entry.name} ${entry.alias} ${official}`;
  });

  const content = `/** 自动生成：英雄主/副定位 → 评分权重类别。新英雄缺失时按 default 处理。 */
/** 重新生成：npm run build && node scripts/generate-champion-roles.mjs */
export type ChampionRole = 'support' | 'tank' | 'fighter' | 'carry' | 'default';

/** 客户端官方英雄分类（一个英雄可以有多项） */
export type ChampionClass =
  | 'mage'
  | 'marksman'
  | 'assassin'
  | 'fighter'
  | 'tank'
  | 'support';

export interface ChampionRoleProfile {
  /** 主定位：决定评分权重的大头和短板规则 */
  primary: ChampionRole;
  /** 副定位：按 30% 权重参与评分 */
  secondary?: ChampionRole;
}

export const CHAMPION_ROLE_PROFILES: Record<number, ChampionRoleProfile> = {
${lines.join('\n')}
};

/** 主定位；时段统计、阵容估算等只需要一个分类的地方用它 */
export function championRole(championId: number): ChampionRole {
  return CHAMPION_ROLE_PROFILES[championId]?.primary ?? 'default';
}

/** 主 + 副定位；评分按 70% / 30% 混合 */
export function championRoleProfile(championId: number): ChampionRoleProfile {
  return CHAMPION_ROLE_PROFILES[championId] ?? { primary: 'default' };
}
`;

  writeFileSync(outputPath, content, 'utf8');
  console.log(`已生成 ${entries.length} 个英雄定位 → ${outputPath}`);
} finally {
  api.destroy();
}
