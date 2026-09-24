import { accessSync, constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'dsh-stool-plugin';
// 'subprocess' 必须声明：cordis 只有在被 inject 的服务就绪后才会调用 apply。
// 早先只声明 'tools'，apply 可能在 subprocess 注册前执行，导致 ctx.get('subprocess')
// 取空、全局变量未被赋值，所有 stool_* 工具报 "subprocess service not available"。
export const inject = ['tools', 'subprocess'];

// ========== stool CLI 探测 ==========
// dsh web host 由 launchd 拉起，PATH 常常不含用户级安装目录；`which` 自身也靠 PATH
// 解析，所以这里直接扫 PATH + 常见安装位置，命中即缓存绝对路径（runStool 也复用它）。
const STOOL_EXTRA_DIRS = [
  '/usr/local/bin',
  '/opt/homebrew/bin',
  '/usr/bin',
  join(homedir(), '.local/bin'),
  join(homedir(), 'bin'),
];
const STOOL_PROBE_TTL_MS = 30 * 1000;

let stoolProbe = null;          // { installed, path, version, checkedAt }
let stoolProbePromise = null;   // 合并并发探测，避免连点「重新检测」打满子进程
let stoolBinCache = null;       // stool 可执行文件绝对路径缓存

function findStoolBinary() {
  const dirs = [];
  const seen = new Set();
  const push = (dir) => {
    if (typeof dir !== 'string' || dir === '' || seen.has(dir)) return;
    seen.add(dir);
    dirs.push(dir);
  };
  for (const dir of String(process.env.PATH || '').split(':')) push(dir);
  for (const dir of STOOL_EXTRA_DIRS) push(dir);
  for (const dir of dirs) {
    const candidate = join(dir, 'stool');
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch (error) { /* 不在该目录，继续找下一个 */ }
  }
  return null;
}

function stoolBin() {
  if (!stoolBinCache) {
    stoolBinCache = findStoolBinary() || 'stool';
  }
  return stoolBinCache;
}

// subprocess 服务句柄。apply 时已强制要求就绪并缓存；这里再兜一层 ctx-free 取用，
// 供工具执行器（可能在 apply 之外被调用）使用。
function currentSubprocess() {
  const subprocess = globalThis.__dsh_subprocess;
  if (!subprocess) {
    throw new Error('[dsh-stool-plugin] subprocess service not available: the plugin was not applied with a ready subprocess service');
  }
  return subprocess;
}

// force = true 时绕过缓存重新探测（设置页「重新检测」按钮）。
function probeStool(force) {
  const now = Date.now();
  if (!force && stoolProbe && now - stoolProbe.checkedAt < STOOL_PROBE_TTL_MS) return Promise.resolve(stoolProbe);
  if (!force && stoolProbePromise) return stoolProbePromise;
  const pending = (async () => {
    const path = findStoolBinary();
    let version = null;
    if (path) {
      try {
        const result = await spawnCapture([path, 'version'], 5000, 4096);
        version = String(result.stdout || '').trim().split('\n')[0] || null;
      } catch (error) {
        // 二进制存在但跑不动（缺依赖 / 权限）：仍算已安装，版本留空。
        console.error('[dsh-stool-plugin] version probe failed:', error && error.message ? error.message : error);
        version = null;
      }
    }
    stoolProbe = { installed: !!path, path: path, version: version, checkedAt: Date.now() };
    stoolBinCache = path || 'stool';
    return stoolProbe;
  })();
  stoolProbePromise = pending;
  return pending.catch(() => {}).then(() => {
    if (stoolProbePromise === pending) stoolProbePromise = null;
  }).then(() => pending);
}

async function spawnCapture(argv, graceMs, maxBytes) {
  const subprocess = currentSubprocess();
  const handle = subprocess.spawn({
    argv: argv,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: maxBytes || 4096 },
      stderr: { maxBytes: 1024 },
    },
    graceMs: graceMs || 5000,
  });
  const outcome = await handle.done;
  const text = (r) => {
    if (r === undefined) return '';
    const v = r.readFrom(0);
    return v.text ?? '';
  };
  return {
    exitCode: outcome.exitCode,
    stdout: text(handle.collected && handle.collected.stdout),
    stderr: text(handle.collected && handle.collected.stderr),
  };
}

// 只回答同源回环请求：这条路由会暴露本机路径与版本，不能让任意网页跨站读取。
function isTrustedRequest(req) {
  const hostHeader = req.headers && req.headers.host;
  if (typeof hostHeader !== 'string' || hostHeader === '') return false;
  let hostUrl;
  try { hostUrl = new URL('http://' + hostHeader); } catch (error) { return false; }
  const hostname = String(hostUrl.hostname || '').replace(/^\[|\]$/g, '');
  const isLoopback = hostname === 'localhost' || hostname === '::1' ||
    hostname.startsWith('127.') || hostname.startsWith('::ffff:127.');
  if (!isLoopback) return false;
  if (req.headers && req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers && req.headers.origin;
  if (origin === undefined || origin === '') return true;
  try { return new URL(origin).host === hostUrl.host; } catch (error) { return false; }
}

async function runStool(args) {
  const subprocess = currentSubprocess();
  const stoolPath = stoolBin();
  // 回落到裸命令名说明 PATH 和常见安装目录都没命中，直接给出可执行指引，
  // 比让子进程抛一句模糊的 spawn ENOENT 更好排查。
  if (stoolPath === 'stool' && !findStoolBinary()) {
    throw new Error('未在本机找到 stool 命令。请安装 SuperTool CLI：https://github.com/fufengyuan/supertool ；' +
      '安装后到「设置 → 插件 → Stool 运维工具箱」点“重新检测”，或重启 dsh 进程。');
  }
  const handle = subprocess.spawn({
    argv: [stoolPath, ...args],
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 4 * 1024 * 1024 },
      stderr: { maxBytes: 1024 * 1024 },
    },
    graceMs: 30000,
  });
  const outcome = await handle.done;
  const text = (r) => {
    if (r === undefined) return '';
    const v = r.readFrom(0);
    return v.text ?? '';
  };
  const stdout = text(handle.collected && handle.collected.stdout);
  const stderr = text(handle.collected && handle.collected.stderr);
  if (outcome.exitCode !== 0) throw new Error(stderr || ('exit ' + outcome.exitCode));
  try { return JSON.parse(stdout); } catch (e) { return { ok: true, data: stdout }; }
}

function renderOutput(_args, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return [{ type: 'text', text }];
}

function makeTool(name, description, props, exec) {
  const parameters = {};
  const keys = Object.keys(props);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i], v = props[k];
    parameters[k] = { type: v.t, description: v.d };
    if (v.r) parameters[k].required = true;
  }
  return defineTool({
    name,
    description,
    parameters,
    output: { schema: { type: 'string' }, render: renderOutput },
    execute: async (a) => {
      const r = await exec(a);
      return typeof r === 'string' ? r : JSON.stringify(r);
    },
  });
}

export function apply(ctx) {
  // 缓存 subprocess 供工具执行器使用。
  // inject 已声明 'subprocess'，此处应必然就绪；若仍为空则明确报错，
  // 不再静默跳过（静默会让后续每个工具都抛一句难以定位的 not available）。
  const subprocess = ctx.subprocess ?? ctx.get('subprocess');
  if (!subprocess) {
    throw new Error('[dsh-stool-plugin] subprocess service unavailable: check that @deepseek-ai/dsh-subprocess-local is loaded in this profile');
  }
  globalThis.__dsh_subprocess = subprocess;
  // 启动即解析 stool 绝对路径，并异步预热版本缓存：
  // 设置页第一次打开就能直接拿到探测结果，探测失败也不影响工具注册。
  try {
    stoolBin();
    probeStool(true).catch(function () {});
  } catch (e) { /* ignore */ }

  // ========== 设置页可派发的先决条件 ==========
  // dsh rc.7 起，Plugins 设置页按「Host 在 settings.describe 中应答的命名空间」派发卡片：
  // 卡片 slot 的 key 必须命中一个已注册的命名空间，否则永远不会被渲染。
  // 这里注册一个空的 pass-through 命名空间，唯一作用就是让 stool 卡片可被派发；
  // 插件本身没有需要持久化的配置项（与 @liustack/modlens 的 'modlens' 命名空间同一做法）。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (scope) => {
      try {
        const passThrough = (value) => ({ ...(value || {}) });
        passThrough.toJSON = () => ({
          uid: 0,
          refs: { 0: { type: 'object', meta: { default: {} }, dict: {} } },
        });
        scope.settings.register('stool', passThrough, { base: {} });
      } catch (error) {
        console.error(`[dsh-stool-plugin] settings namespace skipped: ${error}`);
      }
    });
  }

  // ========== 设置页的自动检测接口 ==========
  // 浏览器无法自己 spawn 进程，所以由 Host 暴露一个只读状态路由：
  // GET /stool/status → { installed, path, version, checkedAt }，?refresh=1 绕过缓存。
  // 用 ctx.inject(['webServer']) 惰性拿服务：桌面端等没有 webServer 的场景静默跳过，
  // 卡片侧拿不到接口会退回「状态未知」，不会白屏。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scope) => {
      const register = () => scope.webServer.register({
        name: 'stool-status',
        kind: 'exact',
        path: '/stool/status',
        handler: async (req, res) => {
          const send = (status, body) => {
            res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            res.end(JSON.stringify(body));
          };
          if (req.method !== 'GET') {
            res.writeHead(405, { allow: 'GET' });
            res.end();
            return;
          }
          if (!isTrustedRequest(req)) {
            send(403, { error: 'request refused: this route answers same-origin loopback only' });
            return;
          }
          try {
            const force = new URL(req.url, 'http://localhost').searchParams.has('refresh');
            const probe = await probeStool(force);
            send(200, {
              ok: true,
              installed: probe.installed,
              path: probe.path,
              version: probe.version,
              checkedAt: probe.checkedAt,
            });
          } catch (error) {
            send(500, { error: error instanceof Error ? error.message : String(error) });
          }
        },
      });
      try {
        if (typeof scope.effect === 'function') scope.effect(register, 'dsh-stool-plugin: status route');
        else register();
      } catch (error) {
        console.error(`[dsh-stool-plugin] status route skipped: ${error}`);
      }
    });
  }

  // ========== 1. 服务器管理 ==========
  ctx.tools.register(makeTool('stool_server',
    '服务器管理。动作：list 列出服务器 / test 测SSH连通性 / exec 执行远程命令(危险命令会被拦截) / ' +
    'exec-batch 按行批量执行脚本(首条失败即停，适合 cd+git pull+构建+重启 这类多步操作) / ' +
    'health 健康检查(负载磁盘内存) / diagnose 详细诊断 / read 读远程文件 / ls 列远程目录 / ' +
    'download 下载远程文件到本地 / upload 上传本地文件或目录到远程(path=本地, remotePath=远程目标，目录自动递归) / mkdir 建远程目录 / ' +
    'rm 删远程文件(系统目录被拦截) / java-ps 看Java进程(PID/端口/堆内存/运行时长) / ' +
    'java-restart 按jar名停Java进程(kill→等待→SIGKILL，不会自动拉起，停完要配合cicd deploy重新部署)。' +
    '注意：exec/exec-batch/mkdir/rm 属写操作，GUI 开了审批开关时会被拦截(exit 3)，此时提示用户去 GUI 操作。',
    {
      action: { t: 'string', d: '操作: list / test / exec / exec-batch / health / diagnose / read / ls / download / upload / mkdir / rm / java-ps / java-restart', r: true },
      serverId: { t: 'string', d: '服务器ID，action=list时可不填；其余动作必填' },
      command: { t: 'string', d: '要执行的命令，仅exec时需要。危险命令(rm -rf/kill -9/shutdown/curl|sh)会被拦截' },
      script: { t: 'string', d: '多行脚本，仅exec-batch时需要，按\\n分行顺序执行，#开头为注释，空行跳过' },
      path: { t: 'string', d: '远程路径。read/ls/mkdir/rm 用；download 时为远程文件；upload 时为本地路径' },
      output: { t: 'string', d: '本地保存路径，仅download时可选（默认取远程文件名）' },
      remotePath: { t: 'string', d: '远程目标路径，仅upload需要（上传目录时为远程父目录）' },
      name: { t: 'string', d: 'jar名称，仅java-restart时需要（按名字匹配Java进程）' },
      timeout: { t: 'number', d: '超时秒数。exec默认60，exec-batch默认120，java-restart默认60' },
    },
    async (a) => {
      const need = (v, label) => { if (!v) throw new Error('action=' + a.action + ' 需要参数 ' + label); return v; };
      switch (a.action) {
        case 'list': return await runStool(['server', 'list', '--json']);
        case 'test': return await runStool(['server', 'test', need(a.serverId, 'serverId'), '--json']);
        case 'exec': {
          const cmd = ['server', 'exec', need(a.serverId, 'serverId'), need(a.command, 'command')];
          if (a.timeout) cmd.push('--timeout', String(a.timeout));
          return await runStool(cmd);
        }
        case 'exec-batch': {
          const cmd = ['server', 'exec-batch', need(a.serverId, 'serverId'), '--script', need(a.script, 'script')];
          if (a.timeout) cmd.push('--timeout', String(a.timeout));
          return await runStool(cmd);
        }
        case 'health': return await runStool(['server', 'health', need(a.serverId, 'serverId'), '--json']);
        case 'diagnose': return await runStool(['server', 'diagnose', need(a.serverId, 'serverId'), '--json']);
        case 'read': return await runStool(['server', 'read', need(a.serverId, 'serverId'), need(a.path, 'path')]);
        case 'ls': {
          const cmd = ['server', 'ls', need(a.serverId, 'serverId')];
          if (a.path) cmd.push('--path', a.path);
          return await runStool(cmd);
        }
        case 'download': {
          const cmd = ['server', 'download', need(a.serverId, 'serverId'), need(a.path, 'path')];
          if (a.output) cmd.push('--output', a.output);
          return await runStool(cmd);
        }
        case 'upload': return await runStool(['server', 'upload', need(a.serverId, 'serverId'), need(a.path, 'path'), need(a.remotePath, 'remotePath')]);
        case 'mkdir': return await runStool(['server', 'mkdir', need(a.serverId, 'serverId'), need(a.path, 'path')]);
        case 'rm': return await runStool(['server', 'rm', need(a.serverId, 'serverId'), need(a.path, 'path')]);
        case 'java-ps': return await runStool(['server', 'java-ps', need(a.serverId, 'serverId'), '--json']);
        case 'java-restart': {
          const cmd = ['server', 'java-restart', need(a.serverId, 'serverId'), need(a.name, 'name')];
          if (a.timeout) cmd.push('--timeout', String(a.timeout));
          return await runStool(cmd);
        }
        default: throw new Error('未知操作: ' + a.action + '，可选: list/test/exec/exec-batch/health/diagnose/read/ls/download/upload/mkdir/rm/java-ps/java-restart');
      }
    }
  ));

  // ========== 2. 数据库管理 ==========
  const REDIS_SUBCOMMANDS = ['keys', 'get', 'set', 'delete', 'type', 'ttl', 'h-get', 'h-get-all', 'h-len', 'l-range', 'l-len', 's-members', 's-card'];
  ctx.tools.register(makeTool('stool_db',
    '数据库与 Redis。动作：list 列出连接 / query 执行SQL / databases 列出库 / tables 列表 / structure 看表结构 / ' +
    'data 分页浏览表数据(limit/offset) / redis 执行Redis子命令。' +
    'SQL 用 -d <dbId> 引用 GUI 里配好的连接，CLI 无状态(连→执行→断)。' +
    '写操作注意：审批连接只放行只读白名单(SELECT/SHOW/EXPLAIN/DESC/PRAGMA)，INSERT/UPDATE/DELETE/DROP 会被拦截(exit 3)；' +
    'redis 的 set/delete 在审批连接上同样被拦。MySQL/PG/SQLite/ES 都是同一个 query 入口。' +
    '写/DDL 前先用 structure 确认字段、确认 dbId 指向的是测试库。',
    {
      action: { t: 'string', d: '操作: list / query / databases / tables / structure / data / redis', r: true },
      dbId: { t: 'string', d: '数据库连接ID，action=list时可不填；其余动作必填' },
      sql: { t: 'string', d: 'SQL语句，仅query时需要' },
      redisCommand: { t: 'string', d: 'Redis 子命令: keys / get / set / delete / type / ttl / h-get / h-get-all / h-len / l-range / l-len / s-members / s-card，仅redis时需要' },
      key: { t: 'string', d: 'Redis key，仅redis的 get/set/delete/type/ttl/h-*/l-*/s-* 需要；keys 时可传通配模式如 session:*（默认为 *）' },
      value: { t: 'string', d: 'Redis 值，仅redis的 set 需要' },
      field: { t: 'string', d: 'Hash 字段名，仅redis的 h-get 需要' },
      start: { t: 'number', d: 'List 起始下标，仅redis的 l-range 可选（默认 0）' },
      stop: { t: 'number', d: 'List 结束下标，仅redis的 l-range 可选（默认 -1）' },
      database: { t: 'string', d: '数据库名，仅tables/structure/data可选（不填用连接配置的默认库）' },
      table: { t: 'string', d: '表名，仅structure/data需要' },
      limit: { t: 'number', d: '返回条数上限，仅data可选（默认100）' },
      offset: { t: 'number', d: '偏移量，仅data可选（默认0）' },
    },
    async (a) => {
      const need = (v, label) => { if (!v) throw new Error('action=' + a.action + ' 需要参数 ' + label); return v; };
      const dbFlag = () => ['-d', need(a.dbId, 'dbId')];
      const dbName = () => (a.database ? ['--db', a.database] : []);
      switch (a.action) {
        case 'list': return await runStool(['db', 'list', '--json']);
        case 'query': return await runStool(['db', 'query'].concat(dbFlag(), [need(a.sql, 'sql'), '--json']));
        case 'databases': return await runStool(['db', 'databases'].concat(dbFlag(), ['--json']));
        case 'tables': return await runStool(['db', 'tables'].concat(dbFlag(), dbName(), ['--json']));
        case 'structure': return await runStool(['db', 'structure'].concat(dbFlag(), dbName(), [need(a.table, 'table'), '--json']));
        case 'data': {
          const cmd = ['db', 'data'].concat(dbFlag(), dbName(), [need(a.table, 'table')]);
          if (a.limit) cmd.push('-l', String(a.limit));
          if (a.offset) cmd.push('--offset', String(a.offset));
          cmd.push('--json');
          return await runStool(cmd);
        }
        case 'redis': {
          const sub = need(a.redisCommand, 'redisCommand');
          if (REDIS_SUBCOMMANDS.indexOf(sub) === -1) {
            throw new Error('未知 Redis 子命令: ' + sub + '，可选: ' + REDIS_SUBCOMMANDS.join('/'));
          }
          // keys 的 key 参数是可选的通配模式；get/type/ttl 等需要具体 key。
          const argv = ['db', 'redis'].concat(dbFlag(), [sub]);
          // redis 子命令不接受 --json，只有值类输出不需要它。
          if (sub === 'keys') { if (a.key) argv.push(a.key); }
          else if (sub === 'set') { argv.push(need(a.key, 'key'), need(a.value, 'value')); }
          else if (['h-get', 'l-range'].indexOf(sub) !== -1) {
            argv.push(need(a.key, 'key'));
            if (sub === 'h-get') argv.push(need(a.field, 'field'));
            else { argv.push(String(a.start || 0), String(a.stop === undefined ? -1 : a.stop)); }
          } else { argv.push(need(a.key, 'key')); }
          return await runStool(argv);
        }
        default: throw new Error('未知操作: ' + a.action + '，可选: list/query/databases/tables/structure/data/redis');
      }
    }
  ));

  // ========== 3. 日志管理 ==========
  ctx.tools.register(makeTool('stool_log',
    '日志查询。动作：list 列出预设(含分组) / search 搜索 / tail 看末尾N行(静态非流式) / context 看指定行号周边上下文(命中行标▶) / ' +
    'add 新增预设 / delete 删预设。' +
    '排查套路：先用业务唯一标识(订单号/traceId)搜到入口日志拿到 traceId，再用 traceId 搜全链路并加大 lines(200+)；' +
    'keyword 支持 | 做多关键词 OR，如 "核销失败|status=5|doPrePay"；需正则时置 regex=true。' +
    '关键坑：不带 date/days 只查当前日志文件，翻历史必须给 date 或 days；二者互斥。' +
    'docker/journalctl 类型预设不支持历史查询。',
    {
      action: { t: 'string', d: '操作: list / search / tail / context / add / delete', r: true },
      presetId: { t: 'string', d: '日志预设ID，也可以直接填 list 里的序号，action=list时可不填' },
      keyword: { t: 'string', d: '搜索关键词，支持traceId/错误信息；含 | 时自动按多关键词 OR 拆分，仅search时需要' },
      days: { t: 'number', d: '搜最近N天(含今天)的轮转日志，1=仅今天；与date互斥（可选）' },
      date: { t: 'string', d: '搜某天写入的轮转日志，格式YYYY-MM-DD；与days互斥（可选）' },
      lines: { t: 'number', d: '行数上限：search默认50(实为搜索范围)，tail默认100（可选）' },
      regex: { t: 'boolean', d: '整串按 ERE 正则匹配（默认按字面量），仅search可选' },
      serverId: { t: 'string', d: '服务器ID，仅context需要' },
      lineNumber: { t: 'number', d: '目标行号，仅context需要（该行会标 ▶）' },
      contextLines: { t: 'number', d: '上下文行数，仅context可选（默认20，目标行上下各半）' },
      name: { t: 'string', d: '预设名称，仅add需要' },
      serverIds: { t: 'string', d: '服务器ID列表，逗号分隔，仅add需要' },
      logPath: { t: 'string', d: '日志文件路径，仅add需要' },
      logType: { t: 'string', d: '日志类型，仅add可选（如 tail）' },
    },
    async (a) => {
      const need = (v, label) => { if (!v) throw new Error('action=' + a.action + ' 需要参数 ' + label); return v; };
      switch (a.action) {
        case 'list': return await runStool(['log', 'list', '--json']);
        case 'search': {
          const cmd = ['log', 'search', need(a.presetId, 'presetId'), need(a.keyword, 'keyword')];
          if (a.lines) cmd.push('-l', String(a.lines));
          if (a.date) cmd.push('--date', a.date);
          if (a.days) cmd.push('--days', String(a.days));
          if (a.regex) cmd.push('-E');
          return await runStool(cmd);
        }
        case 'tail': {
          const cmd = ['log', 'tail', need(a.presetId, 'presetId')];
          if (a.lines) cmd.push('-l', String(a.lines));
          return await runStool(cmd);
        }
        case 'context': {
          const cmd = ['log', 'context', need(a.presetId, 'presetId'), need(a.serverId, 'serverId'), String(need(a.lineNumber, 'lineNumber'))];
          if (a.contextLines) cmd.push('-c', String(a.contextLines));
          return await runStool(cmd);
        }
        case 'add': {
          const cmd = ['log', 'add', need(a.name, 'name'), '--server-ids', need(a.serverIds, 'serverIds'), '--log-path', need(a.logPath, 'logPath')];
          if (a.logType) cmd.push('--log-type', a.logType);
          return await runStool(cmd);
        }
        case 'delete': return await runStool(['log', 'delete', need(a.presetId, 'presetId')]);
        default: throw new Error('未知操作: ' + a.action + '，可选: list/search/tail/context/add/delete');
      }
    }
  ));

  // ========== 4. CI/CD 部署 ==========
  ctx.tools.register(makeTool('stool_cicd',
    'CI/CD 部署。动作：list 列出配置 / status 看配置状态(按项目ID) / deploy 部署 / history 部署历史(可按状态过滤) / ' +
    'step-logs 看某次部署的阶段日志 / rollback 回滚到指定部署 / cancel 取消进行中的部署 / modules 列配置的部署模块 / ' +
    'logs 看配置最近的部署日志 / tools 检测构建工具与SDK版本(带scanPath可扫项目模块树)。' +
    'deploy 建议先用 status 核对分支与部署路径；stream 实时输出事件，watch 每5秒轮询直到结束(最长10分钟)，二者可同用；' +
    'branch 覆盖配置里的 deployBranch。' +
    '注意：deploy/rollback/cancel 是写操作，GUI 开了审批开关会被拦截(exit 3)，此时让用户去 GUI 操作，不要绕过。',
    {
      action: { t: 'string', d: '操作: list / status / deploy / history / step-logs / rollback / cancel / modules / logs / tools', r: true },
      configId: { t: 'string', d: '部署配置ID，action=list/tools时可不填；status 改用 projectId' },
      projectId: { t: 'string', d: '项目ID，仅status需要' },
      deployLogId: { t: 'string', d: '部署记录ID，仅step-logs/rollback需要' },
      branch: { t: 'string', d: '部署分支，仅deploy可选（覆盖配置中的 deployBranch）' },
      stream: { t: 'boolean', d: '流式输出部署进度事件，仅deploy可用' },
      watch: { t: 'boolean', d: '轮询直到部署结束（每5秒，最长10分钟），仅deploy可用' },
      status: { t: 'string', d: '按状态过滤 success/failed/rolled_back/cancelled，仅history可用' },
      limit: { t: 'number', d: '返回条数上限，仅history/logs可选（history默认20）' },
      scanPath: { t: 'string', d: '项目路径，仅tools可选（填了才扫描 pom.xml/build.gradle/package.json 与模块树）' },
    },
    async (a) => {
      const need = (v, label) => { if (!v) throw new Error('action=' + a.action + ' 需要参数 ' + label); return v; };
      switch (a.action) {
        case 'list': return await runStool(['cicd', 'list', '--json']);
        case 'status': return await runStool(['cicd', 'status', need(a.projectId, 'projectId'), '--json']);
        case 'deploy': {
          const cmd = ['cicd', 'deploy', need(a.configId, 'configId')];
          if (a.stream) cmd.push('--stream');
          if (a.watch) cmd.push('--watch');
          if (a.branch) cmd.push('-b', a.branch);
          return await runStool(cmd);
        }
        case 'history': {
          const cmd = ['cicd', 'history', need(a.configId, 'configId')];
          if (a.limit) cmd.push('-l', String(a.limit));
          if (a.status) cmd.push('--status', a.status);
          cmd.push('--json');
          return await runStool(cmd);
        }
        case 'step-logs': return await runStool(['cicd', 'step-logs', need(a.deployLogId, 'deployLogId'), '--json']);
        case 'rollback': return await runStool(['cicd', 'rollback', need(a.configId, 'configId'), need(a.deployLogId, 'deployLogId')]);
        case 'cancel': return await runStool(['cicd', 'cancel', need(a.configId, 'configId')]);
        case 'modules': return await runStool(['cicd', 'modules', need(a.configId, 'configId'), '--json']);
        case 'logs': {
          const cmd = ['cicd', 'logs', need(a.configId, 'configId')];
          if (a.limit) cmd.push('-l', String(a.limit));
          return await runStool(cmd);
        }
        case 'tools': {
          const cmd = ['cicd', 'tools'];
          if (a.scanPath) cmd.push('--scan-path', a.scanPath);
          cmd.push('--json');
          return await runStool(cmd);
        }
        default: throw new Error('未知操作: ' + a.action + '，可选: list/status/deploy/history/step-logs/rollback/cancel/modules/logs/tools');
      }
    }
  ));

  // ========== 5. MFA 双因子认证 ==========
  ctx.tools.register(makeTool('stool_mfa',
    'MFA 双因子认证。动作：list 列出密钥 / code 生成单个TOTP / codes 批量输出所有密钥当前验证码 / ' +
    'add 添加密钥 / delete 删密钥 / parse-uri 解析 otpauth:// 链接。' +
    'code 的标识符支持 ID、list 里的序号或名称关键字；登录被 MFA 卡住时直接用 codes 一次性拿全部验证码挑选。' +
    '秘密必须是 Base32（添加时会校验），TOTP 按 RFC 6238 计算。code 传空标识符会明确报错，不会模糊匹配。',
    {
      action: { t: 'string', d: '操作: list / code / codes / add / delete / parse-uri', r: true },
      id: { t: 'string', d: 'MFA条目标识：ID、序号或名称关键字，仅code/delete需要' },
      name: { t: 'string', d: '名称，仅add需要' },
      secret: { t: 'string', d: 'Base32 密钥，仅add需要' },
      issuer: { t: 'string', d: '发行方，仅add可选' },
      digits: { t: 'number', d: '验证码位数，仅add可选（默认6）' },
      period: { t: 'number', d: '周期秒数，仅add可选（默认30）' },
      algorithm: { t: 'string', d: '算法，仅add可选（默认SHA1）' },
      uri: { t: 'string', d: 'otpauth:// 链接，仅parse-uri需要' },
    },
    async (a) => {
      const need = (v, label) => { if (!v) throw new Error('action=' + a.action + ' 需要参数 ' + label); return v; };
      switch (a.action) {
        case 'list': return await runStool(['mfa', 'list', '--json']);
        case 'code': return await runStool(['mfa', 'code', need(a.id, 'id')]);
        case 'codes': return await runStool(['mfa', 'codes', '--json']);
        case 'add': {
          const cmd = ['mfa', 'add', need(a.name, 'name'), need(a.secret, 'secret')];
          if (a.issuer) cmd.push('--issuer', a.issuer);
          if (a.digits) cmd.push('--digits', String(a.digits));
          if (a.period) cmd.push('--period', String(a.period));
          if (a.algorithm) cmd.push('--algorithm', a.algorithm);
          return await runStool(cmd);
        }
        case 'delete': return await runStool(['mfa', 'delete', need(a.id, 'id')]);
        case 'parse-uri': return await runStool(['mfa', 'parse-uri', need(a.uri, 'uri'), '--json']);
        default: throw new Error('未知操作: ' + a.action + '，可选: list/code/codes/add/delete/parse-uri');
      }
    }
  ));

  // ========== 6. Git 仓库操作 ==========
  ctx.tools.register(makeTool('stool_git',
    'Git 仓库操作。动作：list 列出已登记仓库 / status 工作区状态 / log 提交记录 / branches 分支 / pull 拉取 / ' +
    'push 推送 / commit 提交(可指定文件) / checkout 切分支。' +
    '除 list 外都需要 repoPath 指向本地仓库路径。' +
    '注意：commit 不填 files 会提交全部改动，提交前先看 status 核对，不要顺手带进无关文件。',
    {
      action: { t: 'string', d: '操作: list / status / log / branches / pull / push / commit / checkout', r: true },
      repoPath: { t: 'string', d: '仓库本地路径，如 /Users/duormi/workspace/pre-pay-service，action=list时可不填' },
      message: { t: 'string', d: '提交信息，仅commit需要' },
      files: { t: 'string', d: '要提交的文件，逗号分隔，仅commit可选（不填提交全部改动）' },
      branch: { t: 'string', d: '分支名，仅checkout需要' },
      limit: { t: 'number', d: '返回条数上限，仅log可选（默认20）' },
    },
    async (a) => {
      const need = (v, label) => { if (!v) throw new Error('action=' + a.action + ' 需要参数 ' + label); return v; };
      if (a.action === 'list') return await runStool(['git', 'list', '--json']);
      const actions = ['status', 'log', 'branches', 'pull', 'push', 'commit', 'checkout'];
      if (actions.indexOf(a.action) === -1) throw new Error('未知操作，可选: list/' + actions.join('/'));
      const cmd = ['git', a.action, '--path', need(a.repoPath, 'repoPath')];
      if (a.action === 'log' && a.limit) cmd.push('-l', String(a.limit));
      if (a.action === 'commit') {
        cmd.push('-m', need(a.message, 'message'));
        if (a.files) for (const f of a.files.split(',')) { const t = f.trim(); if (t) cmd.push('--files', t); }
      }
      if (a.action === 'checkout') cmd.push('--branch', need(a.branch, 'branch'));
      if (a.action !== 'pull' && a.action !== 'push' && a.action !== 'commit' && a.action !== 'checkout') cmd.push('--json');
      return await runStool(cmd);
    }
  ));

  // ========== 7. 笔记管理 ==========
  ctx.tools.register(makeTool('stool_note',
    '笔记管理。动作：list 列出笔记(可按关键字/分组过滤) / add 添加 / update 更新 / delete 删除 / ' +
    'groups 列分组 / add-group 建分组 / update-group 改分组 / delete-group 删分组。' +
    'CLI 没有独立的 note search 子命令，按关键字搜索用 list + keyword 实现。' +
    '分组要用 groupId（不是分组名），先 groups 拿 ID。',
    {
      action: { t: 'string', d: '操作: list / add / update / delete / groups / add-group / update-group / delete-group', r: true },
      id: { t: 'string', d: '笔记ID，仅update/delete需要；改分组时是分组ID' },
      title: { t: 'string', d: '笔记标题，仅add需要，update可选' },
      content: { t: 'string', d: '笔记内容，add/update可选' },
      groupId: { t: 'string', d: '分组ID，add/update可选（先用groups拿ID）' },
      tags: { t: 'string', d: '标签，逗号分隔，add/update可选' },
      keyword: { t: 'string', d: '搜索关键词，仅list可选' },
      name: { t: 'string', d: '分组名称，仅add-group需要，update-group可选' },
      color: { t: 'string', d: '分组颜色如 #FF0000，add-group/update-group可选' },
    },
    async (a) => {
      const need = (v, label) => { if (!v) throw new Error('action=' + a.action + ' 需要参数 ' + label); return v; };
      switch (a.action) {
        case 'list': {
          const cmd = ['note', 'list'];
          if (a.keyword) cmd.push('--query', a.keyword);
          if (a.groupId) cmd.push('--group-id', a.groupId);
          cmd.push('--json');
          return await runStool(cmd);
        }
        case 'add': {
          const cmd = ['note', 'add', need(a.title, 'title')];
          if (a.content) cmd.push('--content', a.content);
          if (a.groupId) cmd.push('--group-id', a.groupId);
          if (a.tags) cmd.push('--tags', a.tags);
          return await runStool(cmd);
        }
        case 'update': {
          const cmd = ['note', 'update', need(a.id, 'id')];
          if (a.title) cmd.push('--title', a.title);
          if (a.content) cmd.push('--content', a.content);
          if (a.groupId) cmd.push('--group-id', a.groupId);
          if (a.tags) cmd.push('--tags', a.tags);
          return await runStool(cmd);
        }
        case 'delete': return await runStool(['note', 'delete', need(a.id, 'id')]);
        case 'groups': return await runStool(['note', 'groups', '--json']);
        case 'add-group': {
          const cmd = ['note', 'add-group', need(a.name, 'name')];
          if (a.color) cmd.push('--color', a.color);
          return await runStool(cmd);
        }
        case 'update-group': {
          const cmd = ['note', 'update-group', need(a.id, 'id')];
          if (a.name) cmd.push('--name', a.name);
          if (a.color) cmd.push('--color', a.color);
          return await runStool(cmd);
        }
        case 'delete-group': return await runStool(['note', 'delete-group', need(a.id, 'id')]);
        default: throw new Error('未知操作: ' + a.action + '，可选: list/add/update/delete/groups/add-group/update-group/delete-group');
      }
    }
  ));

  // ========== 8. 待办任务 ==========
  // 注意参数名必须是 CLI 的 -d/--due 与 -t/--tag（单数）；早期版本误用了 --deadline/--tags，
  // 会被 clap 当成未知参数直接报 exit 2。
  ctx.tools.register(makeTool('stool_todo',
    '待办任务管理。动作：list 列出(可按完成状态/标签过滤) / add 新增 / complete 标记完成 / uncomplete 取消完成 / ' +
    'delete 删除 / show 看详情 / edit 编辑 / search 按关键字搜 / stats 统计 / clear 清空已完成。' +
    'add 除文本外都可选：priority、due(截止日期)、tag(单个标签)、description、projectId。' +
    '要挂到项目下用 projectId（先看 stool_project 的 list）。',
    {
      action: { t: 'string', d: '操作: list / add / complete / uncomplete / delete / show / edit / search / stats / clear', r: true },
      title: { t: 'string', d: '任务文本，add需要，edit可选（改文本）' },
      id: { t: 'string', d: '任务ID，complete/uncomplete/delete/show/edit需要' },
      keyword: { t: 'string', d: '搜索关键词，仅search需要' },
      priority: { t: 'string', d: '优先级 high/medium/low，add/edit可选' },
      due: { t: 'string', d: '截止日期，仅add/edit可选（对应 CLI 的 -d/--due）' },
      tag: { t: 'string', d: '标签，仅add/edit可选（单个标签，对应 CLI 的 -t/--tag）' },
      description: { t: 'string', d: '描述，add/edit可选' },
      projectId: { t: 'string', d: '所属项目ID，仅add可选' },
      completed: { t: 'boolean', d: '按完成状态过滤，仅list可选（true/false）' },
      limit: { t: 'number', d: '返回条数上限，仅list可选（默认50）' },
    },
    async (a) => {
      const need = (v, label) => { if (!v) throw new Error('action=' + a.action + ' 需要参数 ' + label); return v; };
      const applyEditFields = (cmd) => {
        if (a.title) cmd.push('--text', a.title);
        if (a.priority) cmd.push('-p', a.priority);
        if (a.due) cmd.push('--due', a.due);
        // edit 子命令里 -t 是 --text，标签必须用 -g/--tag，别和 add 混用。
        if (a.tag) cmd.push('-g', a.tag);
        if (a.description) cmd.push('--description', a.description);
        return cmd;
      };
      switch (a.action) {
        case 'list': {
          const cmd = ['todo', 'list'];
          if (a.completed !== undefined) cmd.push('-c', String(a.completed));
          if (a.tag) cmd.push('-t', a.tag);
          if (a.limit) cmd.push('-l', String(a.limit));
          cmd.push('--json');
          return await runStool(cmd);
        }
        case 'add': {
          const cmd = ['todo', 'add', need(a.title, 'title')];
          if (a.priority) cmd.push('-p', a.priority);
          if (a.due) cmd.push('-d', a.due);
          if (a.tag) cmd.push('-t', a.tag);
          if (a.description) cmd.push('--description', a.description);
          if (a.projectId) cmd.push('--project-id', a.projectId);
          return await runStool(cmd);
        }
        case 'complete': return await runStool(['todo', 'complete', need(a.id, 'id')]);
        case 'uncomplete': return await runStool(['todo', 'uncomplete', need(a.id, 'id')]);
        case 'delete': return await runStool(['todo', 'delete', need(a.id, 'id')]);
        case 'show': return await runStool(['todo', 'show', need(a.id, 'id'), '--json']);
        case 'edit': return await runStool(applyEditFields(['todo', 'edit', need(a.id, 'id')]));
        case 'search': return await runStool(['todo', 'search', need(a.keyword, 'keyword'), '--json']);
        case 'stats': return await runStool(['todo', 'stats', '--json']);
        case 'clear': return await runStool(['todo', 'clear']);
        default: throw new Error('未知操作: ' + a.action + '，可选: list/add/complete/uncomplete/delete/show/edit/search/stats/clear');
      }
    }
  ));

  // ========== 9. Nginx 配置 ==========
  ctx.tools.register(makeTool('stool_nginx',
    'Nginx 配置管理。动作：list 列预设 / add 加预设 / update 改预设 / delete 删预设 / ' +
    'fetch 从远程服务器拉配置 / test 测试远程配置(nignx -t) / deploy 部署配置到远程 / versions 看配置版本历史。' +
    '安全：deploy 是写操作，GUI 的 Nginx 页面有模块级审批开关，开启后会被拦截(exit 3)；' +
    '部署前先 fetch 拉现状、test 校验语法，别直接覆盖线上配置。',
    {
      action: { t: 'string', d: '操作: list / add / update / delete / fetch / test / deploy / versions', r: true },
      id: { t: 'string', d: '预设ID，update/delete需要；versions复用它' },
      name: { t: 'string', d: '名称，add需要，update可选' },
      serverId: { t: 'string', d: '服务器ID，add/update可选；fetch/test/deploy需要' },
      configPath: { t: 'string', d: '配置文件路径，add/update可选；fetch/test/deploy需要' },
      content: { t: 'string', d: '配置内容，仅add/deploy需要' },
    },
    async (a) => {
      const need = (v, label) => { if (!v) throw new Error('action=' + a.action + ' 需要参数 ' + label); return v; };
      switch (a.action) {
        case 'list': return await runStool(['nginx', 'list', '--json']);
        case 'add': {
          const cmd = ['nginx', 'add', need(a.name, 'name')];
          if (a.serverId) cmd.push('--server-id', a.serverId);
          if (a.configPath) cmd.push('--config-path', a.configPath);
          if (a.content) cmd.push('--content', a.content);
          return await runStool(cmd);
        }
        case 'update': {
          const cmd = ['nginx', 'update', need(a.id, 'id')];
          if (a.name) cmd.push('--name', a.name);
          if (a.serverId) cmd.push('--server-id', a.serverId);
          if (a.configPath) cmd.push('--config-path', a.configPath);
          return await runStool(cmd);
        }
        case 'delete': return await runStool(['nginx', 'delete', need(a.id, 'id')]);
        case 'fetch': return await runStool(['nginx', 'fetch', need(a.serverId, 'serverId'), need(a.configPath, 'configPath')]);
        case 'test': return await runStool(['nginx', 'test', need(a.serverId, 'serverId'), need(a.configPath, 'configPath')]);
        case 'deploy': return await runStool(['nginx', 'deploy', need(a.serverId, 'serverId'), need(a.configPath, 'configPath'), need(a.content, 'content')]);
        case 'versions': return await runStool(['nginx', 'versions', need(a.id, 'id'), '--json']);
        default: throw new Error('未知操作: ' + a.action + '，可选: list/add/update/delete/fetch/test/deploy/versions');
      }
    }
  ));

  // ========== 10. 记账 / 周报 / 审计 ==========
  ctx.tools.register(makeTool('stool_misc',
    '记账、周报与操作审计。动作：accounting 看记账统计(stats) / target 看近N月趋势(trend) / ' +
    'weekly 列周报(list) / weeklyShow 看单条周报 / weeklySave 存周报 / audit 查操作审计记录。' +
    '审计记录了 CLI/GUI 的所有写操作(参数已脱敏)，用 actor/result 过滤可回查"刚才那次写操作成没成"。' +
    'actor 取值 cli/gui/ai/user，result 取值 success/failed/blocked。',
    {
      action: { t: 'string', d: '操作: accounting / trend / weekly / weeklyShow / weeklySave / audit', r: true },
      year: { t: 'number', d: '年份如2026，仅accounting可选' },
      months: { t: 'number', d: '统计最近N个月，仅trend可选（默认12）' },
      id: { t: 'string', d: '周报的数字ID（先 weekly 列出列表，从结果里取 id），仅weeklyShow需要' },
      title: { t: 'string', d: '周报标题，仅weeklySave需要' },
      content: { t: 'string', d: '周报内容，仅weeklySave需要' },
      startDate: { t: 'string', d: '开始日期YYYY-MM-DD，仅weeklySave可选' },
      endDate: { t: 'string', d: '结束日期YYYY-MM-DD，仅weeklySave可选' },
      actor: { t: 'string', d: '按发起方过滤 cli/gui/ai/user，仅audit可选' },
      result: { t: 'string', d: '按结果过滤 success/failed/blocked，仅audit可选' },
      limit: { t: 'number', d: '返回条数上限，audit/weekly可选（audit默认50，weekly默认10）' },
    },
    async (a) => {
      const need = (v, label) => { if (!v) throw new Error('action=' + a.action + ' 需要参数 ' + label); return v; };
      switch (a.action) {
        case 'accounting': {
          const cmd = ['accounting', 'stats', '--json'];
          if (a.year) cmd.push('--year', String(a.year));
          return await runStool(cmd);
        }
        case 'trend': {
          const cmd = ['accounting', 'trend', '--json'];
          if (a.months) cmd.push('--months', String(a.months));
          return await runStool(cmd);
        }
        case 'weekly': {
          const cmd = ['weekly', 'list', '--json'];
          if (a.limit) cmd.push('-l', String(a.limit));
          return await runStool(cmd);
        }
        case 'weeklyShow': return await runStool(['weekly', 'show', need(a.id, 'id'), '--json']);
        case 'weeklySave': {
          const cmd = ['weekly', 'save', need(a.title, 'title'), '--content', need(a.content, 'content')];
          if (a.startDate) cmd.push('--start-date', a.startDate);
          if (a.endDate) cmd.push('--end-date', a.endDate);
          return await runStool(cmd);
        }
        case 'audit': {
          const cmd = ['audit', 'list', '--json'];
          if (a.actor) cmd.push('--actor', a.actor);
          if (a.result) cmd.push('--result', a.result);
          if (a.limit) cmd.push('-l', String(a.limit));
          return await runStool(cmd);
        }
        default: throw new Error('未知操作: ' + a.action + '，可选: accounting/trend/weekly/weeklyShow/weeklySave/audit');
      }
    }
  ));

  // ========== 11. 项目管理 ==========
  ctx.tools.register(makeTool('stool_project',
    '项目管理。动作：list 列项目 / add 新增 / show 看详情 / update 改名或描述 / delete 删除 / ' +
    'stats 项目统计 / todos 列项目下的任务。' +
    '任务挂到项目用 stool_todo 的 projectId，本工具的 todos 反过来按项目ID把任务列出来。',
    {
      action: { t: 'string', d: '操作: list / add / show / update / delete / stats / todos', r: true },
      id: { t: 'string', d: '项目ID，show/update/delete/stats/todos需要' },
      name: { t: 'string', d: '项目名，add需要，update可选（改名）' },
      description: { t: 'string', d: '项目描述，add/update可选' },
    },
    async (a) => {
      const need = (v, label) => { if (!v) throw new Error('action=' + a.action + ' 需要参数 ' + label); return v; };
      switch (a.action) {
        case 'list': return await runStool(['project', 'list', '--json']);
        case 'add': {
          const cmd = ['project', 'add', need(a.name, 'name')];
          if (a.description) cmd.push('-d', a.description);
          return await runStool(cmd);
        }
        case 'show': return await runStool(['project', 'show', need(a.id, 'id'), '--json']);
        case 'update': {
          const cmd = ['project', 'update', need(a.id, 'id')];
          if (a.name) cmd.push('-n', a.name);
          if (a.description) cmd.push('--description', a.description);
          return await runStool(cmd);
        }
        case 'delete': return await runStool(['project', 'delete', need(a.id, 'id')]);
        case 'stats': return await runStool(['project', 'stats', need(a.id, 'id'), '--json']);
        case 'todos': return await runStool(['project', 'todos', need(a.id, 'id'), '--json']);
        default: throw new Error('未知操作: ' + a.action + '，可选: list/add/show/update/delete/stats/todos');
      }
    }
  ));

  // ========== 12. 子任务 ==========
  ctx.tools.register(makeTool('stool_subtask',
    '待办子任务管理（属于某个任务的细分项）。动作：list 列某任务的子任务 / add 新增 / complete 完成 / delete 删除。' +
    '父任务ID用 todoId。',
    {
      action: { t: 'string', d: '操作: list / add / complete / delete', r: true },
      todoId: { t: 'string', d: '父任务ID，list/add需要' },
      subtaskId: { t: 'string', d: '子任务ID，complete/delete需要' },
      title: { t: 'string', d: '子任务文本，仅add需要' },
      description: { t: 'string', d: '子任务描述，仅add可选' },
    },
    async (a) => {
      const need = (v, label) => { if (!v) throw new Error('action=' + a.action + ' 需要参数 ' + label); return v; };
      switch (a.action) {
        case 'list': return await runStool(['subtask', 'list', need(a.todoId, 'todoId'), '--json']);
        case 'add': {
          const cmd = ['subtask', 'add', need(a.todoId, 'todoId'), need(a.title, 'title')];
          if (a.description) cmd.push('--description', a.description);
          return await runStool(cmd);
        }
        case 'complete': return await runStool(['subtask', 'complete', need(a.subtaskId, 'subtaskId')]);
        case 'delete': return await runStool(['subtask', 'delete', need(a.subtaskId, 'subtaskId')]);
        default: throw new Error('未知操作: ' + a.action + '，可选: list/add/complete/delete');
      }
    }
  ));
}