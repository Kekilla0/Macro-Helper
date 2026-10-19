import { module } from '../../module.js';
import { logger } from '../../log.js';
import { idOf, chooseOption, originItem } from '../../helpers/utils.js';
import { rollSave } from '../../helpers/actors.js';
import { forcedMove } from '../../helpers/tokens.js';
import { onHit, hitOf } from '../../roll-item/hit-bonus.js';
import { giveCondition } from '../../roll-item/card-builder.js';
import { conditions } from '../conditions.js';
import { monk } from '../classes/monk.js';
import { subclasses } from './common.js';
const log = logger.for(import.meta.url);

/**
 * Monk subclasses, level 3 (Subclasses setting). Manipulate Elements, the Shadow's Darkness and Minor Illusion, Hand of
 * Healing and Implements of Mercy are the items' data. The Monk's save DC : 8 + WIS + Proficiency.
 *
 *   Elements  Elemental Attunement  while it's on (the item's enchantment, or an effect from it) : the Unarmed Strike's
 *                                   reach is 10 ft longer; a hit with it : Elemental Strike on the card : the damage
 *                                   becomes Acid, Cold, Fire, Lightning or Thunder (chosen), then a Strength save, and
 *                                   on a failure the target is moved 10 ft toward or away (chosen). It ends when the
 *                                   Monk is Incapacitated.
 *   Mercy     Hand of Harm          once a turn, an Unarmed Strike hit : a Focus Point, Martial Arts die + WIS Necrotic.
 *   Open Hand Open Hand Technique   a hit from Flurry of Blows : Addle (no Opportunity Attacks until the start of its
 *                                   next turn), Push (STR save or 15 ft away) or Topple (DEX save or Prone).
 */
export class monkTraditions{
  static ATTUNEMENT = "elemental-attunement";
  static HARM = "hand-of-harm";
  static OPEN_HAND = "open-hand-technique";
  static ELEMENTS = ["acid", "cold", "fire", "lightning", "thunder"];

  static enabled(){
    return subclasses.enabled();
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    const unarmed = hit => idOf(hit.item) === monk.UNARMED;
    onHit({ id : this.HARM, feature : this.HARM, icon : "fa-hand-holding-droplet", enabled : () => this.enabled(), once : "turn",
      when : hit => unarmed(hit), cost : hit => ({ item : monk.focusOf(hit.actor), amount : 1 }),
      formula : hit => `1d${monk.facesOf(hit.actor)} + @abilities.wis.mod`, types : () => ["necrotic"] });
    Hooks.on(`${module.id}.reach`, (item, more) => { if(this.enabled() && (idOf(item) === monk.UNARMED) && this.attuned(item.actor)) more.feet += 10; });
    Hooks.on(`${module.id}.cardButtons`, (message, buttons, { ray } = {}) => this.cardButtons(message, buttons, ray ?? null));
    Hooks.on(`${module.id}.cardButton`, (message, id, { ray } = {}) => this.cardClicked(message, String(id), ray ?? null));
    conditions.endOnIncapacitated(this.ATTUNEMENT);
    /* Its enchantment is on the item itself : ended by hand when the Monk is Incapacitated */
    for(const hook of ["createActiveEffect", "updateActiveEffect"]) Hooks.on(hook, effect => this.attunementEnds(effect));
  }

  static dcOf(actor){
    return 8 + (Number(actor?.system?.abilities?.wis?.mod) || 0) + (Number(actor?.system?.attributes?.prof) || 0);
  }

  /* ---------- Elements ---------- */

  /* Its enchantment on the item, or an effect from it on the Monk */
  static attunements(actor){
    const item = subclasses.has(actor, this.ATTUNEMENT);
    if(!item) return [];
    /* the item's own enchantment is only the profile its activity applies : the applied copies count */
    const enchantments = new Set([...item.effects.filter(e => e.isAppliedEnchantment), ...(item.system?.appliedEnchantments ?? [])]);
    return [...[...enchantments].filter(e => !e.disabled && !e.isSuppressed),
      ...(actor.appliedEffects ?? []).filter(e => originItem(e) === item)];
  }

  static attuned(actor){
    return this.attunements(actor).length > 0;
  }

  static async attunementEnds(effect){
    if(!this.enabled() || !game.users.activeGM?.isSelf) return;
    const actor = (effect?.parent?.documentName === "Actor") ? effect.parent : effect?.parent?.actor;
    if(!actor || !conditions.INCAPACITATING.some(s => actor.statuses?.has?.(s))) return;
    for(const e of this.attunements(actor)) if(e.parent?.documentName === "Item") await e.delete();
  }

  /* ---------- Card buttons : Elemental Strike, Open Hand Technique ---------- */

  static #done = new Set();

  static cardButtons(message, buttons, ray){
    const hit = this.enabled() ? hitOf(message, ray) : null;
    if(!hit?.actor?.isOwner || !hit.target || (idOf(hit.item) !== monk.UNARMED)) return;
    const key = `${message.id}|${ray}`;
    if(this.attuned(hit.actor) && !this.#done.has(`e|${key}`)) buttons.push({ id : "elemental", icon : "fa-fire-flame-curved", label : module.i18n("subclasses.monk.elemental") });
    if(message.getFlag(module.id, "flurry") && subclasses.has(hit.actor, this.OPEN_HAND) && !this.#done.has(`o|${key}`)){
      buttons.push({ id : "openHand", icon : "fa-hand", label : subclasses.has(hit.actor, this.OPEN_HAND).name });
    }
  }

  static async cardClicked(message, id, ray){
    if(!["elemental", "openHand"].includes(id)) return;
    const hit = hitOf(message, ray);
    if(!hit?.actor?.isOwner || !hit.target) return;
    const key = `${id === "elemental" ? "e" : "o"}|${message.id}|${ray}`;
    if(this.#done.has(key)) return;
    try {
      if(id === "elemental") await this.elementalStrike(hit, key);
      else await this.openHand(hit, key);
    }
    catch(error){ log.error(error); ui.notifications.warn(error.message); }
  }

  static async elementalStrike(hit, key){
    const type = await chooseOption({ title : module.i18n("subclasses.monk.elemental"), icon : "fa-solid fa-fire-flame-curved",
      prompt : module.i18n("subclasses.monk.elementPrompt"), options : this.ELEMENTS.map(t => ({ value : t, label : game.i18n.localize(CONFIG.DND5E.damageTypes[t]?.label ?? t) })) });
    if(!type) return;
    this.#done.add(key);
    await hit.message.system.setDamageType?.(type, hit.ray);
    const item = subclasses.has(hit.actor, this.ATTUNEMENT);
    const save = await rollSave(hit.target, "str", this.dcOf(hit.actor), { from : item });
    if(!save || save.success) return;
    const direction = await chooseOption({ title : item.name, icon : "fa-solid fa-arrows-left-right", prompt : module.format("subclasses.monk.movePrompt", { name : hit.target.name }),
      options : [{ value : "away", label : module.i18n("subclasses.monk.away") }, { value : "toward", label : module.i18n("subclasses.monk.toward") }, { value : "none", label : module.i18n("subclasses.monk.stay") }] });
    if(["away", "toward"].includes(direction)) await forcedMove(hit.target, { direction, feet : 10, from : hit.token, item, name : item.name });
  }

  static async openHand(hit, key){
    const item = subclasses.has(hit.actor, this.OPEN_HAND);
    const choice = await chooseOption({ title : item.name, icon : "fa-solid fa-hand", options : ["addle", "push", "topple"]
      .map(value => ({ value, label : module.i18n(`subclasses.monk.${value}`) })) });
    if(!choice) return;
    this.#done.add(key);
    const dc = this.dcOf(hit.actor);
    if(choice === "addle") await subclasses.giveEffect(hit.target, { name : module.i18n("subclasses.monk.addled"),
      flags : { [module.id] : { rule : { noOpportunity : true } } } }, { from : item, until : "turnStart", of : hit.target.actor });
    else if(choice === "topple") await giveCondition(hit.target, "prone", { save : "dex", dc, from : item, by : hit.token });
    else {
      const save = await rollSave(hit.target, "str", dc, { from : item });
      if(save && !save.success) await forcedMove(hit.target, { direction : "away", feet : 15, from : hit.token, item, name : item.name });
    }
    log.debug("Open Hand Technique", hit.actor.name, choice);
  }
}
