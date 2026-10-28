import { module } from '../../module.js';
import { logger } from '../../log.js';
import { idOf, originItem } from '../../helpers/utils.js';
import { tokenOf, distanceBetween, canSee, isIncapacitated } from '../../helpers/tokens.js';
import { isAlly } from '../../helpers/targets.js';
import { spendUses } from '../../helpers/items.js';
import { onHit } from '../../roll-item/hit-bonus.js';
import { cutDamage, cutsOf } from '../../roll-item/damage-cuts.js';
import { cardBuilder, reactionMoveRows } from '../../roll-item/card-builder.js';
import { uses } from '../../uses.js';
import { TYPES } from '../../roll-item/message.js';
import { itemFixes } from '../item-fixes.js';
import { casting } from '../casting.js';
import { actionTracker } from '../action-tracker.js';
import { repeating } from '../repeating.js';
import { spellEffects } from '../spell-effects.js';
import { bard } from '../classes/bard.js';
import { subclasses } from './common.js';
import { itemOf } from '../../helpers/actors.js';
const log = logger.for(import.meta.url);

/**
 * Bard subclasses, level 3 (Subclasses setting). Bardic Damage's own Unarmed Strike (DEX, the Bardic Inspiration die
 * + DEX), Mantle of Inspiration's temporary Hit Points, Bonus Proficiencies and Martial Training are the items' data.
 *
 *   Dance   Agile Strikes        a use of Bardic Inspiration spent (Inspire, Mantle, Cutting Words...) : a card offers
 *                                one Unarmed Strike (Bardic Damage's, else the Unarmed Strike), part of that action.
 *           Unarmored Defense    no armor, no shield : 10 + DEX + CHA (dnd5e's Bard formula; Plutonium's item has no
 *                                effect : one is added).
 *   Glamour Mantle of Inspiration its creatures (the card's targets) : a card with a Move button each (its player, the
 *                                reactionMove lego) : its Reaction spent, up to its Speed this turn, no Opportunity
 *                                Attacks.
 *           Beguiling Magic      after casting an Enchantment or Illusion spell with a slot, its use left : a card
 *                                offers its save (a creature within 60 ft) : Charmed or Frightened (the effect chosen),
 *                                the save again at the end of each of its turns (Spells : repeating effects).
 *   Lore    Cutting Words        a creature the Bard sees within 60 ft hits with an attack roll : Cutting Words on the
 *                                card (its Reaction, a Bardic Inspiration use) takes the die off the attack roll (the
 *                                card judges it again) or off its damage; on a successful ability check, off the check.
 *   Valor   Combat Inspiration   a creature holding this Bard's die : hit by an attack, Combat Inspiration (its
 *                                Reaction) adds the die to its AC against it; hitting, the die as extra damage. The die
 *                                is used up either way.
 */
export class bardColleges{
  static AGILE = "agile-strikes";
  static BARDIC_DAMAGE = "bardic-damage";
  static BEGUILING = "beguiling-magic";
  static MANTLE = "mantle-of-inspiration";
  static CUTTING = "cutting-words";
  static COMBAT = "combat-inspiration";
  static SCHOOLS = ["enc", "ill"];

  static enabled(){
    return subclasses.enabled();
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    /* Agile Strikes : a Bardic Inspiration use spent */
    Hooks.on("preUpdateItem", item => { if(idOf(item) === bard.BARDIC) this.#spent.set(item.uuid, Number(item.system.uses?.spent) || 0); });
    Hooks.on("updateItem", (item, changes, options, userId) => this.onInspirationSpent(item, changes, userId));
    subclasses.onOffer("agileStrike", actor => this.agileStrike(actor));
    itemFixes.add({ name : "Dance Unarmored Defense", where : "owned", plan : item => this.unarmoredFix(item) });
    itemFixes.add({ name : "Beguiling Magic", where : "owned", plan : item => this.beguilingFix(item) });
    /* Beguiling Magic : Charmed or Frightened (one of its effects, chosen), the save again at the end of its turns */
    spellEffects.CHOICES[this.BEGUILING] ??= { prompt : "subclasses.bard.beguilingChoice" };
    repeating.TABLE[this.BEGUILING] ??= { label : "end", roll : { type : "save", ability : "wis" } };
    Hooks.on("dnd5e.postUseActivity", (activity, usage) => this.afterSpell(activity, usage));
    /* Mantle of Inspiration : its creatures may move with their Reaction */
    Hooks.on("dnd5e.postUseActivity", (activity, usage, results) => this.mantle(activity, results));
    /* Cutting Words */
    Hooks.on(`${module.id}.cardButtons`, (message, buttons, { ray } = {}) => { this.cuttingButtons(message, buttons, ray ?? null); this.defenseButtons(message, buttons, ray ?? null); });
    Hooks.on(`${module.id}.cardButton`, (message, id, { ray } = {}) => this.cardClicked(message, String(id), ray ?? null));
    Hooks.on(`${module.id}.rerollButtons`, (message, buttons, { actor, roll }) => this.checkButtons(message, buttons, actor, roll));
    /* Combat Inspiration : Offense */
    onHit({ id : "combat-inspiration", icon : "fa-music", enabled : () => this.enabled(),
      feature : actor => this.valorDie(actor) ? true : null,
      label : hit => module.format("subclasses.bard.offense", { die : this.valorDie(hit.actor)?.die ?? "" }),
      formula : hit => this.valorDie(hit.actor)?.die ?? "1d6",
      after : hit => this.useUp(hit.actor) });
  }

  /* The Bard's Bardic Inspiration item */
  static inspirationItem(actor){
    return itemOf(actor, bard.BARDIC);
  }

  /* ---------- Dance ---------- */

  static async onInspirationSpent(item, changes, userId){
    if(!this.enabled() || (userId !== game.user.id) || (idOf(item) !== bard.BARDIC)) return;
    const spent = foundry.utils.getProperty(changes ?? {}, "system.uses.spent");
    const before = this.#spent.get(item.uuid);
    this.#spent.delete(item.uuid);
    if((spent === undefined) || (before === undefined) || !(Number(spent) > before) || !itemOf(item.actor, this.AGILE)) return;
    await subclasses.offer(item.actor, { key : "agileStrike", label : module.i18n("subclasses.bard.agileStrike"),
      text : module.format("subclasses.bard.agileText", { name : item.actor.name }) });
  }

  static #spent = new Map();

  /* One Unarmed Strike, part of the action that spent the die (no use of its own) */
  static async agileStrike(actor){
    const feature = itemOf(actor, this.BARDIC_DAMAGE);
    const own = [...(feature?.system?.activities ?? [])].find(a => a.type === "attack");
    if(own) return !!await cardBuilder.roll(feature, { use : false, attack : own });
    const unarmed = itemOf(actor, "unarmed-strike");
    if(!unarmed){ ui.notifications.warn(module.format("subclasses.bard.noUnarmed", { name : actor.name })); return false; }
    return !!await cardBuilder.roll(unarmed, { use : false });
  }

  /* The College of Dance's Unarmored Defense : dnd5e's Bard formula (Plutonium's item has no effect) */
  /* Plutonium's save spends a Bardic Inspiration use : it's the feature's own use (only the recharge costs one) */
  static beguilingFix(item){
    if(!this.enabled() || (idOf(item) !== this.BEGUILING) || !item.actor) return null;
    const other = t => (t.type === "itemUses") && t.target && (t.target !== item.id);
    const update = {};
    for(const activity of item.system.activities ?? []){
      const targets = [...(activity.consumption?.targets ?? [])];
      if((activity.type !== "save") || !targets.some(other)) continue;
      update[`system.activities.${activity.id}.consumption.targets`] = targets.map(t => {
        const data = foundry.utils.deepClone(t.toObject?.() ?? t);
        return other(t) ? { ...data, target : "" } : data;
      });
    }
    return Object.keys(update).length ? { update } : null;
  }

  static unarmoredFix(item){
    const actor = item?.actor;
    if(!this.enabled() || (idOf(item) !== "unarmored-defense") || !actor?.classes?.bard) return null;
    const dance = actor.items.some(i => (i.type === "subclass") && /dance/i.test(idOf(i) || i.name));
    if(!dance || item.effects.size) return null;
    if(actor.classes.monk || actor.classes.barbarian) return null;
    return { create : { effects : [{ _id : foundry.utils.randomID(), name : item.name, img : item.img, transfer : true,
      changes : [{ key : "system.attributes.ac.calc", type : "override", mode : 5, value : "unarmoredBard" }] }] } };
  }

  /* ---------- Glamour : Beguiling Magic ---------- */

  static async afterSpell(activity, usage){
    const actor = activity?.actor;
    const spell = activity?.item;
    if(!this.enabled() || !actor?.isOwner || (spell?.type !== "spell") || !this.SCHOOLS.includes(spell.system?.school)) return;
    if(!casting.spendsSlot(activity, usage ?? {})) return;
    const item = itemOf(actor, this.BEGUILING);
    if(!item || !(Number(item.system.uses?.value) > 0)) return;
    const save = [...(item.system.activities ?? [])].find(a => a.type === "save");
    if(!save) return;
    await subclasses.offer(actor, { item, activity : save.id, text : module.format("subclasses.bard.beguiling", { name : actor.name, spell : spell.name }) });
  }

  /* Mantle of Inspiration used : a Move button for each creature it chose (not the Bard) */
  static async mantle(activity, results){
    const actor = activity?.actor;
    if(!this.enabled() || !actor?.isOwner || (idOf(activity?.item) !== this.MANTLE) || !results) return;
    const card = await uses.cardOf(results);
    const resolve = t => dnd5e.dataModels.chatMessage.fields.TargetsField.resolve(t)?.token;
    let tokens = (card?.system?.targets ?? []).map(t => tokenOf(resolve(t))).filter(Boolean);
    if(!tokens.length) tokens = [...game.user.targets];
    tokens = tokens.filter(t => t.actor && (t.actor !== actor));
    if(tokens.length) await reactionMoveRows(actor, activity.item, tokens, { noOA : true, text : module.i18n("subclasses.bard.mantleMove") });
  }

  /* ---------- Lore : Cutting Words ---------- */

  /* This user's Lore Bards that can react to that creature : within 60 ft, seeing it, Reaction and a die left */
  static cutters(creature){
    if(!this.enabled() || !creature) return [];
    return (canvas.tokens?.placeables ?? []).filter(t => t.actor?.isOwner && (t !== creature) && itemOf(t.actor, this.CUTTING)
      && !isAlly(t, creature) && (distanceBetween(t, creature) <= 60) && canSee(t, creature) && actionTracker.left(t.actor, "reaction")
      && !isIncapacitated(t) && (Number(this.inspirationItem(t.actor)?.system?.uses?.value) > 0));
  }

  static cuttingButtons(message, buttons, ray){
    if((message.type !== TYPES.attack) || !message.system?.isHitOn?.(ray)) return;
    const attacker = tokenOf(message.getAssociatedToken?.() ?? message.getAssociatedActor?.());
    for(const t of this.cutters(attacker)){
      if(this.#cut.has(`${message.id}|${ray}`)) break;
      buttons.push({ id : `cutAttack|${t.document.uuid}`, icon : "fa-comment-slash", label : module.i18n("subclasses.bard.cutAttack") });
      if(!cutsOf(message, "all").some(c => c.id === this.CUTTING)) buttons.push({ id : `cutDamage|${t.document.uuid}`, icon : "fa-comment-slash", label : module.i18n("subclasses.bard.cutDamage") });
    }
  }

  /* Cut already (this client : without the Action Tracker the Reaction doesn't hide the button) */
  static #cut = new Set();

  /* The die rolled, its use and the Reaction spent */
  static async cutRoll(token, message = null){
    const item = this.inspirationItem(token.actor);
    if(!item || !await spendUses(item, 1)) return null;
    const roll = await new Roll(bard.dieOf(item)).evaluate();
    const { rollItem } = await import('../../roll-item/roll-item.js');
    await rollItem.showDice([roll], message);
    await actionTracker.spend(token.actor, { kind : "reaction", what : itemOf(token.actor, this.CUTTING)?.name ?? "" }).catch(() => null);
    return roll;
  }

  static async cardClicked(message, id, ray){
    const [kind, uuid] = id.split("|");
    if(!["cutAttack", "cutDamage", "valorAC"].includes(kind)) return;
    const token = tokenOf(fromUuidSync(uuid ?? "", { strict : false }));
    if(!token?.actor?.isOwner) return;
    if(kind === "valorAC") return this.defend(message, ray, token);
    const attacker = tokenOf(message.getAssociatedToken?.() ?? message.getAssociatedActor?.());
    if(!this.cutters(attacker).includes(token) || this.#cut.has(`${message.id}|${ray}`)) return;
    this.#cut.add(`${message.id}|${ray}`);
    const roll = await this.cutRoll(token, message);
    if(!roll) return;
    const label = itemOf(token.actor, this.CUTTING)?.name ?? "Cutting Words";
    if(kind === "cutAttack") await subclasses.changeRoll(message, { ray, subtract : String(roll.total) }, token.actor);
    else await cutDamage(message, "all", { id : this.CUTTING, amount : roll.total, by : token.name, label, formula : roll.formula, result : roll.result });
    log.debug("Cutting Words", token.name, kind, roll.total);
  }

  /* A successful ability check by a creature the Bard sees within 60 ft */
  static checkButtons(message, buttons, actor, roll){
    if((message?.type !== "check") || message.getFlag?.("core", "initiativeRoll") || message.getFlag?.(module.id, "cuttingWords")) return;
    const target = roll?.options?.target;
    if(Number.isFinite(target) && (roll.total < target)) return;
    const creature = tokenOf(message.getAssociatedToken?.() ?? actor);
    for(const t of this.cutters(creature)){
      buttons.push({ id : `cutCheck-${t.id}`, icon : "fa-comment-slash", label : module.format("subclasses.bard.cutCheck", { name : t.name }),
        run : async () => {
          if(!this.cutters(creature).includes(t)) return;
          const cut = await this.cutRoll(t, message);
          if(!cut) return;
          await subclasses.changeRoll(message, { subtract : String(cut.total) }, t.actor);
        } });
    }
  }

  /* ---------- Valor : Combat Inspiration ---------- */

  /* This creature's Bardic Inspiration, when it's from a Valor Bard */
  static valorDie(actor){
    const inspiration = bard.inspirationOf(actor);
    if(!inspiration) return null;
    const from = originItem(inspiration.effect)?.actor
      ?? game.actors.find(a => (a.name === inspiration.by) && itemOf(a, this.COMBAT));
    return (from && itemOf(from, this.COMBAT)) ? inspiration : null;
  }

  static async useUp(actor){
    const inspiration = bard.inspirationOf(actor);
    if(inspiration?.effect?.isOwner) await inspiration.effect.delete();
  }

  /* Defense : hit by an attack, the die on its AC against it (its Reaction) */
  static defenseButtons(message, buttons, ray){
    if(!this.enabled() || (message.type !== TYPES.attack) || !message.system?.isHitOn?.(ray)) return;
    for(const t of (message.system.hitTargets?.(ray) ?? []).map(h => tokenOf(h))){
      if(!t?.actor?.isOwner || !this.valorDie(t.actor) || !actionTracker.left(t.actor, "reaction")) continue;
      buttons.push({ id : `valorAC|${t.document.uuid}`, icon : "fa-music",
        label : module.format("subclasses.bard.defense", { die : this.valorDie(t.actor).die, name : t.name }) });
    }
  }

  static async defend(message, ray, token){
    const inspiration = this.valorDie(token.actor);
    if(!inspiration) return;
    const roll = await new Roll(inspiration.die).evaluate();
    const { rollItem } = await import('../../roll-item/roll-item.js');
    await rollItem.showDice([roll], message);
    await subclasses.changeRoll(message, { ray, ac : { uuid : token.document.uuid, amount : roll.total } }, token.actor);
    await actionTracker.spend(token.actor, { kind : "reaction", what : module.i18n("subclasses.bard.combatInspiration") }).catch(() => null);
    await this.useUp(token.actor);
  }
}
