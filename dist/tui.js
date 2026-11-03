import { createComponent as _$createComponent } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui";

/**
 * cny-cost —— 在 TUI 里用人民币显示当前会话费用
 *
 * 为什么需要这个插件：OpenCode 的钱数格式化是硬编码的
 * `Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })`，
 * 没有货币配置项，也没有可以改格式的钩子。插件不能改写那个数字，
 * 只能在旁边补一个自己算的人民币值。
 *
 * 为什么不直接把美元乘汇率：DeepSeek 官方计费是分档的
 * （缓存命中 / 缓存未命中 / 输出，再乘高峰 / 空闲系数），而 models.dev
 * 给 deepseek-flash 的标价折算后等于"空闲时段 ÷ 6.67"。高峰期实际支出
 * 是美元数字的 2 倍，乘固定汇率会低估。
 *
 * 价目来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 *   金额单位：人民币元 / 百万 tokens；空闲价 = 高峰价的一半。
 *
 * 金额怎么算（2026-11 修正）：
 *   OpenCode 的 message 列表是分页的（单页最多 200 条），长会话只能看到
 *   最后一段，直接按消息累加会漏掉一半以上（实测 157M 缓存命中只统计到
 *   78M）。所以 token 总量一律取 session 的汇总值 `session.get().tokens`，
 *   它是服务端完整累计；消息列表只用来判断这些 token 落在高峰还是空闲，
 *   以及被哪些模型/提供商消耗。
 *
 * 已知近似：
 *   1. 法定节假日无法离线判定，按普通工作日计算（会高估）；
 *   2. 单次请求按消息开始时间归档档位，跨时段边界的请求按起点计；
 *   3. 只对能匹配到价目表的模型计价（deepseek-flash / deepseek-v4-pro），
 *      免费通道和其它提供商不显示。
 */

const PLUGIN_ID = "cny-cost";
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
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
 * 当内置代码格式化「当前会话的美元金额」时，在结果后面补上人民币。
 * 只对 currency === "USD" 且金额恰好等于某个会话 cost 的调用生效，其它格式化不受影响。
 * 打补丁失败就退回原来的做法（追加到 prompt.footer 末尾）。
 */
const PATCH_KEY = Symbol.for("opencode.cny-cost.inline");
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
  const existing = proto[PATCH_KEY];
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
  proto[PATCH_KEY] = state;
  return true;
}
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
export default Plugin.define({
  id: PLUGIN_ID,
  setup(context) {
    // 优先把人民币补在内置美元数字后面（同一个文本节点里，位置天然正确）。
    const inline = installInlineFormat(context);

    // 补丁打不上时退回追加到 prompt footer 末尾。
    let stopStatus = () => {};
    if (!inline) {
      stopStatus = context.ui.slot({
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

    // keymap.layer 要读 Solid 上下文，必须从组件里挂载，不能直接在 setup 里调。
    const stopCommands = context.ui.slot({
      append: "app",
      render: () => _$createComponent(CnyCommands, {
        context: context
      })
    });
    return () => {
      stopStatus();
      stopCommands();
    };
  }
});

// 仅用于本地回归测试（node 里核对金额），不参与 TUI 渲染。
export const __test = {
  isPeak,
  money,
  breakdown,
  priceFor,
  report,
  triple,
  installInlineFormat,
  suffixFor
};