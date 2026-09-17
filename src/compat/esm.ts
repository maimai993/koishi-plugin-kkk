/**
 * 真实动态 import 的逃生舱。
 *
 * tsc 在 `module: commonjs` 下会把 `await import('x')` 降级成 `Promise.resolve().then(() => require('x'))`，
 * 于是 ESM-only 的依赖（例如 `@ikenxuan/qrcode` 的 exports 没有 require 条件）依旧加载不了。
 * 这里用 `new Function` 包一层，绕开编译期改写，运行时由 Node 走真正的 ESM 加载。
 */
export function importEsm<T = any> (specifier: string): Promise<T> {
  const importer = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<T>
  return importer(specifier)
}

export default importEsm
