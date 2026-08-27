import { accessSync, constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'dsh-stool-plugin';
export const inject = ['tools'];

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
  if (!globalThis.__dsh_stool_path) {
    globalThis.__dsh_stool_path = findStoolBinary() || 'stool';
  }
  return globalThis.__dsh_stool_path;
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
        version = null;
      }
    }
    stoolProbe = { installed: !!path, path: path, version: version, checkedAt: Date.now() };
    globalThis.__dsh_stool_path = path || 'stool';
    return stoolProbe;
  })();
  stoolProbePromise = pending;
  return pending.catch(() => {}).then(() => {
    if (stoolProbePromise === pending) stoolProbePromise = null;
  }).then(() => pending);
}

async function spawnCapture(argv, graceMs, maxBytes) {
  const subprocess = globalThis.__dsh_subprocess;
  if (!subprocess) throw new Error('subprocess service not available');
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
  const subprocess = globalThis.__dsh_subprocess;
  if (!subprocess) throw new Error('subprocess service not available');
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
  // Capture subprocess for use in tool executors
  const subprocess = ctx.get('subprocess');
  if (subprocess) {
    globalThis.__dsh_subprocess = subprocess;
    // 启动即解析 stool 绝对路径，并异步预热版本缓存：
    // 设置页第一次打开就能直接拿到探测结果，探测失败也不影响工具注册。
    try {
      stoolBin();
      probeStool(true).catch(function () {});
    } catch (e) { /* ignore */ }
  }

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
    '管理服务器：列出服务器(list)、执行命令(exec)、健康检查(health)、全面诊断(diagnose)、读取文件(read)、列出目录(ls)、查看Java进程(java-ps)',
    {
      action: { t: 'string', d: '操作: list / exec / health / diagnose / read / ls / java-ps', r: true },
      serverId: { t: 'string', d: '服务器ID，action=list时可不填' },
      command: { t: 'string', d: '要执行的命令，仅exec时需要' },
      path: { t: 'string', d: '文件或目录路径，仅read/ls时需要' },
    },
    async (a) => {
      switch (a.action) {
        case 'list': return await runStool(['server', 'list', '--json']);
        case 'exec': return await runStool(['server', 'exec', a.serverId, a.command]);
        case 'health': return await runStool(['server', 'health', a.serverId, '--json']);
        case 'diagnose': return await runStool(['server', 'diagnose', a.serverId, '--json']);
        case 'read': return await runStool(['server', 'read', a.serverId, a.path]);
        case 'ls': return await runStool(['server', 'ls', a.serverId].concat(a.path ? ['--path', a.path] : []));
        case 'java-ps': return await runStool(['server', 'java-ps', a.serverId, '--json']);
        default: throw new Error('未知操作: ' + a.action + '，可选: list/exec/health/diagnose/read/ls/java-ps');
      }
    }
  ));

  // ========== 2. 数据库管理 ==========
  ctx.tools.register(makeTool('stool_db',
    '管理数据库：列出数据库(list)、执行SQL查询(query)、执行Redis命令(redis)',
    {
      action: { t: 'string', d: '操作: list / query / redis', r: true },
      dbId: { t: 'string', d: '数据库ID，action=list时可不填' },
      sql: { t: 'string', d: 'SQL语句，仅query时需要' },
      command: { t: 'string', d: 'Redis命令如 keys * / get xxx，仅redis时需要' },
    },
    async (a) => {
      switch (a.action) {
        case 'list': return await runStool(['db', 'list', '--json']);
        case 'query': return await runStool(['db', 'query', '-d', a.dbId, a.sql, '--json']);
        case 'redis': return await runStool(['db', 'redis', '-d', a.dbId].concat(a.command.split(' ')));
        default: throw new Error('未知操作: ' + a.action + '，可选: list/query/redis');
      }
    }
  ));

  // ========== 3. 日志管理 ==========
  ctx.tools.register(makeTool('stool_log',
    '管理日志：列出预设(list)、搜索日志(search)、查看尾部(tail)。支持 --days 近N天、--date 指定日期、--context 上下文行数',
    {
      action: { t: 'string', d: '操作: list / search / tail', r: true },
      presetId: { t: 'string', d: '日志预设ID，action=list时可不填' },
      keyword: { t: 'string', d: '搜索关键词，支持traceId、错误信息等，仅search时需要' },
      days: { t: 'number', d: '搜索近N天历史日志（可选）' },
      date: { t: 'string', d: '搜索指定日期，格式YYYY-MM-DD（可选）' },
      lines: { t: 'number', d: '返回行数上限（可选）' },
      context: { t: 'number', d: '匹配行上下各显示N行（可选）' },
    },
    async (a) => {
      switch (a.action) {
        case 'list': return await runStool(['log', 'list', '--json']);
        case 'search': {
          const cmd = ['log', 'search', a.presetId, a.keyword];
          if (a.days) cmd.push('--days', String(a.days));
          if (a.date) cmd.push('--date', a.date);
          if (a.lines) cmd.push('--lines', String(a.lines));
          if (a.context) cmd.push('--context', String(a.context));
          return await runStool(cmd);
        }
        case 'tail': {
          const cmd = ['log', 'tail', a.presetId];
          if (a.lines) cmd.push('--lines', String(a.lines));
          return await runStool(cmd);
        }
        default: throw new Error('未知操作: ' + a.action + '，可选: list/search/tail');
      }
    }
  ));

  // ========== 4. CI/CD 部署 ==========
  ctx.tools.register(makeTool('stool_cicd',
    '管理CI/CD部署：列出配置(list)、执行部署(deploy)、查看历史(history)。deploy可选 --stream 实时输出 / --watch 等待完成',
    {
      action: { t: 'string', d: '操作: list / deploy / history', r: true },
      configId: { t: 'string', d: '部署配置ID，action=list时可不填' },
      branch: { t: 'string', d: '部署分支（可选，覆盖默认分支），仅deploy时需要' },
      stream: { t: 'boolean', d: '是否实时流式输出，仅deploy时有效' },
      watch: { t: 'boolean', d: '是否等待部署完成，仅deploy时有效' },
      status: { t: 'string', d: '按状态筛选如 success/failed，仅history时有效' },
    },
    async (a) => {
      switch (a.action) {
        case 'list': return await runStool(['cicd', 'list', '--json']);
        case 'deploy': {
          const cmd = ['cicd', 'deploy', a.configId];
          if (a.branch) cmd.push('--branch', a.branch);
          if (a.stream) cmd.push('--stream');
          if (a.watch) cmd.push('--watch');
          return await runStool(cmd);
        }
        case 'history': {
          const cmd = ['cicd', 'history', a.configId];
          if (a.status) cmd.push('--status', a.status);
          return await runStool(cmd);
        }
        default: throw new Error('未知操作: ' + a.action + '，可选: list/deploy/history');
      }
    }
  ));

  // ========== 5. MFA 双因子认证 ==========
  ctx.tools.register(makeTool('stool_mfa',
    '管理MFA双因子认证：列出密钥(list)、生成TOTP验证码(code)',
    {
      action: { t: 'string', d: '操作: list / code', r: true },
      id: { t: 'string', d: 'MFA条目ID或序号，仅code时需要' },
    },
    async (a) => {
      switch (a.action) {
        case 'list': return await runStool(['mfa', 'list', '--json']);
        case 'code': return await runStool(['mfa', 'code', a.id]);
        default: throw new Error('未知操作: ' + a.action + '，可选: list/code');
      }
    }
  ));

  // ========== 6. Git 仓库操作 ==========
  ctx.tools.register(makeTool('stool_git',
    '管理Git仓库：查看状态(status)、提交历史(log)、本地分支(branches)、拉取(pull)、推送(push)',
    {
      action: { t: 'string', d: '操作: status / log / branches / pull / push', r: true },
      repoPath: { t: 'string', d: '仓库本地路径，如 /Users/duormi/workspace/pre-pay-service', r: true },
    },
    async (a) => {
      const actions = ['status', 'log', 'branches', 'pull', 'push'];
      if (actions.indexOf(a.action) === -1) throw new Error('未知操作，可选: ' + actions.join('/'));
      const cmd = ['git', a.action, '--path', a.repoPath];
      if (a.action === 'status') cmd.push('--json');
      return await runStool(cmd);
    }
  ));

  // ========== 7. 笔记管理 ==========
  ctx.tools.register(makeTool('stool_note',
    '管理笔记：列出(list)、添加(add)、搜索(search)',
    {
      action: { t: 'string', d: '操作: list / add / search', r: true },
      title: { t: 'string', d: '笔记标题，仅add时需要' },
      content: { t: 'string', d: '笔记内容，仅add时可选' },
      group: { t: 'string', d: '笔记分组，仅add时可选' },
      keyword: { t: 'string', d: '搜索关键词，仅search时需要' },
    },
    async (a) => {
      switch (a.action) {
        case 'list': return await runStool(['note', 'list', '--json']);
        case 'add': {
          const cmd = ['note', 'add', a.title];
          if (a.content) cmd.push('--content', a.content);
          if (a.group) cmd.push('--group', a.group);
          return await runStool(cmd);
        }
        case 'search': return await runStool(['note', 'search', a.keyword, '--json']);
        default: throw new Error('未知操作，可选: list/add/search');
      }
    }
  ));

  // ========== 8. 待办任务 ==========
  ctx.tools.register(makeTool('stool_todo',
    '管理待办任务：列出(list)、添加(add)、完成(complete)、统计(stats)',
    {
      action: { t: 'string', d: '操作: list / add / complete / stats', r: true },
      title: { t: 'string', d: '任务标题，仅add时需要' },
      priority: { t: 'string', d: '优先级 high/medium/low，仅add时可选' },
      deadline: { t: 'string', d: '截止日期YYYY-MM-DD，仅add时可选' },
      tags: { t: 'string', d: '标签逗号分隔，仅add时可选' },
      id: { t: 'string', d: '任务ID，仅complete时需要' },
      limit: { t: 'number', d: '返回条数上限，仅list时可选' },
    },
    async (a) => {
      switch (a.action) {
        case 'list': {
          const cmd = ['todo', 'list', '--json'];
          if (a.limit) cmd.push('--limit', String(a.limit));
          return await runStool(cmd);
        }
        case 'add': {
          const cmd = ['todo', 'add', a.title];
          if (a.priority) cmd.push('--priority', a.priority);
          if (a.deadline) cmd.push('--deadline', a.deadline);
          if (a.tags) cmd.push('--tags', a.tags);
          return await runStool(cmd);
        }
        case 'complete': return await runStool(['todo', 'complete', a.id]);
        case 'stats': return await runStool(['todo', 'stats', '--json']);
        default: throw new Error('未知操作，可选: list/add/complete/stats');
      }
    }
  ));

  // ========== 9. 其他工具 ==========
  ctx.tools.register(makeTool('stool_misc',
    '其他工具箱：记账统计(accounting)、周报(weekly)、审计(audit)、项目管理(project)、Nginx预设(nginx)',
    {
      action: { t: 'string', d: '操作: accounting / weekly / audit / project / nginx', r: true },
      title: { t: 'string', d: '周报标题，仅weekly save时需要' },
      content: { t: 'string', d: '周报内容，仅weekly save时需要' },
      actor: { t: 'string', d: '操作者筛选 ai/user，仅audit时可选' },
      result: { t: 'string', d: '结果筛选 success/failed，仅audit时可选' },
    },
    async (a) => {
      switch (a.action) {
        case 'accounting': return await runStool(['accounting', 'stats', '--json']);
        case 'weekly': return await runStool(['weekly', 'list', '--json']);
        case 'audit': {
          const cmd = ['audit', 'list', '--json'];
          if (a.actor) cmd.push('--actor', a.actor);
          if (a.result) cmd.push('--result', a.result);
          return await runStool(cmd);
        }
        case 'project': return await runStool(['project', 'list', '--json']);
        case 'nginx': return await runStool(['nginx', 'list', '--json']);
        default: throw new Error('未知操作，可选: accounting/weekly/audit/project/nginx');
      }
    }
  ));
}