import type { PlayerReport } from './types.js';
import { LANE_NAMES, TIER_NAMES, positionName } from './stats/constants.js';
import { colorize, dim, padCjk, printTable, warn } from './util.js';

function ratingColor(rating: number | null): 'green' | 'cyan' | 'yellow' | 'red' {
  if (rating === null) return 'red';
  if (rating >= 75) return 'green';
  if (rating >= 65) return 'cyan';
  if (rating >= 55) return 'yellow';
  return 'red';
}

export function formatRating(player: PlayerReport): string {
  if (player.rating === null) return '  -';
  return colorize(String(player.rating).padStart(3), ratingColor(player.rating));
}

export function formatRank(player: PlayerReport): string {
  const rank = player.rank;
  if (!rank) return '未定级';
  const tier = TIER_NAMES[rank.tier] ?? rank.tier;
  const division = rank.division && tier !== '大师' && tier !== '宗师' && tier !== '王者' ? ` ${rank.division}` : '';
  return `${tier}${division} ${rank.leaguePoints}LP`;
}

export function playerPosition(player: PlayerReport): string {
  if (player.position) return positionName(player.position);
  const lane = player.games?.[0]?.position;
  return lane ? LANE_NAMES[lane] : '补位';
}

function percent(value: number | undefined, digits = 0): string {
  if (value === undefined || Number.isNaN(value)) return '-';
  return `${(value * 100).toFixed(digits)}%`;
}

export function printReports(players: PlayerReport[], title = '队友近期战绩'): void {
  if (!players.length) {
    console.log(warn('没有可展示的队友数据'));
    return;
  }

  console.log('');
  console.log(colorize(`══ ${title} ══`, 'cyan'));
  console.log('');

  for (const [index, player] of players.entries()) {
    const position = `[${playerPosition(player)}]`;
    const name = `${player.displayName}${player.tagLine ? `#${player.tagLine}` : ''}`;
    const recent = player.recent;

    const head = `${dim(position)} ${padCjk(name, 22)} ${formatRating(player)} ${player.grade ?? '-'}`;
    const record = recent
      ? dim(`近${recent.games}场 ${recent.wins}胜${recent.losses}负 胜率${percent(recent.winRate)}`)
      : dim('无战绩');
    console.log(`${index + 1}. ${head}  ${record}`);

    if (recent) {
      const metrics = [
        `KDA ${recent.avgKda.toFixed(2)}`,
        `参团 ${percent(recent.avgKillParticipation)}`,
        `分伤 ${recent.avgDamagePerMin}`,
        `伤害占比 ${percent(recent.avgDamageShare)}`,
        `补刀 ${recent.avgCsPerMin.toFixed(1)}/min`,
        `视野 ${recent.avgVisionPerMin.toFixed(2)}/min`,
        `死亡 ${recent.avgDeaths.toFixed(1)}`,
      ].join(dim(' · '));
      console.log(`   ${metrics}`);
      console.log(
        `   段位 ${formatRank(player)}${player.labels.length ? dim(' · 标签 ') : ''}${player.labels.join(' / ')}`,
      );
      if (recent.risk.level !== 'low') {
        const riskColor = recent.risk.level === 'severe' ? 'red' : recent.risk.level === 'high' ? 'yellow' : 'dim';
        const riskText = colorize(`坑指数 ${recent.risk.score}`, riskColor);
        console.log(`   ${riskText} ${dim(recent.risk.reasons.join(' · ') || '多项数据低于同位置参考值')}`);
      }

      if (player.games?.length) {
        const games = player.games
          .slice(0, 6)
          .map((game) => {
            const result = game.win ? colorize('胜', 'green') : colorize('负', 'red');
            return `${result} ${game.championName} ${game.kills}/${game.deaths}/${game.assists}(${game.score})`;
          })
          .join(dim(' | '));
        console.log(`   ${dim('近期')} ${games}`);
      }

      if (recent.topChampions.length) {
        const champions = recent.topChampions
          .map(
            (champion) =>
              `${champion.name} ${champion.games}场${percent(champion.winRate)}`,
          )
          .join(dim(' · '));
        console.log(`   ${dim('常用')} ${champions}`);
      }
    }

    if (player.error) console.log(`   ${colorize(`⚠ ${player.error}`, 'yellow')}`);
    console.log('');
  }
}

/** 表格模式，适合 --json 之外的紧凑输出 */
export function printCompactTable(players: PlayerReport[]): void {
  const rows = players.map((player) => [
    playerPosition(player),
    player.displayName,
    player.rating === null ? '-' : `${player.rating} ${player.grade ?? ''}`,
    player.recent ? `${player.recent.wins}胜${player.recent.losses}负` : '-',
    player.recent ? player.recent.avgKda.toFixed(2) : '-',
    player.recent ? percent(player.recent.avgKillParticipation) : '-',
    player.recent ? percent(player.recent.avgDamageShare) : '-',
    player.labels.join('/') || (player.error ? '读取失败' : '-'),
  ]);
  printTable(
    ['位置', '召唤师', '评分', '近况', 'KDA', '参团', '伤害', '标签'],
    rows,
  );
}
