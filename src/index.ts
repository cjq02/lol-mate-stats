#!/usr/bin/env node
import process from 'node:process';
import type { ChampSelectSession, Snapshot } from './types.js';
import { LcuApi } from './lcu/api.js';
import { ClientNotFoundError, discoverConnection } from './lcu/discover.js';
import { findClientLogDir, probeEdge, readEdgeDiagnostics } from './lcu/edge.js';
import { fetchLiveGame, liveMembersOf } from './lcu/live.js';
import { modeFromQueue } from './stats/constants.js';
import { ReportCollector } from './stats/collector.js';
import { LiveSource } from './watcher.js';
import { DemoSource } from './demo.js';
import { openBrowser, startServer } from './server.js';
import { printReports } from './report.js';
import { colorize, dim, fail, header, logTag, ok, sleep, warn } from './util.js';

const VERSION = '0.1.0';
/** 固定 5 位端口，避免和其它开发服务器抢占 5173 */
const DEFAULT_PORT = 51730;

interface CliOptions {
  command: string;
  args: string[];
  port: number;
  recent: number;
  open: boolean;
  json: boolean;
  quiet: boolean;
  host?: string;
  token?: string;
  help: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    command: 'start',
    args: [],
    port: Number(process.env.PORT ?? DEFAULT_PORT),
    recent: Number(process.env.RECENT_GAMES ?? 10),
    open: true,
    json: false,
    quiet: false,
    help: false,
  };

  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    switch (arg) {
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '-v':
      case '--version':
        console.log(VERSION);
        process.exit(0);
        break;
      case '-p':
      case '--port':
        options.port = Number(argv[++index] ?? options.port);
        break;
      case '-r':
      case '--recent':
        options.recent = Number(argv[++index] ?? options.recent);
        break;
      case '--host':
        options.host = argv[++index];
        break;
      case '--token':
        options.token = argv[++index];
        break;
      case '--no-open':
        options.open = false;
        break;
      case '--json':
        options.json = true;
        break;
      case '--quiet':
        options.quiet = true;
        break;
      default:
        if (arg.startsWith('-')) {
          console.error(warn(`忽略未知参数：${arg}`));
        } else {
          positional.push(arg);
        }
    }
  }

  if (positional.length) {
    options.command = positional[0] as string;
    options.args = positional.slice(1);
  }
  if (!Number.isFinite(options.port) || options.port <= 0) options.port = DEFAULT_PORT;
  if (!Number.isFinite(options.recent) || options.recent <= 0) options.recent = 10;
  options.recent = Math.min(30, Math.max(1, options.recent));

  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  switch (options.command) {
    case 'start':
    case 'watch':
      try {
        await startLive(options);
      } catch (error) {
        handleError(error);
      }
      break;
    case 'demo':
      try {
        await startDemo(options);
      } catch (error) {
        handleError(error);
      }
      break;
    case 'once':
      await runOnce(options);
      break;
    case 'scan':
      await runScan(options);
      break;
    case 'doctor':
      await runDoctor(options);
      break;
    default:
      console.error(fail(`未知命令：${options.command}`));
      printHelp();
      process.exitCode = 1;
  }
}

/* ------------------------------------------------------------------ */
/* start / demo                                                        */
/* ------------------------------------------------------------------ */

async function startLive(options: CliOptions): Promise<void> {
  if (!options.quiet) {
    console.log(colorize('英雄联盟队友战绩面板', 'cyan'));
    console.log(dim('数据全部来自本地客户端 LCU 接口，不会上传任何信息'));
    console.log('');
  }

  const source = new LiveSource({ recent: options.recent, quiet: options.quiet });
  if (!options.quiet) {
    logTag('cache', '其他玩家战绩缓存 24 小时；自己的战绩每次实时读取，可在面板点「清缓存」手动清空');
  }

  const running = await startServer({
    source,
    port: options.port,
    host: options.host,
    open: options.open,
    quiet: options.quiet,
  });
  source.start();

  if (!options.quiet) {
    console.log(
      dim(`提示：进入选人阶段后会自动读取 5 名队友的最近 ${options.recent} 场战绩；`),
    );
    console.log(dim(`      也可以直接用浏览器打开 ${running.url}`));
    console.log(dim('按 Ctrl+C 退出'));
    console.log('');
  }

  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    console.log('');
    logTag('app', '正在退出…');
    await source.stop();
    await running.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

async function startDemo(options: CliOptions): Promise<void> {
  const source = new DemoSource();
  const running = await startServer({
    source,
    port: options.port,
    host: options.host,
    open: options.open,
    quiet: options.quiet,
  });
  if (!options.quiet) {
    console.log(colorize('演示模式', 'magenta'));
    console.log(dim('使用模拟数据预览界面，不会连接游戏客户端'));
    console.log(dim(`浏览器打开 ${running.url}，按 Ctrl+C 退出`));
  }
  const shutdown = async (): Promise<void> => {
    await source.stop();
    await running.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

/* ------------------------------------------------------------------ */
/* once                                                                */
/* ------------------------------------------------------------------ */

async function connect(options: CliOptions): Promise<LcuApi> {
  const envPort = Number(process.env.LCU_PORT ?? '');
  const token = options.token ?? process.env.LCU_PASSWORD;
  const connection = await discoverConnection({
    port: Number.isFinite(envPort) && envPort > 0 ? envPort : undefined,
    password: token,
  });
  if (!options.quiet) console.log(dim(`已连接客户端：127.0.0.1:${connection.port}（${connection.source}）`));
  return new LcuApi(connection);
}

async function runOnce(options: CliOptions): Promise<void> {
  try {
    const api = await connect(options);
    const phase = await api.getGameflowPhase().catch(() => '未知');

    if (phase === 'InProgress') {
      const game = await fetchLiveGame();
      const members = game ? liveMembersOf(game.allPlayers ?? [], game.activePlayer) : [];
      if (!members.length) {
        console.log(warn('游戏进行中，但还读取不到本局数据（可能在加载界面）。请稍后重试。'));
        api.destroy();
        process.exitCode = 1;
        return;
      }
      if (!options.quiet) {
        console.log(dim(`正在读取本局 ${members.length} 名玩家最近 ${options.recent} 场战绩…`));
      }
      const queueId = game?.gameData?.queue?.id;
      const gameMode = modeFromQueue(queueId, game?.gameData?.gameMode);
      const context = queueId !== undefined || gameMode ? { queueId, mode: gameMode } : undefined;
      const collector = new ReportCollector(api, { recent: options.recent });
      const reports = await collector.collectLive(members, undefined, context);
      if (options.json) {
        console.log(JSON.stringify(reports, null, 2));
      } else {
        printReports(reports, '本局玩家近期战绩');
      }
      await collector.flush();
      api.destroy();
      return;
    }

    const session = await api.getChampSelectSession();
    if (!session?.myTeam?.length) {
      console.log(warn(`当前不在选人阶段（阶段：${phase}）。请进入选人阶段或对局后重试。`));
      api.destroy();
      process.exitCode = 1;
      return;
    }

    if (!options.quiet) {
      console.log(dim(`正在读取 ${session.myTeam.length} 名队友最近 ${options.recent} 场战绩…`));
    }
    const flow = await api.getGameflowSession().catch(() => null);
    const queueId = flow?.gameData?.queue?.id;
    const gameMode = modeFromQueue(queueId, flow?.gameData?.gameMode);
    const context = queueId !== undefined || gameMode ? { queueId, mode: gameMode } : undefined;
    const collector = new ReportCollector(api, { recent: options.recent });
    const reports = await collector.collect(session, undefined, context);

    if (options.json) {
      console.log(JSON.stringify(reports, null, 2));
    } else {
      printReports(reports);
    }
    await collector.flush();
    api.destroy();
  } catch (error) {
    handleError(error);
  }
}

/* ------------------------------------------------------------------ */
/* scan                                                                */
/* ------------------------------------------------------------------ */

async function runScan(options: CliOptions): Promise<void> {
  const name = options.args[0];
  if (!name) {
    console.error(fail('用法：lol-mate-stats scan <召唤师名称>'));
    process.exitCode = 1;
    return;
  }

  try {
    const api = await connect(options);
    const summoner = await api.getSummonerByName(name);
    if (!summoner) {
      console.error(fail(`未找到召唤师：${name}`));
      console.error(dim('提示：国服需要完整名称，外服可尝试“游戏名#TAG”'));
      api.destroy();
      process.exitCode = 1;
      return;
    }

    const session: ChampSelectSession = {
      localPlayerCellId: 0,
      myTeam: [
        {
          cellId: 0,
          summonerId: summoner.summonerId,
          puuid: summoner.puuid,
          championId: 0,
          team: 1,
        },
      ],
    };

    const collector = new ReportCollector(api, { recent: options.recent });
    const reports = await collector.collect(session);
    if (options.json) {
      console.log(JSON.stringify(reports, null, 2));
    } else {
      printReports(reports, '召唤师近期战绩');
    }
    await collector.flush();
    api.destroy();
  } catch (error) {
    handleError(error);
  }
}

/* ------------------------------------------------------------------ */
/* doctor                                                              */
/* ------------------------------------------------------------------ */

async function runDoctor(options: CliOptions): Promise<void> {
  const checks: Array<{ label: string; ok: boolean; detail: string }> = [];
  let api: LcuApi | undefined;
  let connection;
  let edgeFailure = false;

  try {
    connection = await discoverConnection({
      port: Number(process.env.LCU_PORT ?? '') || undefined,
      password: options.token ?? process.env.LCU_PASSWORD,
    });
    checks.push({ label: '发现客户端', ok: true, detail: `端口 ${connection.port} · ${connection.source}` });
    api = new LcuApi(connection);
  } catch (error) {
    checks.push({
      label: '发现客户端',
      ok: false,
      detail:
        error instanceof ClientNotFoundError
          ? '未找到 LeagueClientUx 进程、lockfile 或客户端日志，请先登录客户端'
          : String(error),
    });
  }

  if (api) {
    let phase = '';
    try {
      phase = await api.getGameflowPhase();
      checks.push({ label: 'Gameflow', ok: true, detail: `当前阶段：${phase}` });
    } catch (error) {
      checks.push({ label: 'Gameflow', ok: false, detail: String(error) });
    }

    if (phase === 'InProgress') {
      const game = await fetchLiveGame(2_500);
      checks.push({
        label: '对局数据',
        ok: Boolean(game),
        detail: game
          ? `本局 ${game.allPlayers?.length ?? 0} 名玩家（端口 2999）`
          : '读取失败（加载界面或端口 2999 不可用）',
      });
    }

    try {
      const summoner = await api.getCurrentSummoner();
      checks.push({
        label: '当前账号',
        ok: true,
        detail: `${summoner.displayName?.trim() || summoner.gameName || '(未知)'} · Lv.${summoner.summonerLevel ?? '?'}`,
      });
    } catch (error) {
      checks.push({ label: '当前账号', ok: false, detail: String(error) });
    }

    try {
      const champs = await api.getChampionMap();
      checks.push({ label: '英雄数据', ok: champs.size > 0, detail: `${champs.size} 个英雄` });
    } catch (error) {
      checks.push({ label: '英雄数据', ok: false, detail: String(error) });
    }

    try {
      const region = await api.getRegion();
      checks.push({ label: '大区', ok: Boolean(region), detail: region ?? '未知' });
    } catch {
      checks.push({ label: '大区', ok: false, detail: '读取失败（不影响战绩查询）' });
    }

    try {
      const summoner = await api.getCurrentSummoner();
      const games = summoner.puuid ? await api.getMatchListByPuuid(summoner.puuid, 1) : [];
      checks.push({
        label: '战绩接口',
        ok: games.length > 0,
        detail: games.length ? '可以读取最近对局' : '返回空列表（新号或战绩被隐藏）',
      });
    } catch (error) {
      checks.push({ label: '战绩接口', ok: false, detail: String(error) });
    }

    const logDir = await findClientLogDir(connection);
    if (!logDir) {
      checks.push({
        label: '战绩 edge',
        ok: false,
        detail: '未找到客户端日志，无法检查 edge 连通性与历史请求',
      });
    } else {
      const diagnostics = await readEdgeDiagnostics(logDir);
      const sessions = diagnostics.sessions;
      const codes = new Map<number, number>();
      for (const session of sessions) {
        for (const [code, count] of Object.entries(session.codes)) {
          const key = Number(code);
          codes.set(key, (codes.get(key) ?? 0) + count);
        }
      }
      const codeText = [...codes.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([code, count]) => `${code}×${count}`)
        .join(' / ');

      if (diagnostics.edgeUrl) {
        const probe = await probeEdge(diagnostics.edgeUrl);
        checks.push({
          label: '战绩 edge',
          ok: probe.ok,
          detail: `${diagnostics.edgeUrl.replace(/^https?:\/\//, '')} · ${
            probe.ok ? `可达（HTTP ${probe.status}，${probe.ms}ms）` : `不可达：${probe.error}`
          }`,
        });
      } else {
        checks.push({ label: '战绩 edge', ok: false, detail: '日志里没有找到 edge 地址' });
      }

      const recent = sessions[0];
      const lastFailure = recent?.lastFailureAt
        ? new Date(recent.lastFailureAt).toLocaleTimeString('zh-CN', {
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
          })
        : undefined;
      checks.push({
        label: '失败记录',
        ok: diagnostics.newestFailed === 0 && !recent?.failed,
        detail:
          diagnostics.newestTotal > 0
            ? `当前会话 ${diagnostics.newestTotal} 次请求，失败 ${diagnostics.newestFailed}${
                lastFailure ? `（最后 ${lastFailure}）` : ''
              }`
            : recent
              ? `当前会话尚无请求 · 上一会话 ${recent.total} 次，失败 ${recent.failed}${
                  codeText ? `（${codeText}）` : ''
                }`
              : '最近的日志里没有战绩请求',
      });

      edgeFailure = diagnostics.newestFailed > 0 || Boolean(recent?.failed);
      const lastError = recent?.lastError;
      if (edgeFailure && lastError) {
        checks.push({ label: '最后错误', ok: false, detail: lastError });
      }
    }

    try {
      const session = await api.getChampSelectSession();
      checks.push({
        label: '选人阶段',
        ok: true,
        detail: session?.myTeam?.length
          ? `当前有 ${session.myTeam.length} 名队友`
          : '当前不在选人阶段',
      });
    } catch (error) {
      checks.push({ label: '选人阶段', ok: false, detail: String(error) });
    }

    api.destroy();
  }

  console.log('');
  console.log(header('环境诊断'));
  for (const check of checks) {
    const mark = check.ok ? ok('✔') : fail('✘');
    console.log(`${mark} ${check.label.padEnd(10)} ${dim(check.detail)}`);
  }
  console.log('');

  if (!checks.find((check) => check.label === '发现客户端')?.ok) {
    console.log(dim('若无法连接：确认客户端已登录（进入大厅）后重试；'));
    console.log(dim('也可以手动指定：set LCU_PORT=xxxxx && set LCU_PASSWORD=xxxxx'));
  }

  if (edgeFailure) {
    console.log(dim('若 edge 可达但战绩请求失败，说明是客户端/腾讯侧的查询服务在超时：'));
    console.log(dim('  先退出客户端重登 / 换网络（手机热点）/ 修复客户端；'));
    console.log(dim('  只有部分玩家失败时，是那几名玩家所在分片超时，稍后刷新即可。'));
  }
}

/* ------------------------------------------------------------------ */

function handleError(error: unknown): void {
  if (error instanceof ClientNotFoundError) {
    console.error(fail(error.message));
  } else {
    console.error(fail(`出错：${error instanceof Error ? error.message : String(error)}`));
  }
  process.exitCode = 1;
}

function printHelp(): void {
  console.log(`
${colorize('lol-mate-stats', 'cyan')} ${dim(`v${VERSION}`)} — 英雄联盟选人阶段队友战绩与评分

${header('用法')}
  lol-mate-stats [命令] [参数]

${header('命令')}
  start            启动本地面板并监听选人/对局阶段（默认）
  once             连接客户端，输出当前选人阶段或对局中的队友数据
  scan <名称>      查询指定召唤师最近战绩
  demo             使用模拟数据预览界面（不需要客户端）
  doctor           检查客户端连接与接口可用性

${header('参数')}
  -p, --port <n>   面板端口，默认 51730（固定端口）
  -r, --recent <n> 每位玩家读取的场次，默认 10
      --no-open    不自动打开浏览器
      --json       以 JSON 输出（once / scan）
      --quiet      减少日志
      --token <t>  手动指定 LCU remoting token

${header('示例')}
  npm start                       # 启动面板
  npm run once                    # 选人阶段 / 对局中直接看结果
  npm run demo                    # 无客户端时预览界面
  npx tsx src/index.ts scan "Faker#KR1"

${dim('数据来源：本地 LCU（League Client Update）接口，仅监听 127.0.0.1，不需要 Riot API Key。')}
`);
}

void main();
