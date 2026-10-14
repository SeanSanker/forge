import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The sources import each other as `./name.js`, the way TypeScript emits
// them. Node runs the `.ts` files as they are, so a relative `.js` import
// that does not exist resolves to the `.ts` file next to it. In an SDK,
// these sources sit in `_/` next to the TypeScript runtime, so an import
// from src that is in neither resolves to the TypeScript runtime's file.
const src = fileURLToPath(new URL('../src/', import.meta.url));
const tsSrc = fileURLToPath(new URL('../../../ts/lib/src/', import.meta.url));

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const relative = specifier.startsWith('./') || specifier.startsWith('../');
      if (!relative || !specifier.endsWith('.js') || (error as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') {
        throw error;
      }
      const ts = `${specifier.slice(0, -3)}.ts`;
      const path = fileURLToPath(new URL(ts, context.parentURL));
      if (!existsSync(path) && path.startsWith(src)) {
        return nextResolve(pathToFileURL(tsSrc + path.slice(src.length)).href, context);
      }
      return nextResolve(ts, context);
    }
  },
});
