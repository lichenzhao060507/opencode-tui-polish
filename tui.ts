// TUI 入口（根目录转发）。
//
// 不能指向 src/tui.tsx：Solid JSX runtime 无法从插件缓存目录解析，必须在构建
// 阶段用 babel-preset-solid 预编译，产物在 dist/tui.js。
export * from "./dist/tui.js"
export { default } from "./dist/tui.js"
