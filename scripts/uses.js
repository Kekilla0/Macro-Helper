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
      "castingBusy",   // Casting : a long cast under way : using anything else asks, then fails the cast
      "cantUseInstead",// Use rules : cantUseWhile with `instead` (Druid : a spell in Wild Shape; Fix : leave the form, then cast)
      "flurry",        // Monk : Flurry of Blows uses the Unarmed Strike instead
      "smite",         // Cast on hit : a smite spell (or a feature casting one) from the sheet : the latest hit it fits
      "huntersMark",   // Ranger : Hunter's Mark / Favored Enemy : pay, pick, mark (or move the mark)
      "sneak",         // Rogue : Sneak Attack from the sheet : the latest qualifying hit
      "hex",           // Warlock : Hex : pay, ability, pick, curse (or move it)
      "fontOfMagic",   // Sorcerer : Font of Magic : the conversion window
      "arcaneRecovery",// Wizard : Arcane Recovery from the sheet : the slot window
      "familiar",      // Familiars : Store / Summon New / Release, before dnd5e's choice of activity
      "itemMacro",     // Item Macro : a macro run before (or instead of) the use
      "healer",        // Feats : the Healer feat's Battle Medic
      "byHealth",      // Spells : Toll the Dead uses its healthy / hurt activity for its target
      "element",       // Spell actions : Elementalism : which element (its area's colour), no Beckon / Sculpt question
      "flame",         // Spell actions : Produce Flame : you, a creature (hurl) or a square, one pick
      "goodberry",     // Spell actions : Goodberry : who gets the berries (up to 10 picks, repeats allowed)
      "water",         // Spell actions : Create or Destroy Water : fill containers or rain (douse flames)
      "illusion",      // Spell actions : Disguise Self, Silent Image, Sanctuary : straight to casting (the other activity is for others); the image's space
      "afterAttack",   // Spell actions : Ice Knife goes to its attack (its shard's save comes after)
      "sustained",     // Spell actions : Witch Bolt again at the same creature : its later turns' damage
      "subclassItem",  // Subclasses : an item with nothing to roll does its rule (Tides of Chaos)
      "fastForward",   // Roll Item : one attack with its riders skips dnd5e's choice of activity
    ],
    activity : [
      "shellToggle",   // Species : a Tortle's Shell Defense used while in its shell : it emerges instead (a Bonus Action)
      "castingBusy",   // Casting : a long cast under way : using anything else asks, then fails the cast
      "cunningAction", // Rogue : Cunning Action's Dash / Disengage / Hide uses that Default Action, as a Bonus Action
      "noReactions",   // Spell effects : a Reaction while an effect forbids them (Arms of Hadar) : Rule Limits
      "offScene",      // Roll Item : no token on the scene being viewed : no targets (it can't see them)
      "itemMacro",     // Item Macro : a macro on the activity
      "ritual",        // Spells : cast as a Ritual (no slot, 10 minutes longer) or normally
      "castLevel",     // Spells : a levelled spell aimed at creatures asks its slot level first (the pick counts upcast targets)
      "longCast",      // Casting : 1 minute or more (or a Ritual) : begun with Concentration, cast from its card later
      "slotPerTurn",   // Casting : a second spell slot this turn follows Rule Limits
      "castingChoice", // Casting choice : an option chosen as it's cast, paid once cast (Metamagic; Quickened : its economy)
      "economy",       // Action Tracker : its Action / Bonus Action / Reaction (Rule Limits for a second), spent once used
      "components",    // Components : V (not Silenced), S (a free hand), M (a focus, or a pouch and a free hand) : Rule Limits
      "spellCommand",  // Spell actions : Command : which command, before the targets
      "spellChoice",   // Spell effects : Guidance's skill, Resistance's damage type, asked before the targets
      "enchantProfile",// Spell actions : Shillelagh's enchantment by caster level, True Strike's by the weapon
      "flurry",        // Monk : Monk's Focus's Flurry of Blows uses the Unarmed Strike instead
      "presetTargets", // Emanation : every matching creature round the user is targeted (Turn Undead), no pick
      "action",        // Default Actions : choose and pick first (Help)
      "maneuver",      // Maneuvers : Grapple or Shove, for the one activity that does both
      "transform",     // Druid : Wild Shape's form, a familiar and its space
      "layOnHands",    // Paladin : Remove Poison picks the creature it touches
      "hide",          // Default Actions : Hide asks the GM first (gm.askToUse); used only once allowed
      "healersKit",    // Default Actions : the Healer's Kit's Stabilize picks a creature at 0 HP first
      "dancingLights", // Spells : Dancing Lights : four lights or one form, where each goes
      "spellMessage",  // Spell actions : Message : who hears it and what, from a list (no pick)
      "placedSummon",  // Spell actions : Mage Hand : its caster picks the space, the GM makes it
      "spellLight",    // Spell actions : Light on a token or a square, Produce Flame in hand
      "spareTheDying", // Spell actions : Spare the Dying picks a creature at 0 HP first
      "subclassUse",   // Subclasses : a feature that picks or divides first (Preserve Life, Invoke Duplicity's space)
      "pactWeapon",    // Warlock : Forge Pact Weapon : bond a weapon or conjure one
      "pickTargets",   // Roll Item : pick targets on the map (Pick Targets)
      "spellRange",    // Spells : no pick, Rule Limits on : targets out of the spell's range follow Rule Limits
      "weaponRange",   // Weapons : no pick, Rule Limits on : targets beyond the weapon's reach / range follow Rule Limits
      "economyApproval", // Action Tracker : a player's Action / Bonus Action off its turn : the GM approves (its targets picked)
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
