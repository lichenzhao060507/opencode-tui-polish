# opencode-tui-polish

给 OpenCode 原生 TUI 打的几个小补丁，不换皮肤、不换布局，只补两块信息。

```
204.5K (20%) · $0.27 ≈¥1.83  ctrl+p commands
D:\lcz-research · 20:13-20:31
```

## 两个功能

### 1. 人民币费用

把 `≈¥1.83` 直接补在内置的美元数字后面。

OpenCode 的钱数格式化是硬编码的：

```js
new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
```

没有货币配置项，也没有改格式的钩子。插件不改那个数字，只是在格式化层注入人民币。

`/cny` 斜杠命令（也在命令面板里）会弹出分档明细：缓存命中 / 缓存未命中 / 输出各花多少、
高峰与空闲各占多少、本会话合计、OpenCode 的美元数字、子代理小计。

### 2. 本轮起止时间

输入框卡片底部状态行显示 `· 20:13-20:31`。

- **本轮** = 最近一条用户消息 → 它之后最后一条助手消息完成；
- 不实时刷新，一轮结束才更新；
- 跨天显示成 `11-02 20:13-11-03 21:05`。

## 金额怎么算

```
人民币 = Σ(某档 token 数 × 该档单价) ÷ 1,000,000
```

DeepSeek 官方计费分三层（缓存命中 / 缓存未命中 / 输出），每层再乘高峰 / 空闲系数，空闲价是高峰的一半。所以：

- 空闲时段：`¥ ≈ $ × 6.67`
- 高峰时段：`¥ ≈ $ × 13.33`（OpenCode 的美元数字按 models.dev 折算，等于空闲价 ÷ 6.67，高峰期会低估一半）

token 总量取 **会话汇总值** `session.get(sessionID).tokens`（服务端完整累计），消息列表只用来判断这些 token 落在高峰还是空闲、被哪些模型消耗。

> 这一点很关键：OpenCode 的消息列表是分页的（接口默认 50 条、上限 200 条）。直接按消息累加，长会话会少算一半以上 —— 实测某会话 157,406,720 缓存命中 token，200 条消息只覆盖 78,060,928。

## 价目表（元 / 百万 tokens）

来源 <https://api-docs.deepseek.com/zh-cn/quick_start/pricing>（2026-11 核对）：

| 模型 | 档位 | 缓存命中 | 缓存未命中 | 输出 |
|---|---|---|---|---|
| deepseek-flash | 空闲 | 0.02 | 1 | 4 |
| deepseek-flash | 高峰 | 0.04 | 2 | 8 |
| deepseek-v4-pro | 空闲 | 0.15 | 4.5 | 13.5 |
| deepseek-v4-pro | 高峰 | 0.30 | 9 | 27 |

高峰 = 北京时间周一至周五 09:00–12:00、14:00–18:00（法定节假日除外），其余时段与周末为空闲价。
`reasoning` token 按输出价计；DeepSeek 不收缓存写入费，真出现 `cache.write` 时按未命中价计（宁可高估）。
名字里带 `free` 的免费模型不计价。价目表在 `src/tui.tsx` 的 `PRICES` 里。

## 为什么人民币要改写 `Intl.NumberFormat`

内置的 `$0.27` 和它后面的 `ctrl+p commands` 提示是**同一个组件**（`opencode.prompt.footer`）里的两个兄弟节点。插件的 slot 只能整块追加到它外面，插不到两者之间。

所以插件改写了 `Intl.NumberFormat.prototype.format`：

- 只对 `resolvedOptions().currency === "USD"` 的 formatter 生效；
- 只在这个金额**恰好等于**某个会话的 `cost` 时补后缀，其它金额原样返回；
- 打补丁失败会自动退回「追加到 prompt footer 末尾」的写法。

副作用：同一个金额在别处（比如会话侧栏）也会带上人民币后缀，因为那是同一个数字、同一个 formatter。

## 为什么时间不放在每轮汇总行里

`Build · DeepSeek V4.1 Flash 1017 · 3m 5s` 那行是内置 TUI 在 turn.duration 事件里**直接写进终端 scrollback** 的（它自己持有的 scrollback writer），没有 slot。实测探针：插件拿到的 `renderer` 确实是真的（`requestRender` 每秒数千次），但 `writeToScrollback` / `renderSnapshot` / `createScrollbackSurface` / `commitRows` 调用次数全是 0 —— 那条路径对插件封闭。

所以时间放在输入框卡片底部状态行（`prompt.footer.status`），这是最接近、且稳定的位置。

## 安装

```powershell
git clone https://github.com/<you>/opencode-tui-polish "$env:USERPROFILE\.opencode\plugins\tui-polish"
cd "$env:USERPROFILE\.opencode\plugins\tui-polish"
npm install
node build.mjs
```

然后在 `~/.config/opencode/cli.json` 的 `plugins` 里登记绝对路径（TUI-only 插件走 `cli.json`，不走 `opencode.jsonc`）：

```json
{
  "plugins": [
    { "package": "C:\\Users\\<you>\\.opencode\\plugins\\tui-polish", "options": {} }
  ]
}
```

重启 OpenCode，或在 TUI 里执行 `/reload`。仓库里已带编译好的 `dist/tui.js`，不想跑 babel 可以跳过 `npm install` 和 `node build.mjs`。

## 目录结构

| 文件 | 作用 |
|---|---|
| `src/tui.tsx` | 全部逻辑（价目表、结算、内联注入、本轮时间、`/cny` 命令） |
| `dist/tui.js` | `src/tui.tsx` 经 babel-preset-solid 预编译的产物 |
| `tui.ts` | TUI 根入口，转发到 `dist/tui.js` |
| `index.ts` | 空的服务端入口 |
| `build.mjs` | 构建脚本 |

> `index.ts` 不能省：OpenCode 对本地路径插件只认插件根目录的 `index.ts` / `tui.ts`，**不读 `package.json` 的 `exports`**，缺了 `index.ts` 整个插件都不会被发现。

## 已知近似

1. 法定节假日无法离线判定，按普通工作日算，节假日当天会高估；要修就改 `src/tui.tsx` 里的 `isPeak()`。
2. 单次请求按消息开始时间归档档位，跨 12:00 / 18:00 边界的请求按起点算。
3. 档位比例取自最近最多 200 条消息；会话跨了高峰与空闲、且缺失的那部分集中在另一个档位时，比例会偏。
4. 只统计能匹配到价目表的模型；其它 provider、免费模型不显示。
5. footer 的人民币只算本会话，和内置美元同一口径；子代理花费在 `/cny` 里单列。
6. 本轮时间取「最后一条用户消息 → 之后最后一条助手消息完成」，压缩（compaction）轮会沿用上一条真实提示词的起点。

## 开发

```powershell
node build.mjs            # 改完 src/tui.tsx 后重跑
opencode api post /api/location/reload
```

`build.mjs` 依次从本目录 `node_modules`、`TUI_POLISH_BABEL_ROOT`、旧变量 `CNY_COST_BABEL_ROOT`、同级的 `tavily-quota` 插件里找 babel。

`src/tui.tsx` 的 `__test` 导出了 `isPeak` / `money` / `breakdown` / `priceFor` / `report` / `triple` / `installInlineFormat` / `suffixFor` / `clock` / `monthDay` / `range` / `turnRange`，可在 node/bun 里用真实会话数据回归。

## License

MIT
