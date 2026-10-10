import { module } from './module.js';
import { patch } from './patch.js';
import { logger } from './log.js';
const log = logger.for(import.meta.url);

/**
 * Using an item, in one place. Features add steps to dnd5e's Item#use and Activity#use here instead of wrapping them
 * (dnd5e only). Each step is fn(document, ctx, next) :
 *   ctx    : { config, dialog, message } as the call has them so far (an activity's config is its usage). A step
 *            changes them in place (or with mark / flag below) for the steps after it and dnd5e.
 *   next() : the steps after it, then dnd5e's own use; its result is the use's result.
 *   A step that doesn't call next() stops the use (return nothing) or takes it over (return its own result).
 *
 * Steps run in ORDER, outermost first, whatever order the features register in. A step not in ORDER runs last.
 *
 * After the use : Roll Item makes its card after dnd5e's use returns (the target pick for an attack, a save's card).
 * Its promise is on the results : uses.cardOf(results) waits for it.
 */
export class uses{
  static ORDER = {
    item : [
      "wildShapeCast", // Druid : a spell while in Wild Shape (Rule Limits; Change : leave the form, then cast)
      "flurry",        // Monk : Flurry of Blows uses the Unarmed Strike instead
      "smite",         // Paladin : a smite spell from the sheet smites the latest melee hit
      "huntersMark",   // Ranger : Hunter's Mark / Favored Enemy : pay, pick, mark (or move the mark)
      "sneak",         // Rogue : Sneak Attack from the sheet : the latest qualifying hit
      "hex",           // Warlock : Hex : pay, ability, pick, curse (or move it)
      "fontOfMagic",   // Sorcerer : Font of Magic : the conversion window
      "arcaneRecovery",// Wizard : Arcane Recovery from the sheet : the slot window
      "familiar",      // Familiars : Store / Summon New / Release, before dnd5e's choice of activity
      "itemMacro",     // Item Macro : a macro run before (or instead of) the use
      "healer",        // Feats : the Healer feat's Battle Medic
      "fastForward",   // Roll Item : one attack with its riders skips dnd5e's choice of activity
    ],
    activity : [
      "offScene",      // Roll Item : no token on the scene being viewed : no targets (it can't see them)
      "itemMacro",     // Item Macro : a macro on the activity
      "ritual",        // Spells : cast as a Ritual (no slot, 10 minutes longer) or normally
      "metamagic",     // Sorcerer : Metamagic chosen and paid before a Sorcerer spell is cast (Distant : the range picked)
      "flurry",        // Monk : Monk's Focus's Flurry of Blows uses the Unarmed Strike instead
      "presetTargets", // Cleric : Turn Undead targets the Undead within 30 ft itself (no pick)
      "action",        // Default Actions : choose and pick first (Help)
      "maneuver",      // Maneuvers : Grapple or Shove, for the one activity that does both
      "transform",     // Druid : Wild Shape's form, a familiar and its space
      "layOnHands",    // Paladin : Remove Poison picks the creature it touches
      "hide",          // Rogue : Cunning Action's Hide asks the GM first; used only once allowed
      "healersKit",    // Default Actions : the Healer's Kit's Stabilize picks a creature at 0 HP first
      "dancingLights", // Spells : Dancing Lights : four lights or one form, where each goes
      "pactWeapon",    // Warlock : Forge Pact Weapon : bond a weapon or conjure one
      "pickTargets",   // Roll Item : pick targets on the map (Pick Targets)
      "spellRange",    // Spells : no pick, Rule Limits on : targets out of the spell's range follow Rule Limits
      "weaponRange",   // Weapons : no pick, Rule Limits on : targets beyond the weapon's reach / range follow Rule Limits
    ],
  };

  static #steps = { item : [], activity : [] };

  /**
   * A step on Item#use.
   * @param {string} name   its place in ORDER.item
   * @param {(item : Item, ctx : object, next : Function) => any} fn
   */
  static onItem(name, fn){
    this.#add("item", name, fn);
  }

  /**
   * A step on Activity#use (every activity type).
   * @param {string} name   its place in ORDER.activity
   * @param {(activity : Activity, ctx : object, next : Function) => any} fn
   */
  static onActivity(name, fn){
    this.#add("activity", name, fn);
  }

  static #add(kind, name, fn){
    const steps = this.#steps[kind];
    if(steps.some(s => s.name === name)) return log.error("Use step registered twice", kind, name);
    const rank = n => { const i = this.ORDER[kind].indexOf(n); return (i < 0) ? Infinity : i; };
    if(rank(name) === Infinity) log.info("Use step not in ORDER, runs last", kind, name);
    steps.push({ name, fn });
    steps.sort((a, b) => rank(a.name) - rank(b.name));
  }

  /* The steps, then the original use (dnd5e's), with its arguments */
  static run(kind, doc, original, args){
    const [config = {}, dialog = {}, message = {}, ...rest] = args;
    const ctx = { config, dialog, message };
    const steps = this.#steps[kind];
    const call = index => (index < steps.length)
      ? steps[index].fn(doc, ctx, () => call(index + 1))
      : original(ctx.config, ctx.dialog, ctx.message, ...rest);
    return call(0);
  }

  /* Once, at init : Item#use, and the use of every activity type (each prototype that has its own once) */
  static register(){
    if(game.system.id !== "dnd5e") return;
    patch.wrap("CONFIG.Item.documentClass.prototype.use", function(wrapped, ...args){
      return uses.run("item", this, wrapped, args);
    });
    const owners = new Set();
    for(const [type, { documentClass }] of Object.entries(CONFIG.DND5E?.activityTypes ?? {})){
      let proto = documentClass?.prototype;
      while(proto && !Object.hasOwn(proto, "use")) proto = Object.getPrototypeOf(proto);
      if(!proto || owners.has(proto)) continue;
      owners.add(proto);
      patch.wrap(`CONFIG.DND5E.activityTypes.${type}.documentClass.prototype.use`, function(wrapped, ...args){
        return uses.run("activity", this, wrapped, args);
      });
    }
  }

  /* ---------- For steps ---------- */

  /* Notes for later steps and the module's hooks : merged into config[module.id] */
  static mark(ctx, data){
    ctx.config = { ...ctx.config, [module.id] : { ...(ctx.config?.[module.id] ?? {}), ...data } };
  }

  /* Flags on the card dnd5e makes : merged into message.data.flags[module.id] */
  static flag(ctx, data){
    ctx.message = foundry.utils.mergeObject(ctx.message ?? {}, { data : { flags : { [module.id] : data } } }, { inplace : false });
  }

  /**
   * The card Roll Item makes after the use, once it's made. Null : closed before anything was rolled (nothing used).
   * Without Roll Item's card : dnd5e's own message.
   * @param {object} results   what the use returned
   * @returns {Promise<object|null>}
   */
  static async cardOf(results){
    if(!results) return null;
    const pending = results[module.id]?.card;
    if(pending) return (await pending) ?? null;
    return results.message ?? null;
  }
}
