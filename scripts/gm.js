import { module } from './module.js';
import { logger } from './log.js';
import { settings } from './settings.js';
import { esc, buttonRow, addButton, makeButton } from './helpers/utils.js';
const log = logger.for(import.meta.url);

/**
 * Things only the GM's client can do for everyone.
 *
 * Asking : a change to a creature its player doesn't own (a mark, a condition, a move) is the GM's to make : ask() posts
 * a card with a button only the GM sees, which runs the registered handler for the player who asked.
 *
 * Queries : a player's client asks the active GM to do something it isn't allowed to (bookkeeping : a log, a card).
 * Each query is registered by the feature that needs it, and its handler checks the request itself (who asked, from
 * which chat card...), so players can't use it to do anything else. On the GM's own client it just runs.
 *
 * Timed effects : effects flagged flags[module.id].expires = { actor, at, combat, round, turn } are removed by the
 * active GM at the start ("turnStart") or end ("turnEnd") of that actor's next turn in that combat, or when the combat
 * ends. Made out of combat (combat null, time) : when a combat begins with that actor in it, they last until its first
 * turn there; with no combat, 30 seconds of game time (OUT_OF_COMBAT).
 *
 * Turn starts : Hooks "macro-helper.turnStart" (combat, combatant), on the active GM's client, once for each creature's
 * turn, when whose turn it is is settled : a round (or the combat) whose order is still to be rolled (Initiative Each
 * Round, automatic initiative) waits for the roll. Rules acting at the start of a turn use it rather than
 * combatTurnChange (which, at a new round, names whoever was first before everyone rolled).
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
   * @param {object} [options]
   * @param {number} [options.timeout=30000]  ms to wait for the GM's answer (longer when the GM asks a player first)
   * @returns {Promise<any>}  the handler's result, null with a warning when no GM is online
   */
  static async run(name, data, { timeout = 30000 } = {}){
    const handler = this.#handlers.get(name);
    if(!handler) throw new Error(`Macro Helper | no GM query "${name}"`);
    if(game.user.isGM) return handler(data, game.user);

    const target = game.users.activeGM;
    if(!target){
      ui.notifications.warn("gm.none", { localize : true });
      return null;
    }
    return target.query(`${module.id}.${name}`, data, { timeout });
  }

  /**
   * Ask the GM to make a change to a creature the player doesn't own : a chat card with the GM's button, which runs the
   * registered handler (as run() would) for the player who asked. The GM's own use gets the card too : nothing changes
   * on another creature without the GM's click.
   * @param {string} name     a registered handler
   * @param {object} data     JSON-serializable
   * @param {object} options
   * @param {string} options.text    the card's line (what's asked)
   * @param {string} options.label   the GM's button
   * @param {Actor} [options.actor]  who's asking (the card's speaker)
   * @returns {Promise<ChatMessage>}  the card
   */
  static async ask(name, data, { text, label, actor = null } = {}){
    const handler = this.#handlers.get(name);
    if(!handler) throw new Error(`Macro Helper | no GM handler "${name}"`);
    return ChatMessage.implementation.create({
      speaker : actor ? ChatMessage.implementation.getSpeaker({ actor }) : { alias : module.title },
      content : `<p>${esc(text)}</p>`,
      flags : { [module.id] : { gmAsk : { name, data, label, done : false } } },
    });
  }

  /* The GM's button on an ask() card */
  static #askButton(message, html){
    const ask = message.getFlag?.(module.id, "gmAsk");
    if(!ask || !game.user.isGM) return;
    const row = buttonRow(html, { key : `${module.id}-gm-ask` });
    if(row.childElementCount) return;
    addButton(row, makeButton({ icon : "fa-gavel", text : ask.label, once : true, disabled : !!ask.done,
      onClick : async () => {
        const handler = this.#handlers.get(ask.name);
        if(!handler) return;
        const result = await handler(ask.data, message.author ?? game.user);
        for(const note of (Array.isArray(result) ? result : [])) ui.notifications.info(note);
        await message.setFlag(module.id, "gmAsk", { ...ask, done : true });
      } }));
  }

  static register(){
    Hooks.on("renderChatMessageHTML", (message, html) => this.#askButton(message, html));
    Hooks.on("combatTurnChange", (combat, prior, current)=> this.expire(combat, prior, current));
    Hooks.on("deleteCombat", combat => this.expireCombat(combat));
    Hooks.on("combatStart", combat => this.adoptOutOfCombat(combat));
    Hooks.on("updateWorldTime", worldTime => this.expireOutOfCombat(worldTime));
  }

  /* ---------- Timed effects ---------- */

  /* Seconds of game time an effect made out of combat lasts, when no combat begins first */
  static OUT_OF_COMBAT = 30;

  /**
   * The expiry stamp for an effect that lasts until the start / end of an actor's next turn, from the combat now.
   * Out of combat (or the actor isn't in it) there is no turn to wait for : null (once-per-turn counting uses this).
   * @param {Actor} actor
   * @param {"turnStart"|"turnEnd"} at
   * @returns {object|null}
   */
  static stamp(actor, at){
    const combat = game.combat;
    if(!combat?.started || !actor) return null;
    /* Its combatant : the same actor, or the same character opened from the sidebar instead of its token */
    const combatant = combat.combatants.find(c => c.actor?.uuid === actor.uuid)
      ?? combat.combatants.find(c => (c.actorId === actor.id) || (c.actor?.id === actor.id));
    if(!combatant) return null;
    return { actor : combatant.actor?.uuid ?? actor.uuid, at, combat : combat.id, round : combat.round, turn : combat.turn ?? 0 };
  }

  /**
   * A timed effect's stamp (addTimedEffect) : stamp(), or out of combat { combat : null, time } : its first turn in a
   * combat that begins (adoptOutOfCombat), else OUT_OF_COMBAT seconds of game time (expireOutOfCombat).
   * @param {Actor} actor
   * @param {"turnStart"|"turnEnd"} at
   * @returns {object|null}
   */
  static timedStamp(actor, at){
    if(!actor) return null;
    return this.stamp(actor, at) ?? { actor : actor.uuid, at, combat : null, time : game.time?.worldTime ?? 0 };
  }

  /* A combat began : effects made out of combat, for an actor in it, now wait for its first turn there */
  static async adoptOutOfCombat(combat){
    if(!game.users.activeGM?.isSelf) return;
    const inIt = new Set(combat.combatants.map(c => c.actor?.uuid).filter(Boolean));
    const ids = new Set(combat.combatants.map(c => c.actor?.id).filter(Boolean));
    for(const effect of this.#effects(e => !e.combat)){
      const expires = effect.getFlag(module.id, "expires");
      const owner = fromUuidSync(expires.actor ?? "", { strict : false });
      if(!inIt.has(expires.actor) && !ids.has(owner?.id)) continue;
      const combatant = combat.combatants.find(c => (c.actor?.uuid === expires.actor) || (c.actor?.id === owner?.id));
      /* Round 0 : its first turn in this combat is its "next" one */
      await effect.setFlag(module.id, "expires", { actor : combatant.actor?.uuid ?? expires.actor, at : expires.at, combat : combat.id, round : 0, turn : 0, ...(expires.thisTurn ? { thisTurn : true } : {}) });
    }
    /* The combat may already be under way (its first turn begun before these were taken over) */
    if(combat.started) await this.expireStart(combat);
  }

  /* Game time passed : effects made out of combat end after OUT_OF_COMBAT seconds */
  static async expireOutOfCombat(worldTime){
    if(!game.users.activeGM?.isSelf) return;
    for(const effect of this.#effects(e => !e.combat && Number.isFinite(e.time) && (worldTime - e.time >= this.OUT_OF_COMBAT))){
      log.debug("Expiring", effect.name, "on", effect.parent?.name, "(out of combat)");
      await effect.delete();
    }
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
    /* Same round and turn, another combatant : the order was re-sorted (initiative rolled), nobody's turn changed */
    if((prior?.round === current?.round) && (prior?.turn === current?.turn)) return;
    const actorOf = state => combat.combatants.get(state?.combatantId)?.actor?.uuid ?? null;
    const ended = actorOf(prior), started = actorOf(current);
    const priorAt = this.#at(prior?.round, prior?.turn), currentAt = this.#at(current?.round, current?.turn);
    /* A new round with Initiative Each Round (Homebrew) : who starts isn't known until everyone rerolls (expireStart) */
    const waitForOrder = (current?.round > prior?.round) && settings.value("homebrewInitiative");
    /* The combat beginning with initiative still to roll (automatic initiative) : the same */
    const toRoll = (current?.round === 1) && !((prior?.round ?? 0) >= 1) && (settings.value("initiativeMethod") === "auto")
      && combat.combatants.some(c => c.initiative === null);
    if(!waitForOrder && !toRoll) this.turnStarted(combat);

    /* "Next turn" : never the turn the effect was made in */
    const done = this.#effects(e => (e.combat === combat.id) && (
      ((e.at === "turnEnd") && (e.actor === ended) && ((priorAt > this.#at(e.round, e.turn)) || (e.thisTurn && (priorAt >= this.#at(e.round, e.turn)))))
      /* "This turn" and a new round began : that token's turn is over, even when its end was skipped (Next Round) */
      || ((e.at === "turnEnd") && e.thisTurn && ((current?.round ?? 0) > e.round))
      || (!waitForOrder && (e.at === "turnStart") && (e.actor === started) && (currentAt > this.#at(e.round, e.turn)))
    ));
    for(const effect of done){
      log.debug("Expiring", effect.name, "on", effect.parent?.name);
      await effect.delete();
    }
  }

  static #started = new Map();

  /* The current combatant's turn has begun (once per creature's turn) : Hooks "macro-helper.turnStart" */
  static turnStarted(combat){
    const combatant = combat?.combatant;
    if(!combat?.started || !combatant) return;
    const key = `${combat.round}.${combat.turn}.${combatant.id}`;
    if(this.#started.get(combat.id) === key) return;
    this.#started.set(combat.id, key);
    Hooks.callAll(`${module.id}.turnStart`, combat, combatant);
  }

  /* The start of the current combatant's turn, once the round's new order is set (Initiative Each Round) */
  static async expireStart(combat){
    if(!game.users.activeGM?.isSelf) return;
    this.turnStarted(combat);
    const started = combat.combatant?.actor?.uuid;
    const currentAt = this.#at(combat.round, combat.turn);
    const done = this.#effects(e => (e.combat === combat.id) && (e.at === "turnStart") && (e.actor === started) && (currentAt > this.#at(e.round, e.turn)));
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
