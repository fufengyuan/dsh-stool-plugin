# dsh-stool-plugin

DSH 运维工具箱插件。将 [stool](https://github.com/duormi/stool) 运维 CLI 的全部能力注册为 DSH 模型可调用的工具，无需手动操作即可让 Agent 自动执行服务器管理、日志搜索、数据库查询、CI/CD 部署等操作。

## 安装

```bash
dsh plugin --profile web add github:duormi/dsh-stool-plugin
```

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

## 目录结构

```
dsh-stool-plugin/
├── package.json          # 包配置
├── cordis.patch.yml      # Cordis 插件注册行
├── .gitignore
├── README.md
├── lib/
│   ├── index.js          # Host 端：9 个工具注册
│   └── client.js         # Client 端：设置页面 UI
└── node_modules/
    └── @deepseek-ai/
        └── dsh-tools     # peerDependency 符号链接
```

## 依赖

- `@deepseek-ai/cordis` ^4.0.1（peer）
- `@deepseek-ai/dsh-tools` ^0.1.0-rc.6（peer）
- `stool` CLI（需在宿主机上安装，`stool` 命令在 PATH 中）

## 从源码构建

```bash
cd ~/.dsh/plugin-src/dsh-stool-plugin
npm install                 # 安装 peerDependencies
# 或
ln -sf /path/to/dsh-tools  node_modules/@deepseek-ai/dsh-tools
```

## License

MIT