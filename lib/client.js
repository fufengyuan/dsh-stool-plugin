// dsh-stool-plugin client bundle
window.__ModuleLoader__.load({
  id: 'dsh-stool-plugin',
  factory: function(require) {
    var React = require('react');
    var h = React.createElement;

    var STATUS_URL = '/stool/status';
    var REPO_URL = 'https://github.com/fufengyuan/supertool';

    var TOOLS = [
      { name: 'stool_server', icon: '🖥️', desc: '服务器管理', actions: 'list / exec / health / diagnose / read / ls / java-ps' },
      { name: 'stool_db', icon: '📄', desc: '数据库管理', actions: 'list / query / redis' },
      { name: 'stool_log', icon: '📋', desc: '日志管理', actions: 'list / search / tail' },
      { name: 'stool_cicd', icon: '🚀', desc: 'CI/CD 部署', actions: 'list / deploy / history' },
      { name: 'stool_mfa', icon: '🔐', desc: 'MFA 认证', actions: 'list / code' },
      { name: 'stool_git', icon: '📦', desc: 'Git 仓库', actions: 'status / log / branches / pull / push' },
      { name: 'stool_note', icon: '📝', desc: '笔记管理', actions: 'list / add / search' },
      { name: 'stool_todo', icon: '✅', desc: '待办任务', actions: 'list / add / complete / stats' },
      { name: 'stool_misc', icon: '🔧', desc: '其他工具', actions: 'accounting / weekly / audit / project / nginx' }
    ];

    // 探测状态只有四种：检测中 / 已安装 / 确认没装 / 拿不到结果。
    // 最后一种必须和「没装」区分开——接口不通时不该断言用户没装 stool，
    // 但仍然保留下载引导，避免页面变成一句没有出口的报错。
    function statusKind(status) {
      if (!status) return 'checking';
      return status.kind;
    }

    var STATUS_TEXT = {
      checking: { label: '检测中…', color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))' },
      installed: { label: 'stool 已安装', color: 'var(--dsw-alias-state-success-primary, #2E7D32)' },
      missing: { label: '未检测到 stool', color: 'var(--dsw-alias-state-warn-primary, #ED6C02)' },
      unknown: { label: '状态未知', color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))' }
    };

    // 折叠箭头：与 dsh 内置插件卡片同一形状，靠 transform 旋转，不引入图标包。
    function chevron(open) {
      return h('svg', {
        width: 16,
        height: 16,
        viewBox: '0 0 16 16',
        'aria-hidden': 'true',
        style: {
          color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
          flex: 'none',
          transition: 'transform .16s',
          transform: open ? 'rotate(180deg)' : 'none'
        }
      }, h('path', {
        d: 'M4 6l4 4 4-4',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round'
      }));
    }

    // 头部右侧状态角标：卡片折叠着也能看到本机有没有 stool，不必先展开再等请求。
    function statusChip(kind) {
      var text = STATUS_TEXT[kind] || STATUS_TEXT.unknown;
      return h('span', {
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          flex: 'none',
          fontSize: 12,
          lineHeight: 1,
          color: text.color,
          padding: '5px 10px',
          borderRadius: 999,
          border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
          background: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.05))',
          whiteSpace: 'nowrap'
        }
      },
        h('span', {
          'aria-hidden': 'true',
          style: { width: 6, height: 6, borderRadius: '50%', background: text.color, flex: 'none' }
        }),
        h('span', null, text.label)
      );
    }

    function ghostButton(label, onClick, disabled) {
      return h('button', {
        type: 'button',
        onClick: onClick,
        disabled: disabled,
        style: {
          appearance: 'none',
          font: 'inherit',
          fontSize: 12,
          cursor: disabled ? 'default' : 'pointer',
          color: disabled ? 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))' : 'var(--dsw-alias-label-primary, inherit)',
          background: 'none',
          border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
          borderRadius: 6,
          padding: '4px 10px',
          opacity: disabled ? 0.6 : 1
        }
      }, label);
    }

    var BANNER_STYLE = {
      marginBottom: 16,
      padding: '12px 14px',
      borderRadius: 8,
      background: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.05))',
      border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))'
    };

    var MUTED = { margin: '4px 0 0 0', fontSize: 13, color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))', lineHeight: 1.5 };

    function bannerTitle(icon, label, color) {
      return h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 } },
        h('span', { style: { fontSize: 18, color: color } }, icon),
        h('span', { style: { fontWeight: 600, fontSize: 14 } }, label)
      );
    }

    // 检测结果横幅：已安装只报路径与版本，没装（或确认不了）才给仓库链接。
    function statusBanner(status, loading, onRetry) {
      var kind = statusKind(status);
      if (kind === 'checking') {
        return h('div', { style: BANNER_STYLE },
          bannerTitle('⏳', '正在检测本机 stool…'),
          h('p', { style: MUTED }, '向 dsh 进程查询 stool 命令是否可用。'),
          h('div', { style: { marginTop: 8 } }, ghostButton('重新检测', onRetry, true))
        );
      }
      if (kind === 'installed') {
        return h('div', { style: BANNER_STYLE },
          bannerTitle('✅', '已检测到 stool', 'var(--dsw-alias-state-success-primary, #2E7D32)'),
          status.path
            ? h('div', { style: { marginTop: 4, fontSize: 12, fontFamily: 'monospace', color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))', wordBreak: 'break-all' } },
                status.path + (status.version ? '  ·  ' + status.version : ''))
            : null,
          h('p', { style: MUTED }, status.version ? '工具调用会直接使用该路径，无需额外配置。' : '已找到可执行文件，但没能取到版本号；命令若无法运行，请确认它可执行。'),
          h('div', { style: { marginTop: 8 } }, ghostButton(loading ? '检测中…' : '重新检测', onRetry, loading))
        );
      }
      if (kind === 'missing') {
        return h('div', { style: BANNER_STYLE },
          bannerTitle('⬇️', '还没有安装 stool', 'var(--dsw-alias-state-warn-primary, #ED6C02)'),
          h('p', { style: MUTED }, '下载安装 SuperTool 即可获得 stool CLI，含可视化配置界面。下载后安装程序会自动配置：'),
          h('a', { href: REPO_URL, target: '_blank', rel: 'noreferrer', style: { display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 6, fontSize: 13, color: 'var(--dsw-alias-label-link, #1976D2)', fontWeight: 500, textDecoration: 'none' } },
            REPO_URL,
            h('span', { style: { fontSize: 12 } }, '↗️')
          ),
          h('div', { style: { marginTop: 10, display: 'flex', alignItems: 'center', gap: 8 } },
            ghostButton(loading ? '检测中…' : '安装好了，重新检测', onRetry, loading),
            h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))' } }, '装完无需重启 dsh')
          )
        );
      }
      // unknown：接口不可用 / 非回环访问 / Host 未注册路由，断不了言，保守保留下载引导。
      return h('div', { style: BANNER_STYLE },
        bannerTitle('❔', '暂时无法确认 stool 状态', 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))'),
        h('p', { style: MUTED }, '没有从本机 dsh 进程取到检测结果（可能是 Host 侧状态接口不可用）。若尚未安装，可下载 SuperTool：'),
        h('a', { href: REPO_URL, target: '_blank', rel: 'noreferrer', style: { display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 6, fontSize: 13, color: 'var(--dsw-alias-label-link, #1976D2)', fontWeight: 500, textDecoration: 'none' } },
          REPO_URL,
          h('span', { style: { fontSize: 12 } }, '↗️')
        ),
        h('div', { style: { marginTop: 10 } }, ghostButton(loading ? '检测中…' : '重新检测', onRetry, loading))
      );
    }

    // 展开后的正文：检测结果横幅 + 工具清单。
    function StoolBody(props) {
      var status = props.status;
      var kind = statusKind(status);
      return h('div', { style: { padding: '0 16px 8px' } },
        statusBanner(status, props.loading, props.onRetry),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          TOOLS.map(function (t) {
            return h('div', {
              key: t.name,
              style: {
                padding: '10px 12px',
                borderRadius: 8,
                background: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.05))',
                border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.25))'
              }
            },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 } },
                h('span', { style: { fontSize: 18 } }, t.icon),
                h('span', { style: { fontWeight: 600, fontSize: 14 } }, t.name),
                h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))', marginLeft: 'auto' } }, t.desc)
              ),
              h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))', fontFamily: 'monospace' } }, t.actions)
            );
          }),
          h('div', { style: { marginTop: 12, fontSize: 12, color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))', textAlign: 'center' } },
            kind === 'installed'
              ? '共 ' + TOOLS.length + ' 个工具，无需配置即可使用；进程重启后仍有效'
              : '共 ' + TOOLS.length + ' 个工具；未检测到 stool 时调用会返回安装指引'
          )
        )
      );
    }

    // 设置页卡片：默认折叠，点头部展开。插件没有可编辑配置项，
    // 这张卡片做能力说明 + 本机 stool 检测，折叠可避免插件页被长清单占满。
    function StoolPage() {
      var openState = React.useState(false);
      var open = openState[0];
      var statusState = React.useState(null);   // null = 检测中
      var status = statusState[0];
      var loadingState = React.useState(false);
      var loading = loadingState[0];

      // gen 让迟到的响应作废：快速切走再回来时，旧请求不能覆盖新结果。
      var genRef = React.useRef(0);

      var load = React.useCallback(function (force) {
        var id = ++genRef.current;
        loadingState[1](true);
        fetch(STATUS_URL + (force ? '?refresh=1' : ''), { cache: 'no-store' })
          .then(function (res) {
            return res.json()
              .catch(function () { return null; })
              .then(function (body) { return { ok: res.ok, body: body }; });
          })
          .then(function (res) {
            if (id !== genRef.current) return;
            var body = res.body;
            if (res.ok && body && typeof body === 'object' && typeof body.installed === 'boolean') {
              statusState[1](body.installed
                ? { kind: 'installed', path: body.path || null, version: body.version || null }
                : { kind: 'missing' });
            } else {
              statusState[1]({ kind: 'unknown' });
            }
          })
          .catch(function () {
            if (id !== genRef.current) return;
            statusState[1]({ kind: 'unknown' });
          })
          .then(function () {
            if (id === genRef.current) loadingState[1](false);
          });
      }, []);

      React.useEffect(function () { load(false); }, [load]);

      // 每次展开都强制重新探测：用户刚装完 stool，收起再展开就能看到最新状态。
      React.useEffect(function () {
        if (open) load(true);
      }, [open]);

      var kind = statusKind(status);

      return h('div', {
        style: {
          border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
          background: open
            ? 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.10))'
            : 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.05))',
          borderRadius: '12px',
          transition: 'border-color .16s, background .16s'
        }
      },
        h('button', {
          type: 'button',
          'aria-expanded': open,
          'aria-label': (open ? '收起设置' : '展开设置') + ': Stool 运维工具箱',
          onClick: function () { openState[1](!open); },
          style: {
            appearance: 'none',
            width: '100%',
            font: 'inherit',
            color: 'inherit',
            textAlign: 'left',
            cursor: 'pointer',
            background: 'none',
            border: 0,
            borderRadius: '12px',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            padding: '14px 16px'
          }
        },
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { style: { fontSize: '14px', fontWeight: 600 } }, '🧰 Stool 运维工具箱'),
            h('div', {
              style: {
                color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
                fontSize: '13px',
                lineHeight: 1.5
              }
            }, '通过 ' + TOOLS.length + ' 个合并工具覆盖 stool 全部能力，Agent 可自动发现并调用。')
          ),
          statusChip(kind),
          chevron(open)
        ),
        open ? h(StoolBody, { status: status, loading: loading, onRetry: function () { load(true); } }) : null
      );
    }

    function apply(ctx) {
      // 用 slots 在设置面板注册卡片（参考 modlens 的 settings.plugin.item 写法）。
      // key 是必需的：该 slot 按 Host 已注册的 settings 命名空间派发，
      // 没有 key 的卡片会被 ConfigurablePluginsTabController 直接过滤掉。
      if (typeof ctx.inject === 'function') {
        ctx.inject(['slots'], (scope) => {
          scope.slots.inject('settings.plugin.item', function* () {
            yield scope.slots.register({ name: 'settings.plugin.item', id: 'stool', key: 'stool', order: 50 }, StoolPage);
          });
        });
      }
    }

    return { apply: apply, inject: ['slots'] };
  }
});
