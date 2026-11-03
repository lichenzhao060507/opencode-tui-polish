import { Plugin } from "@opencode/plugin"

// cny-cost 只有 TUI 部分，这个服务端入口是空的。
// 但不能省：OpenCode 对本地路径插件只认插件根目录的 index/server 与 tui 文件，
// 不读 package.json 的 exports，缺了 index.ts 整个插件都不会被发现。
export default Plugin.define({
  id: "cny-cost",
  setup() {},
})
