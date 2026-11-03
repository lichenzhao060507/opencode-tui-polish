import { createComponent as _$createComponent } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui";

/**
 * opencode-tui-polish —— 给 OpenCode 原生 TUI 打的两个小补丁
 *
 * 1. 人民币费用：在 footer 的美元数字后面补 `≈¥0.27`
 *    OpenCode 的钱数格式化是硬编码的
 *    `Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })`，
 *    没有货币配置项，也没有改格式的钩子，只能在格式化层注入。
 *
 * 2. 本轮起止时间：在输入框卡片底部状态行显示 `· 20:13-20:31`
 *    「本轮」= 最近一条用户消息 → 它之后最后一条助手消息完成。
 *
 * 为什么不直接把美元乘汇率：DeepSeek 官方计费分档（缓存命中 / 未命中 / 输出，
 * 再乘高峰 / 空闲系数），models.dev 给 deepseek-flash 的美元价约等于「空闲价 ÷ 6.67」。
 * 高峰期实际支出是美元数字的 2 倍，乘固定汇率会低估。
 *
 * 价目来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 *   金额单位：人民币元 / 百万 tokens；空闲价 = 高峰价的一半。
 *
 * 金额怎么算：
 *   OpenCode 的 message 列表是分页的（单页最多 200 条），长会话只能看到最后一段，
 *   直接按消息累加会漏掉一半以上（实测 157M 缓存命中只统计到 78M）。
 *   所以 token 总量一律取会话汇总值 `session.get().tokens`（服务端完整累计）；
 *   消息列表只用来判断这些 token 落在高峰还是空闲、以及被哪些模型消耗。
 *
 * 已知近似：
 *   1. 法定节假日无法离线判定，按普通工作日计算（会高估）；
 *   2. 单次请求按消息开始时间归档档位，跨时段边界的请求按起点计；
 *   3. 只对能匹配到价目表的模型计价（deepseek-flash / deepseek-v4-pro），
 *      免费通道和其它提供商不显示。
 */

const PLUGIN_ID = "tui-polish";
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ *
 * 时间工具
 * ------------------------------------------------------------------ */

const pad = value => String(value).padStart(2, "0");
function beijing(ms) {
  return new Date(ms + BEIJING_OFFSET_MS);
}
function clock(ms) {
  const date = beijing(ms);
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}
function monthDay(ms) {
  const date = beijing(ms);
  return `${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}
function sameDay(left, right) {
  return beijing(left).toISOString().slice(0, 10) === beijing(right).toISOString().slice(0, 10);
}

/** `20:13-20:31`，跨天则是 `11-02 20:13-11-03 21:05`。 */
function range(start, end) {
  if (!Number.isFinite(start) || start <= 0) return "";
  const finish = Number.isFinite(end) && end > start ? end : start;
  if (sameDay(start, finish)) return `${clock(start)}-${clock(finish)}`;
  return `${monthDay(start)} ${clock(start)}-${monthDay(finish)} ${clock(finish)}`;
}

/* ------------------------------------------------------------------ *
 * 人民币费用
 * ------------------------------------------------------------------ */

const PRICES = [{
  match: /pro/i,
  name: "deepseek-v4-pro",
  off: {
    hit: 0.15,
    miss: 4.5,
    out: 13.5
  },
  peak: {
    hit: 0.3,
    miss: 9,
    out: 27
  }
}, {
  match: /flash/i,
  name: "deepseek-flash",
  off: {
    hit: 0.02,
    miss: 1,
    out: 4
  },
  peak: {
    hit: 0.04,
    miss: 2,
    out: 8
  }
}];

/**
 * 免费通道（opencode/deepseek-v4.1-flash-free）名字里也带 flash，
 * 必须排在价目匹配之前排除，否则会把免费调用算成钱。
 */
function priceFor(modelID) {
  if (!modelID) return undefined;
  if (/free/i.test(modelID)) return undefined;
  return PRICES.find(entry => entry.match.test(modelID));
}

/**
 * 高峰时段：北京时间周一至周五 09:00-12:00、14:00-18:00。
 * 周末与其余时段均为空闲，空闲价是高峰价的一半。
 */
function isPeak(timestampMs) {
  const date = new Date(timestampMs + BEIJING_OFFSET_MS);
  const day = date.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = date.getUTCHours() + date.getUTCMinutes() / 60;
  return hour >= 9 && hour < 12 || hour >= 14 && hour < 18;
}
function count(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}
const emptyTokens = () => ({
  hit: 0,
  miss: 0,
  out: 0
});
function addInto(target, source) {
  target.hit += source.hit;
  target.miss += source.miss;
  target.out += source.out;
}
function tokenSum(tokens) {
  return tokens.hit + tokens.miss + tokens.out;
}

/**
 * tokens.input 不含缓存命中部分，缓存命中单列在 tokens.cache.read。
 * DeepSeek 不收缓存写入费，真出现 write 时按未命中价计，宁可高估。
 * reasoning token 按输出价计。
 */
function triple(tokens) {
  return {
    hit: count(tokens?.cache?.read),
    miss: count(tokens?.input) + count(tokens?.cache?.write),
    out: count(tokens?.output) + count(tokens?.reasoning)
  };
}
/** 把当前能看到的（最多 200 条）消息归类，用于判断档位与模型占比。 */
function scan(context, sessionID) {
  const result = {
    all: emptyTokens(),
    deep: emptyTokens(),
    peak: emptyTokens(),
    models: new Map(),
    latest: 0
  };
  const messages = context.data.session.message.list(sessionID) ?? [];
  for (const message of messages) {
    const tokens = message?.tokens;
    if (!tokens) continue;
    const values = triple(tokens);
    addInto(result.all, values);
    const created = Number(message?.time?.created ?? 0);
    if (created > result.latest) result.latest = created;
    const modelID = message?.model?.id ?? message?.model?.modelID ?? "";
    const price = priceFor(modelID);
    if (!price) continue;
    addInto(result.deep, values);
    if (isPeak(created || Date.now())) addInto(result.peak, values);
    const bucket = result.models.get(price.name) ?? emptyTokens();
    addInto(bucket, values);
    result.models.set(price.name, bucket);
  }
  return result;
}
/**
 * 人民币金额 = Σ(某档 token 数 × 该档单价)。
 * token 总量取会话汇总值，档位比例与模型占比取自消息样本，
 * 因此长会话不会因为消息分页而少算。
 */
function breakdown(context, sessionID) {
  const info = context.data.session.get(sessionID);
  const sample = scan(context, sessionID);
  const aggregate = triple(info?.tokens);

  // 会话汇总值是服务端完整累计，正常都比样本大；样本更大时说明汇总还没追上。
  const base = tokenSum(aggregate) >= tokenSum(sample.all) ? aggregate : sample.all;
  const fallbackTime = Number(info?.time?.updated ?? info?.time?.created ?? 0) || sample.latest || Date.now();
  const messagesSeen = tokenSum(sample.all) > 0;

  // 每个类别里 DeepSeek 计费通道占多少（样本全是 deepseek 时就是 1）。
  const share = key => {
    if (!messagesSeen) {
      const price = priceFor(info?.model?.id ?? info?.model?.modelID ?? "");
      return price ? 1 : 0;
    }
    if (sample.all[key] === 0) return 0;
    return Math.min(1, sample.deep[key] / sample.all[key]);
  };

  // 每个类别里高峰时段占多少。
  const peakShare = key => {
    if (sample.deep[key] > 0) return Math.min(1, sample.peak[key] / sample.deep[key]);
    return isPeak(fallbackTime) ? 1 : 0;
  };
  const names = Array.from(sample.models.keys());
  if (names.length === 0) {
    const price = priceFor(info?.model?.id ?? info?.model?.modelID ?? "");
    if (price) names.push(price.name);
  }
  const buckets = [];
  let total = 0;
  for (const name of names) {
    const price = PRICES.find(entry => entry.name === name);
    if (!price) continue;
    const modelSample = sample.models.get(name) ?? emptyTokens();
    const bucket = {
      model: name,
      hit: 0,
      miss: 0,
      out: 0,
      peakHit: 0,
      peakMiss: 0,
      peakOut: 0,
      cnyHit: 0,
      cnyMiss: 0,
      cnyOut: 0,
      cny: 0
    };
    for (const key of ["hit", "miss", "out"]) {
      const portion = names.length === 1 ? 1 : sample.deep[key] > 0 ? modelSample[key] / sample.deep[key] : 1 / names.length;
      const tokens = base[key] * share(key) * portion;
      const peak = peakShare(key);
      const rate = peak * price.peak[key] + (1 - peak) * price.off[key];
      const cny = tokens * rate / 1e6;
      bucket[key] = tokens;
      if (key === "hit") {
        bucket.peakHit = peak;
        bucket.cnyHit = cny;
      } else if (key === "miss") {
        bucket.peakMiss = peak;
        bucket.cnyMiss = cny;
      } else {
        bucket.peakOut = peak;
        bucket.cnyOut = cny;
      }
      bucket.cny += cny;
    }
    total += bucket.cny;
    if (bucket.cny > 0) buckets.push(bucket);
  }
  return {
    total,
    buckets,
    usd: Number(info?.cost ?? 0)
  };
}
function money(value) {
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value < 0.01) return "≈<¥0.01";
  if (value < 10) return `≈¥${value.toFixed(2)}`;
  if (value < 100) return `≈¥${value.toFixed(1)}`;
  return `≈¥${value.toFixed(0)}`;
}
const thousands = new Intl.NumberFormat("en-US");
function tierLabel(share) {
  const percent = Math.round(share * 100);
  if (percent === 0) return "空闲价";
  if (percent === 100) return "高峰价";
  return `高峰 ${percent}% / 空闲 ${100 - percent}%`;
}
function reportSession(context, sessionID) {
  const {
    total,
    buckets,
    usd
  } = breakdown(context, sessionID);
  if (total <= 0) return undefined;
  const lines = buckets.map(bucket => [`${bucket.model}（${tierLabel(bucket.peakMiss)}）`, `  缓存命中 ${thousands.format(Math.round(bucket.hit))} → ¥${bucket.cnyHit.toFixed(3)}`, `  缓存未命中 ${thousands.format(Math.round(bucket.miss))} → ¥${bucket.cnyMiss.toFixed(3)}`, `  输出 ${thousands.format(Math.round(bucket.out))} → ¥${bucket.cnyOut.toFixed(3)}`].join("\n"));
  return {
    total,
    usd,
    text: lines.join("\n")
  };
}
function report(context, sessionID) {
  const own = reportSession(context, sessionID);
  if (!own) return "当前会话还没有 DeepSeek 计费记录，或消息尚未加载。";
  const children = context.data.session.family(sessionID) ?? [];
  let childTotal = 0;
  let childCount = 0;
  for (const id of children) {
    if (id === sessionID) continue;
    const child = reportSession(context, id);
    if (!child) continue;
    childTotal += child.total;
    childCount += 1;
  }
  return [own.text, "", `本会话合计 ${money(own.total)}`, `OpenCode 显示的美元 ${own.usd > 0 ? `$${own.usd.toFixed(4)}` : "—"}（models.dev 折算价，约等于空闲价 ÷ 6.67）`, childCount > 0 ? `子代理 ${childCount} 个合计 ${money(childTotal)}` : "", childCount > 0 ? `含子代理合计 ${money(own.total + childTotal)}` : "", "", "按 DeepSeek 官方人民币价目表估算；法定节假日按工作日计，可能略高估。", "token 总量取会话汇总值，档位比例按最近 200 条消息推算。"].filter(line => line !== "").join("\n");
}

/*
 * 位置问题：内置的 `$0.02` 和它后面的 `ctrl+p commands` 快捷键提示是同一个
 * 组件（opencode.prompt.footer）里的两个兄弟节点，slot 只能在整块外面追加，
 * 插不到两者之间。所以这里改写 `Intl.NumberFormat.prototype.format`：
 * 当内置代码格式化「某个会话的美元金额」时，在结果后面补上人民币。
 * 只对 currency === "USD" 且金额恰好等于某个会话 cost 的调用生效，其它格式化不受影响。
 * 打补丁失败就退回追加到 prompt.footer 末尾。
 */
const FORMAT_PATCH_KEY = Symbol.for("opencode.tui-polish.inline-usd");

/**
 * 历史版本用过的补丁 key。改名/合并后如果只认新 key，会在旧补丁外面再套一层，
 * 同一个金额被补两次（footer 出现两个 ≈¥）。这里统一把它们关掉。
 */
const LEGACY_FORMAT_KEYS = [Symbol.for("opencode.cny-cost.inline")];
function retireLegacyFormats() {
  const proto = Intl.NumberFormat.prototype;
  for (const key of LEGACY_FORMAT_KEYS) {
    const state = proto[key];
    if (!state) continue;
    // 只清 context 不动原型链：旧 wrapper 仍会调用，但拿不到 context 就不再补后缀。
    state.context = null;
    try {
      delete proto[key];
    } catch {
      // 删不掉也无所谓，context 已经为空
    }
  }
}
function suffixFor(context, value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return "";
  const matches = sessionID => {
    const info = context.data.session.get(sessionID);
    if (!info) return false;
    return Math.abs(Number(info.cost ?? 0) - amount) < 1e-9;
  };
  const route = context.ui.router.current();
  const active = route?.type === "session" ? route.sessionID : undefined;
  if (active && matches(active)) {
    const text = money(breakdown(context, active).total);
    if (text) return text;
  }

  // 多标签页时 footer 的会话不一定是当前路由，再按金额匹配一次。
  for (const session of context.data.session.list() ?? []) {
    if (session.id === active) continue;
    if (Math.abs(Number(session.cost ?? 0) - amount) >= 1e-9) continue;
    const text = money(breakdown(context, session.id).total);
    if (text) return text;
  }
  return "";
}
function installInlineFormat(context) {
  const proto = Intl.NumberFormat.prototype;

  // 先把改名前的旧补丁关掉，避免两层叠加。
  retireLegacyFormats();
  const existing = proto[FORMAT_PATCH_KEY];
  if (existing) {
    existing.context = context;
    return true;
  }
  const descriptor = Object.getOwnPropertyDescriptor(proto, "format");
  if (!descriptor?.get) return false;
  const original = descriptor.get;
  const state = {
    context
  };
  try {
    Object.defineProperty(proto, "format", {
      configurable: true,
      enumerable: descriptor.enumerable,
      get() {
        const bound = original.call(this);
        let currency;
        try {
          currency = this.resolvedOptions().currency;
        } catch {
          return bound;
        }
        if (currency !== "USD") return bound;
        return value => {
          const text = bound(value);
          try {
            const suffix = state.context ? suffixFor(state.context, value) : "";
            return suffix ? `${text} ${suffix}` : text;
          } catch {
            return text;
          }
        };
      }
    });
  } catch {
    return false;
  }
  proto[FORMAT_PATCH_KEY] = state;
  return true;
}

/* ------------------------------------------------------------------ *
 * 本轮时间
 * ------------------------------------------------------------------ */

/**
 * 本轮时间范围：最后一条用户消息 → 它之后最后一条助手消息的完成时间。
 * 消息列表是倒序的（最新在前）且长会话会被截断，所以不依赖顺序、只取极值；
 * 最后一条用户消息一定在这段窗口里。
 */
function turnRange(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let start = 0;
  for (const message of list) {
    if (message?.type !== "user") continue;
    const created = Number(message?.time?.created ?? 0);
    if (created > start) start = created;
  }
  if (start <= 0) return "";
  let end = 0;
  for (const message of list) {
    if (message?.type !== "assistant") continue;
    const created = Number(message?.time?.created ?? 0);
    if (created < start) continue;
    const finished = Number(message?.time?.completed ?? message?.time?.streamed ?? created);
    if (finished > end) end = finished;
  }
  return range(start, end || start);
}

/* ------------------------------------------------------------------ *
 * 命令
 * ------------------------------------------------------------------ */

function CnyCommands(props) {
  props.context.keymap.layer(() => ({
    mode: "global",
    commands: [{
      id: `${PLUGIN_ID}.report`,
      title: "人民币费用明细",
      description: "按 DeepSeek 官方分档价目表列出本会话的 token 与人民币花费",
      group: "费用",
      palette: true,
      slash: {
        name: "cny"
      },
      run: () => {
        const route = props.context.ui.router.current();
        const sessionID = route?.type === "session" ? route.sessionID : undefined;
        if (!sessionID) {
          props.context.ui.toast.show({
            message: "当前不在会话中，没有可统计的费用。"
          });
          return;
        }
        props.context.ui.dialog.alert({
          title: "人民币费用明细",
          message: report(props.context, sessionID)
        });
      }
    }]
  }));
  return null;
}

/* ------------------------------------------------------------------ *
 * 插件入口
 * ------------------------------------------------------------------ */

export default Plugin.define({
  id: PLUGIN_ID,
  setup(context) {
    // 1) 人民币：优先补在内置美元数字后面（同一个文本节点，位置天然正确）。
    const inline = installInlineFormat(context);
    let stopCost = () => {};
    if (!inline) {
      stopCost = context.ui.slot({
        append: "prompt.footer",
        render: input => {
          const sessionID = input?.sessionID;
          if (!sessionID) return null;
          const label = () => {
            const value = money(breakdown(context, sessionID).total);
            return value ? ` ${value}` : "";
          };
          return (() => {
            var _el$ = _$createElement("text");
            _$setProp(_el$, "flexShrink", 0);
            _$setProp(_el$, "wrapMode", "none");
            _$insert(_el$, label);
            return _el$;
          })();
        }
      });
    }

    // 2) 本轮起止时间：输入框卡片底部状态行。
    const stopTime = context.ui.slot({
      append: "prompt.footer.status",
      render: input => {
        const sessionID = input?.sessionID;
        if (!sessionID) return null;
        const label = () => {
          const messages = context.data.session.message.list(sessionID);
          const value = turnRange(messages);
          return value ? ` · ${value}` : "";
        };
        return (() => {
          var _el$2 = _$createElement("text");
          _$setProp(_el$2, "flexShrink", 0);
          _$setProp(_el$2, "wrapMode", "none");
          _$insert(_el$2, label);
          return _el$2;
        })();
      }
    });

    // keymap.layer 要读 Solid 上下文，必须从组件里挂载，不能直接在 setup 里调。
    const stopCommands = context.ui.slot({
      append: "app",
      render: () => _$createComponent(CnyCommands, {
        context: context
      })
    });
    return () => {
      stopCost();
      stopTime();
      stopCommands();
    };
  }
});

// 仅用于本地回归测试（node 里核对金额与时间格式），不参与 TUI 渲染。
export const __test = {
  isPeak,
  money,
  breakdown,
  priceFor,
  report,
  triple,
  installInlineFormat,
  suffixFor,
  clock,
  monthDay,
  range,
  turnRange
};