// 把 src/tui.tsx 编译成 dist/tui.js。
//
// 为什么要预编译：OpenCode 不能直接加载 .tsx 插件，Solid JSX 运行时在插件缓存
// 目录里解析不到，必须先用 babel-preset-solid 编成普通 JS。
//
// babel 从下面几个位置依次找（第一个存在的生效）：
//   1. 本仓库自己的 node_modules（npm install 之后）
//   2. 环境变量 TUI_POLISH_BABEL_ROOT 指向的目录
//   3. 环境变量 CNY_COST_BABEL_ROOT（旧名字，兼容用）
//   4. 同级的 tavily-quota 插件（作者本机复用一个 200MB 依赖的做法）
import { createRequire } from "node:module"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))

const candidates = [
  join(here, "package.json"),
  process.env.TUI_POLISH_BABEL_ROOT && join(process.env.TUI_POLISH_BABEL_ROOT, "package.json"),
  process.env.CNY_COST_BABEL_ROOT && join(process.env.CNY_COST_BABEL_ROOT, "package.json"),
  join(here, "..", "tavily-quota", "package.json"),
].filter(Boolean)

const shared = candidates.find((path) => existsSync(path))
if (!shared) {
  throw new Error(
    "找不到 babel。请先在插件目录执行 npm install，或设置 TUI_POLISH_BABEL_ROOT 指向已装好 babel 的目录。",
  )
}

const require = createRequire(shared)
const babel = require("@babel/core")

const filename = join(here, "src/tui.tsx")
const source = await readFile(filename, "utf8")

const result = await babel.transformAsync(source, {
  filename,
  babelrc: false,
  configFile: false,
  presets: [
    [require.resolve("@babel/preset-typescript"), { isTSX: true, allExtensions: true }],
    [require.resolve("babel-preset-solid"), { moduleName: "@opentui/solid", generate: "universal" }],
  ],
})

if (!result?.code) throw new Error("babel produced no output")

await mkdir(join(here, "dist"), { recursive: true })
await writeFile(join(here, "dist/tui.js"), result.code, "utf8")
console.log("built dist/tui.js")
