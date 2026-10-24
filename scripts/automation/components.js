import { module } from '../module.js';
import { settings } from '../settings.js';
import { logger } from '../log.js';
import { uses } from '../uses.js';
import { spells } from './spells.js';
import { limits } from './limits.js';
import { hands } from './hands.js';
import { itemFixes } from './item-fixes.js';
import { idOf } from '../helpers/utils.js';
const log = logger.for(import.meta.url);

/**
 * Spell components (System Automation → Spells switch), PHB 2024 Chapter 7. Checked before a spell is cast (and
 * before a long cast begins); anything missing follows Rule Limits.
 *
 *   Verbal (V)    : not while Silenced.
 *   Somatic (S)   : a free hand (Hands), or the hand holding the focus when the spell also has M. War Caster lifts it.
 *                   A Versatile weapon held in both hands leaves one free (it can be held in one).
 *   Material (M)  : an equipped item with dnd5e's Focus property (any kind, for any caster : a weapon that is also a
 *                   focus, an amulet, an emblem on a shield...), or a carried Component Pouch. A focus in a hand (or an
 *                   emblem on the held shield) is handled by that hand; a worn one (an amulet) or the pouch needs a
 *                   free hand to grasp it. That hand also does S. The basic foci (Plutonium's and
 *                   dnd5e's : amulet, crystal, emblem, orb, reliquary, rod, staff, wand, sprig of mistletoe, wooden
 *                   staff, yew wand) and musical instruments get the Focus property when added.
 *   Costly M      : (System Automation → Equipment → Costly Materials) a spell's material with a cost (Identify's
 *                   100 GP pearl) : Off (a focus does), an Item (one in the inventory named in the material, worth
 *                   that much; used up when the spell consumes it), or Coins (that much money; spent when consumed).
 *   Subtle Spell  : no V or S.
 * NPCs are only checked for V (2024 monster spellcasting needs no Material components). Characters with Hands off
 * aren't checked for hands, only for a focus or pouch.
 */
export class components{
  static WAR_CASTER = "war-caster";
  static POUCH = "component-pouch";
  /* The basic spellcasting foci (Holy Symbols, Arcane and Druidic foci), by identifier */
  static FOCI = ["amulet", "emblem", "reliquary", "crystal", "orb", "rod", "staff", "wand", "sprig-of-mistletoe", "wooden-staff", "yew-wand"];
  static STOP_WORDS = new Set(["worth", "which", "spell", "spells", "consumes", "burning", "flask", "with", "that", "least", "each", "from", "piece", "pieces"]);

  static enabled(){
    return spells.enabled();
  }

  static mode(){
    return settings.value("spellMaterials") ?? "off";
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    uses.onActivity("components", (activity, ctx, next) => this.step(activity, ctx, next));
    Hooks.on("dnd5e.postUseActivity", (activity, usage, results) => this.spend(activity, usage, results));
    itemFixes.add({ name : "Spellcasting focus", where : "owned", plan : item => this.focusFix(item) });
  }

  /* A basic focus or a musical instrument without dnd5e's Focus property : given it */
  static focusFix(item){
    if(!this.enabled()) return null;
    const basic = this.FOCI.includes(idOf(item)) && ["equipment", "weapon"].includes(item.type);
    const instrument = (item.type === "tool") && (item.system.type?.value === "music");
    if(!(basic || instrument) || item.system.properties?.has?.("foc")) return null;
    return { update : { "system.properties" : [...(item._source?.system?.properties ?? []), "foc"] } };
  }

  /* ---------- What the spell needs, what the caster has ---------- */

  static needs(activity, config = {}){
    const props = activity?.item?.system?.properties;
    const has = key => !!props?.has?.(key);
    /* Components a rule left out of this use (Subtle Spell) : config["macro-helper"].components = { v : false, s : false } */
    const drop = config?.[module.id]?.components ?? {};
    const need = { v : has("vocal") && (drop.v !== false), s : has("somatic") && (drop.s !== false), m : has("material") && (drop.m !== false) };
    /* Rules that drop some (Improved Illusions : no V; Psychic Spells : no V or S) : Hooks "macro-helper.components" (activity, need) */
    Hooks.callAll(`${module.id}.components`, activity, need);
    return need;
  }

  static isShield(item){
    return (item?.type === "equipment") && (item.system.type?.value === "shield");
  }

  /**
   * Why the spell can't be cast as things stand : a list of reasons (empty : it can)
   * @param {Activity} activity
   * @param {object} [config]   the use's configuration (Subtle Spell)
   * @returns {string[]}
   */
  static problems(activity, config = {}){
    const actor = activity?.actor, item = activity?.item;
    if(!this.enabled() || (item?.type !== "spell") || !actor) return [];
    const need = this.needs(activity, config);
    const out = [];
    if(need.v && actor.statuses?.has?.("silenced")) out.push(module.format("components.verbal", { name : actor.name }));
    /* Monsters' spellcasting (2024 stat blocks) needs no Material components, and their hands aren't tracked */
    if((actor.type !== "character") || (!need.s && !need.m)) return out;

    const managed = hands.manages(actor);
    const held = managed ? hands.of(actor) : null;
    /* A Versatile weapon held in both hands could be held in one : a hand is free for the spell */
    const bothHands = managed && held.main && (held.main === held.off) ? actor.items.get(held.main) : null;
    const freeHand = managed ? (!held.main || !held.off || (!!bothHands && hands.isVersatile(bothHands) && !hands.isTwoHanded(bothHands))) : true;
    const warCaster = actor.items.some(i => idOf(i) === this.WAR_CASTER);
    const foci = actor.items.filter(i => i.system?.properties?.has?.("foc") && i.system.equipped);
    /* In a hand (or an emblem on a held shield) : that hand also does S */
    const focusInHand = foci.find(i => !managed || hands.handOf(actor, i) || this.isShield(i));
    const focusWorn = foci.find(i => i !== focusInHand);
    const pouch = actor.items.find(i => (idOf(i) === this.POUCH) || (i.name?.toLowerCase?.() === "component pouch"));

    let somaticDone = !need.s || warCaster;
    if(need.m){
      /* Held (or an emblem on the held shield) : that hand handles it, and does S */
      if(focusInHand) somaticDone = true;
      /* Worn (an amulet on a necklace), or the pouch : a free hand grasps it, and does S */
      else if((focusWorn || pouch) && freeHand) somaticDone = true;
      else {
        out.push(module.format((focusWorn || pouch) ? "components.graspNoHand" : "components.material", { name : actor.name, spell : item.name }));
        /* No free hand already said : not again for S */
        if(focusWorn || pouch) somaticDone = true;
      }
    }
    if(!somaticDone && !freeHand) out.push(module.format("components.somatic", { name : actor.name, spell : item.name }));
    out.push(...this.costlyProblems(activity));
    return out;
  }

  /* ---------- Costly materials (setting) ---------- */

  static material(activity){
    const m = activity?.item?.system?.materials ?? {};
    const text = String(m.value ?? "");
    /* No cost filled in, but one in the text ("worth 10+ GP") : that one */
    let cost = Number(m.cost) || 0;
    const worth = !cost && /worth\s*([\d,]+)\s*\+?\s*(pp|gp|ep|sp|cp)\b/i.exec(text);
    if(worth) cost = Number(worth[1].replace(/,/g, "")) / (CONFIG.DND5E.currencies?.[worth[2].toLowerCase()]?.conversion ?? 1);
    return { text, cost, consumed : !!m.consumed || /\bconsume/i.test(text) };
  }

  /* An inventory item named in the material text, worth at least its cost (each) */
  static materialItem(actor, text, cost){
    const words = (text.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter(w => !this.STOP_WORDS.has(w));
    if(!words.length) return null;
    const gp = item => {
      const price = item.system?.price ?? {};
      const rate = CONFIG.DND5E.currencies?.[price.denomination ?? "gp"]?.conversion ?? 1;
      return (Number(price.value) || 0) / rate;
    };
    return actor.items.find(i => ["loot", "consumable", "equipment", "tool"].includes(i.type) && (Number(i.system.quantity ?? 1) > 0)
      && words.some(w => i.name.toLowerCase().includes(w)) && (gp(i) >= cost)) ?? null;
  }

  static canAfford(actor, cost){
    const manager = dnd5e.applications?.CurrencyManager;
    if(!manager?.getActorCurrencyUpdates) return true;
    try { return !manager.getActorCurrencyUpdates(actor, cost, "gp", { recursive : true }).remainder; }
    catch { return false; }
  }

  static costlyProblems(activity){
    const mode = this.mode();
    const { text, cost } = this.material(activity);
    if((mode === "off") || !(cost > 0) || !this.needs(activity).m) return [];
    const actor = activity.actor;
    /* The material is the focus itself (Bless's Holy Symbol) : an equipped focus is it */
    if(/holy symbol|spellcasting focus|\bfocus\b/i.test(text) && actor.items.some(i => i.system?.properties?.has?.("foc") && i.system.equipped)) return [];
    if(mode === "item" && !this.materialItem(actor, text, cost)) return [module.format("components.costlyItem", { name : actor.name, material : text })];
    if(mode === "coins" && !this.canAfford(actor, cost)) return [module.format("components.costlyCoins", { name : actor.name, cost, spell : activity.item.name })];
    return [];
  }

  /* ---------- The step and the spending ---------- */

  static async step(activity, ctx, next){
    /* Not a casting (the shard of a cast Ice Knife, Witch Bolt's later turns, a leap) */
    if(ctx.config?.[module.id]?.noCast) return next();
    const found = this.problems(activity, ctx.config);
    if(found.length && !limits.allow(found.join(" "), { who : activity.actor.name, what : activity.item.name })) return;
    return next();
  }

  /* Cast : a consumed costly material is used up (the item, or the coins) */
  static async spend(activity, usage, results){
    if(!this.enabled() || !results || (activity?.item?.type !== "spell") || !activity.actor?.isOwner) return;
    const { text, cost, consumed } = this.material(activity);
    const mode = this.mode();
    if(!consumed || !(cost > 0) || (mode === "off") || !this.needs(activity, usage).m) return;
    const actor = activity.actor;
    try {
      if(mode === "item"){
        const item = this.materialItem(actor, text, cost);
        if(!item) return;
        const left = (Number(item.system.quantity) || 1) - 1;
        if(left > 0) await item.update({ "system.quantity" : left });
        else await item.delete();
      }
      else if(mode === "coins") await dnd5e.applications.CurrencyManager.deductActorCurrency(actor, cost, "gp", { recursive : true });
    } catch(error){ log.debug("Costly material", error); }
  }
}
