import { module } from './module.js';
import { logger } from './log.js';
const log = logger.for(import.meta.url);

export class patch{
  /* Wrappers per path. libWrapper allows one registration per module per target, so features share it. */
  static #chains = new Map();

  /**
   * Wrap a method by its global path, fn is called as fn.call(this, wrapped, ...args).
   * Several features can wrap the same path : they are chained inside a single wrapper, the latest registered runs first.
   * Uses libWrapper when active so other modules wrapping the same method play nice.
   */
  static wrap(path, fn){
    const chain = patch.#chains.get(path);
    if(chain){
      log.debug("Chaining", path);
      chain.push(fn);
      return;
    }
    patch.#chains.set(path, [fn]);

    /* Calls the chain from the last registered wrapper down to the original method */
    const run = function(original, ...args){
      const fns = patch.#chains.get(path);
      const call = (index, ...callArgs) => index < 0
        ? original(...callArgs)
        : fns[index].call(this, (...next) => call(index - 1, ...next), ...callArgs);
      return call(fns.length - 1, ...args);
    };

    if(game.modules.get("lib-wrapper")?.active){
      log.debug("libWrapper", path);
      return libWrapper.register(module.id, path, run, "MIXED");
    }

    const i = path.lastIndexOf(".");
    const owner = foundry.utils.getProperty(globalThis, path.slice(0, i));
    const key = path.slice(i + 1);
    const original = owner?.[key];
    if(typeof original !== "function") return log.error("Cannot wrap, not a function", path);

    log.debug("Wrapping", path);
    owner[key] = function(...args){
      return run.call(this, original.bind(this), ...args);
    };
  }
}
