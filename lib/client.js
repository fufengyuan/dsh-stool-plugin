// dsh-stool-plugin client bundle
window.__ModuleLoader__.load({
  id: 'dsh-stool-plugin',
  factory: function(require) {
    var React = require('react');
    var h = React.createElement;

function StoolPage() {
    var tools = [
      { name: 'stool_server', icon: '\uD83D\uDDA5\uFE0F', desc: '\u670D\u52A1\u5668\u7BA1\u7406', actions: 'list / exec / health / diagnose / read / ls / java-ps' },
      { name: 'stool_db', icon: '\uD83D\uDCC4', desc: '\u6570\u636E\u5E93\u7BA1\u7406', actions: 'list / query / redis' },
      { name: 'stool_log', icon: '\uD83D\uDCCB', desc: '\u65E5\u5FD7\u7BA1\u7406', actions: 'list / search / tail' },
      { name: 'stool_cicd', icon: '\uD83D\uDE80', desc: 'CI/CD \u90E8\u7F72', actions: 'list / deploy / history' },
      { name: 'stool_mfa', icon: '\uD83D\uDD10', desc: 'MFA \u8BA4\u8BC1', actions: 'list / code' },
      { name: 'stool_git', icon: '\uD83D\uDCE6', desc: 'Git \u4ED3\u5E93', actions: 'status / log / branches / pull / push' },
      { name: 'stool_note', icon: '\uD83D\uDCDD', desc: '\u7B14\u8BB0\u7BA1\u7406', actions: 'list / add / search' },
      { name: 'stool_todo', icon: '\u2705', desc: '\u5F85\u529E\u4EFB\u52A1', actions: 'list / add / complete / stats' },
      { name: 'stool_misc', icon: '\uD83D\uDD27', desc: '\u5176\u4ED6\u5DE5\u5177', actions: 'accounting / weekly / audit / project / nginx' }
    ];

    return h('div', { style: { padding: '0 4px' } },
      // 下载引导横幅
      h('div', { style: { marginBottom: 16, padding: '12px 14px', borderRadius: 8, background: 'var(--surface-accent, #E8F5E9)', border: '1px solid var(--border-accent, #A5D6A7)' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 } },
          h('span', { style: { fontSize: 18 } }, '\u2B07\uFE0F'),
          h('span', { style: { fontWeight: 600, fontSize: 14 } }, '\u8FD8\u6CA1\u6709 stool \uFF1F')
        ),
        h('p', { style: { margin: '4px 0 0 0', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 } },
          '\u4E0B\u8F7D\u5B89\u88C5 supertool \u5373\u53EF\u83B7\u5F97 stool CLI\uFF0C\u542B\u53EF\u89C6\u5316\u914D\u7F6E\u754C\u9762\u3002\u4E0B\u8F7D\u540E\u5B89\u88C5\u7A0B\u5E8F\u4F1A\u81EA\u52A8\u914D\u7F6E\uFF1A'
        ),
        h('a', { href: 'https://github.com/fufengyuan/supertool', target: '_blank', style: { display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 6, fontSize: 13, color: 'var(--link, #1976D2)', fontWeight: 500, textDecoration: 'none' } },
          'https://github.com/fufengyuan/supertool',
          h('span', { style: { fontSize: 12 } }, '\u2197\uFE0F')
        )
      ),
      h('h3', { style: { margin: '0 0 8px 0', fontSize: 16, fontWeight: 600 } }, '\uD83E\uDDF0 Stool \u8FD0\u7EF4\u5DE5\u5177\u7BB1'),
      h('p', { style: { margin: '0 0 16px 0', fontSize: 13, color: 'var(--text-secondary)' } },
        '\u901A\u8FC7 9 \u4E2A\u5408\u5E76\u5DE5\u5177\u8986\u76D6 stool \u5168\u90E8\u80FD\u529B\uFF0CAgent \u53EF\u81EA\u52A8\u53D1\u73B0\u5E76\u8C03\u7528\uFF0C\u65E0\u9700\u624B\u52A8\u64CD\u4F5C\u3002'
      ),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        tools.map(function (t) {
          return h('div', {
            key: t.name,
            style: {
              padding: '10px 12px',
              borderRadius: 8,
              background: 'var(--surface-secondary)',
              border: '1px solid var(--border)'
            }
          },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 } },
              h('span', { style: { fontSize: 18 } }, t.icon),
              h('span', { style: { fontWeight: 600, fontSize: 14 } }, t.name),
              h('span', { style: { fontSize: 12, color: 'var(--text-muted)', marginLeft: 'auto' } }, t.desc)
            ),
            h('div', { style: { fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'monospace' } }, t.actions)
          );
        }),
        h('div', { style: { marginTop: 12, fontSize: 12, color: 'var(--text-muted)', textAlign: 'center' } },
          '\u5DF2\u5B89\u88C5\uFF0C\u8FDB\u7A0B\u91CD\u542F\u540E\u4ECD\u6709\u6548'
        )
      )
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