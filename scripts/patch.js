import { module } from './module.js';
import { logger } from './log.js';
const log = logger.for(import.meta.url);

export class patch{
  /**
   * Wrap a method by its global path, fn is called as fn.call(this, wrapped, ...args).
   * Uses libWrapper when active so other modules wrapping the same method play nice.
   */
  static wrap(path, fn){
    if(game.modules.get("lib-wrapper")?.active){
      log.debug("libWrapper", path);
      return libWrapper.register(module.id, path, fn, "MIXED");
    }

    const i = path.lastIndexOf(".");
    const owner = foundry.utils.getProperty(globalThis, path.slice(0, i));
    const key = path.slice(i + 1);
    const original = owner?.[key];
    if(typeof original !== "function") return log.error("Cannot wrap, not a function", path);

    log.debug("Wrapping", path);
    owner[key] = function(...args){
      return fn.call(this, original.bind(this), ...args);
    };
  }
}
