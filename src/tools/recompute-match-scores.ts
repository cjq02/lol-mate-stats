import '../env.js';
import { closeDb, getDb } from '../stats/store.js';
import { percentileScores } from '../stats/rating.js';

/**
 * 用新的“局内百分位”算法重算历史对局评分。
 *
 * 用法：
 *   npm run db:recompute-scores
 *   npm run db:recompute-scores -- --game 9061816747
 *
 * 可重复执行，结果只依赖数据库里的 KDA / 伤害 / 承伤 / 治疗。
 */

interface ParticipantRow {
  participant_id: number;
  team_id: number;
  kills: number;
  deaths: number;
  assists: number;
  damage: number;
  damage_taken: number;
  heal: number;
}

interface TeamTotals {
  kills: number;
  damage: number;
  taken: number;
  heal: number;
}

function gameIdArg(): number | undefined {
  const index = process.argv.indexOf('--game');
  if (index < 0) return undefined;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

async function main(): Promise<void> {
  const db = await getDb();
  if (!db) {
    console.error('远程 MySQL 连接失败');
    process.exitCode = 1;
    return;
  }

  const onlyGame = gameIdArg();
  const [gameRows] = onlyGame
    ? await db.query('SELECT DISTINCT game_id FROM match_participants WHERE game_id = ?', [
        onlyGame,
      ])
    : await db.query(
        'SELECT DISTINCT game_id FROM match_participants ORDER BY game_id',
      );
  const gameIds = (gameRows as Array<{ game_id: number }>).map((row) => Number(row.game_id));
  console.log(`需要重算 ${gameIds.length} 场对局`);

  let updated = 0;
  for (let index = 0; index < gameIds.length; index += 1) {
    const gameId = gameIds[index]!;
    const [rows] = await db.query(
      `SELECT participant_id, team_id, kills, deaths, assists, damage,
              damage_taken, heal
       FROM match_participants
       WHERE game_id = ?
       ORDER BY participant_id`,
      [gameId],
    );
    const participants = rows as ParticipantRow[];
    if (!participants.length) continue;

    const teamTotals = new Map<number, TeamTotals>();
    for (const participant of participants) {
      const teamId = Number(participant.team_id);
      const total = teamTotals.get(teamId) ?? { kills: 0, damage: 0, taken: 0, heal: 0 };
      total.kills += Number(participant.kills);
      total.damage += Number(participant.damage);
      total.taken += Number(participant.damage_taken);
      total.heal += Number(participant.heal);
      teamTotals.set(teamId, total);
    }

    const inputs = participants.map((participant) => {
      const total = teamTotals.get(Number(participant.team_id))!;
      const kills = Number(participant.kills);
      const deaths = Number(participant.deaths);
      const assists = Number(participant.assists);
      return {
        kda: (kills + assists) / Math.max(1, deaths),
        killParticipation: total.kills > 0 ? (kills + assists) / total.kills : 0,
        damageShare: total.damage > 0 ? Number(participant.damage) / total.damage : 0,
        tankShare: total.taken > 0 ? Number(participant.damage_taken) / total.taken : 0,
        healShare: total.heal > 0 ? Number(participant.heal) / total.heal : 0,
      };
    });
    const scores = percentileScores(inputs);

    const cases = participants.map(() => 'WHEN ? THEN ?').join(' ');
    const params: Array<number | string> = [];
    participants.forEach((participant, participantIndex) => {
      params.push(Number(participant.participant_id), scores[participantIndex] ?? 0);
    });
    params.push(gameId);
    await db.query(
      `UPDATE match_participants SET score = CASE participant_id ${cases} END
       WHERE game_id = ?`,
      params,
    );
    updated += participants.length;

    if ((index + 1) % 100 === 0 || index + 1 === gameIds.length) {
      console.log(`进度 ${index + 1}/${gameIds.length}，已更新 ${updated} 条参与者记录`);
    }
  }

  // 旧的 24 小时报告缓存里还带着旧评分，清掉让下一次读取重新计算
  await db.query('DELETE FROM reports');
  console.log(`完成：${gameIds.length} 场对局，${updated} 条参与者评分已重算；报告缓存已清空`);
  await closeDb();
}

void main().catch(async (error) => {
  console.error(`重算失败：${error instanceof Error ? error.message : String(error)}`);
  await closeDb().catch(() => undefined);
  process.exitCode = 1;
});
