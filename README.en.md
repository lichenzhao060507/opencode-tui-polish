[中文](README.md) | **English**

# opencode-tui-polish

A few small patches to the native OpenCode TUI. No reskin, no layout change — just two pieces of information added.

```
204.5K (20%) · $0.27 ≈¥1.83  ctrl+p commands
D:\lcz-research · 20:13-20:31
```

## The two features

### 1. Cost in CNY

Appends `≈¥1.83` directly after the built-in dollar figure.

OpenCode hard-codes its money formatting:

```js
new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
```

There is no currency setting and no hook for changing the format. The plugin does not touch that number; it injects the CNY figure at the formatting layer.

The `/cny` slash command (also in the command palette) opens a tiered breakdown: how much went to cache hits, cache misses and output; how much fell in peak versus off-peak; the session total; OpenCode's own dollar figure; and the subagent subtotal.

### 2. Turn start and end time

The status line at the bottom of the prompt card shows `· 20:13-20:31`.

- **A turn** runs from the most recent user message to the completion of the last assistant message after it;
- it does not update live — only when the turn ends;
- across midnight it renders as `11-02 20:13-11-03 21:05`.

## How the amount is computed

```
CNY = Σ(tokens in a tier × that tier's unit price) ÷ 1,000,000
```

DeepSeek bills in three tiers (cache hit / cache miss / output), each multiplied by a peak or off-peak factor; off-peak is half the peak price. So:

- off-peak: `¥ ≈ $ × 6.67`
- peak: `¥ ≈ $ × 13.33` (OpenCode converts its dollar figure via models.dev, which equals the off-peak price ÷ 6.67, so it understates peak by half)

Token totals come from the **session aggregate** `session.get(sessionID).tokens` (the full server-side running total). The message list is used only to decide whether those tokens fall in peak or off-peak and which models consumed them.

> This matters: OpenCode's message list is paginated (50 by default, 200 max). Summing messages directly understates a long session by more than half — one session measured at 157,406,720 cache-hit tokens, of which 200 messages covered only 78,060,928.

## Price table (CNY per million tokens)

Source: <https://api-docs.deepseek.com/zh-cn/quick_start/pricing> (checked 2026-11):

| Model | Tier | Cache hit | Cache miss | Output |
|---|---|---|---|---|
| deepseek-flash | off-peak | 0.02 | 1 | 4 |
| deepseek-flash | peak | 0.04 | 2 | 8 |
| deepseek-v4-pro | off-peak | 0.15 | 4.5 | 13.5 |
| deepseek-v4-pro | peak | 0.30 | 9 | 27 |

Peak is Beijing time Monday–Friday 09:00–12:00 and 14:00–18:00, excluding public holidays; everything else, including weekends, is off-peak. `reasoning` tokens are billed at the output price; DeepSeek charges nothing for cache writes, and any `cache.write` that appears is billed at the miss price (overstating rather than understating). Models with `free` in the name are not priced. The table lives in `PRICES` in `src/tui.tsx`.

## Why CNY has to patch `Intl.NumberFormat`

The built-in `$0.27` and the `ctrl+p commands` hint after it are two sibling nodes inside a **single** component (`opencode.prompt.footer`). A plugin slot can only append outside the whole component, not between the two.

So the plugin patches `Intl.NumberFormat.prototype.format`:

- only for formatters whose `resolvedOptions().currency === "USD"`;
- only appends when the amount is **exactly** some session's `cost`; other amounts pass through untouched;
- if patching fails it falls back to appending at the end of the prompt footer.

Side effect: the same amount displays the CNY suffix elsewhere too (the session sidebar, for instance), because it is the same number through the same formatter.

## Why the time is not in the per-turn summary line

`Build · DeepSeek V4.1 Flash 1017 · 3m 5s` is written **straight into terminal scrollback** by the built-in TUI during the turn.duration event (it holds its own scrollback writer), and there is no slot. Probing confirmed this: the `renderer` a plugin receives is real (`requestRender` fires thousands of times a second), but `writeToScrollback` / `renderSnapshot` / `createScrollbackSurface` / `commitRows` were called zero times — that path is closed to plugins.

So the time goes in the prompt card's status line (`prompt.footer.status`), the closest stable location.

## Install

```powershell
git clone https://github.com/<you>/opencode-tui-polish "$env:USERPROFILE\.opencode\plugins\tui-polish"
cd "$env:USERPROFILE\.opencode\plugins\tui-polish"
npm install
node build.mjs
```

Then register the absolute path in the `plugins` array of `~/.config/opencode/cli.json` (TUI-only plugins go through `cli.json`, not `opencode.jsonc`):

```json
{
  "plugins": [
    { "package": "C:\\Users\\<you>\\.opencode\\plugins\\tui-polish", "options": {} }
  ]
}
```

Restart OpenCode, or run `/reload` in the TUI. The repo ships a prebuilt `dist/tui.js`, so you can skip `npm install` and `node build.mjs` if you do not want to run babel.

## Layout

| File | Purpose |
|---|---|
| `src/tui.tsx` | All the logic (price table, settlement, inline injection, turn time, `/cny`) |
| `dist/tui.js` | `src/tui.tsx` precompiled with babel-preset-solid |
| `tui.ts` | TUI root entry, forwards to `dist/tui.js` |
| `index.ts` | Empty server entry |
| `build.mjs` | Build script |

> `index.ts` is not optional: for local-path plugins OpenCode only looks for `index.ts` / `tui.ts` in the plugin root and **does not read `package.json`'s `exports`**. Without `index.ts` the plugin is never discovered.

## Known approximations

1. Public holidays cannot be determined offline, so they count as ordinary weekdays and overstate the cost on those days; fix `isPeak()` in `src/tui.tsx` if that matters.
2. A request is classified by its start time, so requests spanning 12:00 or 18:00 count by where they began.
3. Tier ratios come from at most the 200 most recent messages; if a session spans peak and off-peak and the missing messages sit entirely in the other tier, the ratio skews.
4. Only models matching the price table are counted; other providers and free models show nothing.
5. The footer's CNY figure covers the current session only, the same scope as the built-in dollar figure; subagent spend is broken out in `/cny`.
6. The turn time runs from the last user message to the completion of the last assistant message after it; a compaction turn keeps the start of the previous real prompt.

## Development

```powershell
node build.mjs            # re-run after editing src/tui.tsx
opencode api post /api/location/reload
```

`build.mjs` looks for babel in this directory's `node_modules`, then `TUI_POLISH_BABEL_ROOT`, then the legacy `CNY_COST_BABEL_ROOT`, then the sibling `tavily-quota` plugin.

`src/tui.tsx` exports `isPeak` / `money` / `breakdown` / `priceFor` / `report` / `triple` / `installInlineFormat` / `suffixFor` / `clock` / `monthDay` / `range` / `turnRange` under `__test`, so they can be regressed against real session data in node or bun.

## License

MIT
