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

| 工具 | 操作 | 说明 |
|------|------|------|
| `stool_server` | list / exec / health / diagnose / read / ls / java-ps | 服务器管理 |
| `stool_db` | list / query / redis | 数据库管理 |
| `stool_log` | list / search / tail | 日志搜索与查看 |
| `stool_cicd` | list / deploy / history | CI/CD 部署管理 |
| `stool_mfa` | list / code | 双因子认证码 |
| `stool_git` | status / log / branches / pull / push | Git 仓库操作 |
| `stool_note` | list / add / search | 笔记管理 |
| `stool_todo` | list / add / complete / stats | 待办任务 |
| `stool_misc` | accounting / weekly / audit / project / nginx | 其他工具 |

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
│   ├── index.js          # Host 端：9 个工具注册 + stool 探测接口 /stool/status
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