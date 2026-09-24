# dsh-stool-plugin

DSH 运维工具箱插件。将 stool 运维 CLI 的全部能力注册为 DSH 模型可调用的工具，无需手动操作即可让 Agent 自动执行服务器管理、日志搜索、数据库查询、CI/CD 部署等操作。

## 安装

```bash
dsh plugin --profile web add github:fufengyuan/dsh-stool-plugin

然后重启 dsh web：

```bash
launchctl kickstart -k gui/501/com.duormi.dsh-web
```

## 提供的工具

12 个工具覆盖 stool CLI v7.x 的全部命令面（`stool <模块> --help` 为准）：

| 工具 | action | 说明 |
|------|--------|------|
| `stool_server` | list / test / exec / exec-batch / health / diagnose / read / ls / download / upload / mkdir / rm / java-ps / java-restart | 服务器管理。exec-batch 按行批量执行脚本；upload 需同时给 path(本地) 与 remotePath(远程目标)；java-restart 只停不拉起 |
| `stool_db` | list / query / databases / tables / structure / data / redis | 数据库与 Redis。query 走 -d <dbId>，写操作在审批连接上被拦；redis 用 redisCommand 指定子命令（keys/get/set/type/ttl/h-*/l-*/s-* 共 13 个） |
| `stool_log` | list / search / tail / context / add / delete | 日志查询。翻历史必须给 date 或 days（互斥）；context 按行号看上下文 |
| `stool_cicd` | list / status / deploy / history / step-logs / rollback / cancel / modules / logs / tools | CI/CD。deploy 支持 stream/watch/branch；tools 检测构建工具与 SDK 版本 |
| `stool_mfa` | list / code / codes / add / delete / parse-uri | 双因子认证码。codes 批量取全部验证码 |
| `stool_git` | list / status / log / branches / pull / push / commit / checkout | Git 仓库操作 |
| `stool_todo` | list / add / complete / uncomplete / delete / show / edit / search / stats / clear | 待办任务。截止日期是 due，标签是 tag（单数） |
| `stool_note` | list / add / update / delete / groups / add-group / update-group / delete-group | 笔记管理。没有独立 search 子命令，用 list + keyword；分组用 groupId |
| `stool_project` | list / add / show / update / delete / stats / todos | 项目管理 |
| `stool_subtask` | list / add / complete / delete | 待办子任务 |
| `stool_nginx` | list / add / update / delete / fetch / test / deploy / versions | Nginx 配置预设与部署 |
| `stool_misc` | accounting / trend / weekly / weeklyShow / weeklySave / audit | 记账统计、周报、操作审计 |

### 参数名与 CLI 的对应关系

工具层做了参数归一（`serverId`/`command`/`script`…），落到 CLI 时按各子命令的真实 flag 拼装。几个容易踩的点：

- `stool_todo`：add 用 `-d/--due` + `-t/--tag`；但 edit 里 `-t` 是 `--text`，标签必须用 `-g/--tag`。
- `stool_log`：search/tail 的行数 flag 是 `-l`，没有 `--context` 这个参数（上下文要用 context 动作按行号查）。
- `stool_db redis`：不接受 `--json`，且子命令必须白名单化（早期版本直接把整串命令按空格拆开传，会撞 clap 报 exit 2）。
- `stool_server upload`：需要 `<ID> <LOCAL> <REMOTE>` 三个位置参数。

## 设置页

设置 → 插件 → **🧰 Stool 运维工具箱** 卡片会自动检测本机是否已安装 stool：

- 已安装：显示可执行文件路径与 `stool version` 版本号，不再展示下载引导；
- 未安装：显示 SuperTool 仓库链接与下载说明；
- 取不到结果（接口不可用等）：标记为「状态未知」并保守保留下载引导。

检测由 Host 侧完成（浏览器不能起进程），卡片通过只读接口 `GET /stool/status` 获取结果：仅应答同源回环请求，返回 `{ installed, path, version, checkedAt }`，结果缓存 30 秒，`?refresh=1` 强制重新探测。卡片折叠时头部也有状态角标，收起再展开即触发一次重新检测。

## 目录结构

```
dsh-stool-plugin/
├── package.json          # 包配置
├── cordis.patch.yml      # Cordis 插件注册行
├── .gitignore
├── README.md
├── lib/
│   ├── index.js          # Host 端：12 个工具注册 + stool 探测接口 /stool/status
│   └── client.js         # Client 端：设置页面卡片（自动检测 stool）
└── node_modules/
    └── @deepseek-ai/
        └── dsh-tools     # peerDependency 符号链接
```

## 依赖

- `@deepseek-ai/cordis` ^4.0.1（peer）
- `@deepseek-ai/dsh-tools` ^0.1.0-rc.6（peer）
- `stool` CLI（需在宿主机上安装；除 PATH 外还会扫 `/usr/local/bin`、`/opt/homebrew/bin`、`~/.local/bin` 等常见目录，因为 launchd 拉起的 dsh web 进程 PATH 往往不全）

## 从源码构建

```bash
cd ~/.dsh/plugin-src/dsh-stool-plugin
npm install                 # 安装 peerDependencies
# 或
ln -sf /path/to/dsh-tools  node_modules/@deepseek-ai/dsh-tools
```

## License

MIT