import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'dsh-stool-plugin';
export const inject = ['tools'];

async function runStool(args) {
  const subprocess = globalThis.__dsh_subprocess;
  if (!subprocess) throw new Error('subprocess service not available');
  const handle = subprocess.spawn({
    argv: ['stool', ...args],
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
  if (subprocess) globalThis.__dsh_subprocess = subprocess;

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