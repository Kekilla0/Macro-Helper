import { module } from './module.js';

export class logger{
  static _fmt(parts){ return [module.title, ...parts].filter(Boolean).join(" | "); }

  /* Settings may not be registered yet (pre-init), so treat that as debug off */
  static _debug(){
    try { return game.settings.get(module.id, "debug"); }
    catch { return false; }
  }

  static info(...args){ console.log(this._fmt([]), ...args); }
  static debug(...args){ if(this._debug()) console.log(this._fmt(["DEBUG"]), ...args); }
  static error(...args){ console.error(this._fmt(["ERROR"]), ...args); }

  static normalizeLabel(label){
    if (!label) return "";
    try {
      const u = new URL(label, window?.location?.href || undefined);
      return u.pathname.split("/").pop() || "";
    } catch {
      return String(label).split("/").pop();
    }
  }

  /* Scoped logger, usage : const log = logger.for(import.meta.url); */
  static for(label){
    const _file = this.normalizeLabel(label);

    return {
      info:  (...args)=> console.log(this._fmt([_file]), ...args),
      debug: (...args)=> this._debug() && console.log(this._fmt(["DEBUG", _file]), ...args),
      error: (...args)=> console.error(this._fmt(["ERROR", _file]), ...args),
    };
  }
}
