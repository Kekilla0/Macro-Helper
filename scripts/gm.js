import { module } from './module.js';
import { logger } from './log.js';
const log = logger.for(import.meta.url);

/**
 * Things only the GM's client can do for everyone.
 *
 * Queries : a player's client asks the active GM to do something it isn't allowed to (move an enemy, put an effect on it).
 * Each query is registered by the feature that needs it, and its handler checks the request itself (who asked, from
 * which chat card...), so players can't use it to do anything else. On the GM's own client it just runs.
 *
 * Timed effects : effects flagged flags[module.id].expires = { actor, at, combat, round, turn } are removed by the
 * active GM at the start ("turnStart") or end ("turnEnd") of that actor's next turn in that combat.
 */
export class gm{
  static #handlers = new Map();

  /**
   * Register a query, as "<module id>.<name>". The handler gets (data, user) and runs on the GM's client.
   * @param {string} name
   * @param {(data : object, user : User) => Promise<any>} handler
   */
  static handle(name, handler){
    this.#handlers.set(name, handler);
    CONFIG.queries[`${module.id}.${name}`] = (data, { user } = {}) => handler(data, user);
  }

  /**
   * Run a registered query as the GM : here when you are the GM, else on the active GM's client.
   * @param {string} name
   * @param {object} data   JSON-serializable
   * @returns {Promise<any>}  the handler's result, null with a warning when no GM is online
   */
  static async run(name, data){
    const handler = this.#handlers.get(name);
    if(!handler) throw new Error(`Macro Helper | no GM query "${name}"`);
    if(game.user.isGM) return handler(data, game.user);

    const target = game.users.activeGM;
    if(!target){
      ui.notifications.warn("gm.none", { localize : true });
      return null;
    }
    return target.query(`${module.id}.${name}`, data, { timeout : 30000 });
  }

  static register(){
    Hooks.on("combatTurnChange", (combat, prior, current)=> this.expire(combat, prior, current));
    Hooks.on("deleteCombat", combat => this.expireCombat(combat));
  }

  /* ---------- Timed effects ---------- */

  /**
   * The expiry stamp for an effect that lasts until the start / end of an actor's next turn, from the combat now.
   * Out of combat (or the actor isn't in it) there is no turn to wait for : null.
   * @param {Actor} actor
   * @param {"turnStart"|"turnEnd"} at
   * @returns {object|null}
   */
  static stamp(actor, at){
    const combat = game.combat;
    if(!combat?.started || !actor) return null;
    if(!combat.combatants.some(c => c.actor?.uuid === actor.uuid)) return null;
    return { actor : actor.uuid, at, combat : combat.id, round : combat.round, turn : combat.turn ?? 0 };
  }

  /* Every actor that could carry a timed effect : the world's, plus unlinked tokens on the viewed scene */
  static *actors(){
    yield* game.actors;
    for(const token of canvas.tokens?.placeables ?? []){
      if(token.actor && !token.document.actorLink) yield token.actor;
    }
  }

  static #effects(test){
    const found = [];
    for(const actor of this.actors()){
      for(const effect of actor.effects){
        const expires = effect.getFlag(module.id, "expires");
        if(expires && test(expires)) found.push(effect);
      }
    }
    return found;
  }

  /* A moment in the combat, comparable : round then turn */
  static #at(round, turn){
    return (round * 1000) + (turn ?? 0);
  }

  static async expire(combat, prior, current){
    if(!game.users.activeGM?.isSelf) return;
    const actorOf = state => combat.combatants.get(state?.combatantId)?.actor?.uuid ?? null;
    const ended = actorOf(prior), started = actorOf(current);
    const priorAt = this.#at(prior?.round, prior?.turn), currentAt = this.#at(current?.round, current?.turn);

    /* "Next turn" : never the turn the effect was made in */
    const done = this.#effects(e => (e.combat === combat.id) && (
      ((e.at === "turnEnd") && (e.actor === ended) && (priorAt > this.#at(e.round, e.turn)))
      || ((e.at === "turnStart") && (e.actor === started) && (currentAt > this.#at(e.round, e.turn)))
    ));
    for(const effect of done){
      log.debug("Expiring", effect.name, "on", effect.parent?.name);
      await effect.delete();
    }
  }

  static async expireCombat(combat){
    if(!game.users.activeGM?.isSelf) return;
    for(const effect of this.#effects(e => e.combat === combat.id)) await effect.delete();
  }
}
