import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const ts = require('typescript');
export function loader(overrides = {}) {
  const cache = new Map();
  const SDK_SOURCE_SUFFIX = '/toolchain/packages/plugin-sdk/src/index.ts';
  function load(file) {
    const path = resolve(dirname(fileURLToPath(import.meta.url)), file);
    // 多个测试会显式 load('../../../toolchain/packages/plugin-sdk/src/index.ts') 拿 createRouter。
    // 本机没 clone toolchain 时，把这个硬编码路径透明重定向到已安装的 npm 包
    // （node_modules/@songloft/plugin-sdk，cjs 入口），不用改每个测试文件。
    if (path.replace(/\\/g, '/').endsWith(SDK_SOURCE_SUFFIX) && !existsSync(path)) {
      return require('@songloft/plugin-sdk');
    }
    if (cache.has(path))
      return cache.get(path);
    const exports = {};
    cache.set(path, exports);
    const source = readFileSync(path, 'utf8');
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
    new Function('require', 'exports', outputText)(name => {
      if (Object.hasOwn(overrides, name))
        return overrides[name];
      if (name === '@songloft/plugin-sdk') {
        // 优先用 toolchain 源码（改 SDK 时可即时验证）；本机没 clone toolchain 时
        // 回退到已安装的 npm 包（node_modules/@songloft/plugin-sdk，cjs 入口）。
        const sdkSource = resolve(
          dirname(fileURLToPath(import.meta.url)),
          '../../../toolchain/packages/plugin-sdk/src/index.ts',
        );
        return existsSync(sdkSource) ? load(sdkSource) : require('@songloft/plugin-sdk');
      }
      if (!name.startsWith('.'))
        return require(name);
      const base = resolve(dirname(path), name);
      if (base.endsWith('.json'))
        return JSON.parse(readFileSync(base, 'utf8'));
      const target = existsSync(`${base}.ts`) ? `${base}.ts` : resolve(base, 'index.ts');
      return load(target);
    }, exports);
    return exports;
  }
  return load;
}
export async function flush() {
  for (let i = 0; i < 80; i++)
    await Promise.resolve();
}
export function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { resolve, reject, promise }; }
