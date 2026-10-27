import { module } from '../../module.js';
import { logger } from '../../log.js';
import { idOf, esc, ownerIds, chooseOption } from '../../helpers/utils.js';
import { addTimedEffect, usedThisTurn, markUsedThisTurn } from '../../helpers/actors.js';
import { tokenOf, distanceBetween, getRange } from '../../helpers/tokens.js';
import { pickTargets } from '../../helpers/targets.js';
import { onHit } from '../../roll-item/hit-bonus.js';
import { cardBuilder } from '../../roll-item/card-builder.js';
import { TYPES } from '../../roll-item/message.js';
import { restChoices } from '../rest-choices.js';
import { subclasses } from './common.js';
const log = logger.for(import.meta.url);

/**
 * Ranger subclasses, level 3 (Subclasses setting). The subclass spells are the import's; Primal Companion's summon,
 * Otherworldly Glamour's bonus, Dread Ambusher's Initiative bonus and Umbral Sight's Darkvision are the items' data.
 *
 *   Fey Wanderer  Dreadful Strikes  a weapon hit : 1d4 Psychic (1d6 from level 11), each creature once a turn.
 *   Gloom Stalker Dread Ambusher    Ambusher's Leap : +10 ft Speed on its first turn of each combat. Dreadful Strike : once a
 *                                   turn, a weapon hit : 2d6 Psychic (the activity's uses : WIS mod a Long Rest).
 *   Hunter        Hunter's Lore     a creature it marks with Hunter's Mark : its Immunities, Resistances and
 *                                   Vulnerabilities, to the Ranger's owner only.
 *                 Hunter's Prey     Colossus Slayer (once a turn, a weapon hit on a creature missing Hit Points : 1d8 of
 *                                   the weapon's type) or Horde Breaker (once on each of its turns, after a weapon attack :
 *                                   another attack with it against a different creature within 5 ft of the first). The
 *                                   first button used is the choice; a Short or Long Rest may change it (Rest Choices).
 */
export class rangerConclaves{
  static DREADFUL_STRIKES = "dreadful-strikes";
  static AMBUSHER = "dread-ambusher";
  static PREY = "hunters-prey";
  static LORE = "hunters-lore";

  static enabled(){
    return subclasses.enabled();
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    onHit({ id : this.DREADFUL_STRIKES, feature : this.DREADFUL_STRIKES, icon : "fa-face-grimace", enabled : () => this.enabled(), once : "target",
      when : hit => hit.weapon && !idOf(hit.item).startsWith("unarmed"),
      formula : hit => this.scaleOf(hit.actor, "fey-wanderer", "dreadful-strike") ?? ((Number(hit.actor.classes?.ranger?.system?.levels) >= 11) ? "1d6" : "1d4"),
      types : () => ["psychic"] });
    onHit({ id : "dreadful-strike", feature : this.AMBUSHER, icon : "fa-ghost", enabled : () => this.enabled(), once : "turn",
      when : hit => hit.weapon && !idOf(hit.item).startsWith("unarmed"),
      cost : hit => ({ activity : this.dreadfulActivity(hit.actor), amount : 1 }),
      formula : hit => this.scaleOf(hit.actor, "gloom-stalker", "dreadful-strike") ?? "2d6", types : () => ["psychic"],
      label : hit => this.dreadfulActivity(hit.actor)?.name || "Dreadful Strike" });
    onHit({ id : "colossus-slayer", feature : this.PREY, icon : "fa-mountain", enabled : () => this.enabled(), once : "turn",
      when : hit => hit.weapon && (this.preyOf(hit.actor) !== "horde") && this.missingHP(hit.target),
      formula : () => "1d8", label : () => module.i18n("subclasses.ranger.colossus"),
      after : hit => this.choosePrey(hit.actor, "colossus") });
    Hooks.on(`${module.id}.turnStart`, (combat, combatant) => this.ambushersLeap(combat, combatant));
    Hooks.on(`${module.id}.cardButtons`, (message, buttons, { ray } = {}) => this.hordeButton(message, buttons, ray ?? null));
    Hooks.on(`${module.id}.cardButton`, (message, id, { ray } = {}) => { if(id === "hordeBreaker") this.hordeBreaker(message, ray ?? null); });
    Hooks.on("createActiveEffect", (effect, options, userId) => this.huntersLore(effect, userId));
    restChoices.add({
      id : "huntersPrey", label : "subclasses.ranger.preyChoice", rest : "short",
      applies : actor => this.enabled() && !!subclasses.has(actor, this.PREY),
      grant : actor => subclasses.has(actor, this.PREY)?.setFlag(module.id, "preySwap", true),
      summary : actor => module.i18n(`subclasses.ranger.${this.preyOf(actor) ?? "unchosen"}`),
      state : actor => [this.preyOf(actor)].filter(Boolean).map(prey => module.i18n(`subclasses.ranger.${prey}`)),
      open : actor => this.swapPrey(actor),
    });
  }

  /* A dice scale of the subclass's, as a formula */
  static scaleOf(actor, subclass, id){
    const scale = actor?.system?.scale?.[subclass]?.[id];
    return scale?.formula || (scale?.faces ? `${scale.number ?? 1}d${scale.faces}` : null);
  }

  /* ---------- Gloom Stalker ---------- */

  static dreadfulActivity(actor){
    const item = subclasses.has(actor, this.AMBUSHER);
    return [...(item?.system?.activities ?? [])].find(a => (a.type === "damage") && a.uses?.max) ?? null;
  }

  /* Its first turn of each combat : +10 ft Speed until that turn ends */
  static async ambushersLeap(combat, combatant){
    const actor = combatant?.actor;
    if(!this.enabled() || !game.users.activeGM?.isSelf || !subclasses.has(actor, this.AMBUSHER)) return;
    if(combat.getFlag?.(module.id, `leap.${combatant.id}`)) return;
    await combat.setFlag(module.id, `leap.${combatant.id}`, true);
    await addTimedEffect(actor, { name : module.i18n("subclasses.ranger.leap"), img : subclasses.has(actor, this.AMBUSHER).img,
      changes : [{ key : "system.attributes.movement.speeds.walk", type : "add", mode : 2, value : "10" }] }, { until : "turnEnd", thisTurn : true });
  }

  /* ---------- Hunter ---------- */

  static missingHP(token){
    const hp = token?.actor?.system?.attributes?.hp;
    return !!hp && (Number(hp.value) < Number(hp.max));
  }

  static preyOf(actor){
    return subclasses.has(actor, this.PREY)?.getFlag(module.id, "prey") ?? null;
  }

  /* The first one used is the choice */
  static async choosePrey(actor, prey){
    const item = subclasses.has(actor, this.PREY);
    if(item && !this.preyOf(actor)) await item.setFlag(module.id, "prey", prey);
  }

  static async swapPrey(actor){
    const item = subclasses.has(actor, this.PREY);
    if(!item) return;
    if(!game.user.isGM && !item.getFlag(module.id, "preySwap") && this.preyOf(actor)) return ui.notifications.warn(module.format("subclasses.ranger.noSwap", { name : actor.name }));
    const prey = await chooseOption({ title : item.name, icon : "fa-solid fa-crosshairs", value : this.preyOf(actor) ?? "colossus",
      options : ["colossus", "horde"].map(value => ({ value, label : module.i18n(`subclasses.ranger.${value}`) })) });
    if(prey) await item.update({ [`flags.${module.id}.prey`] : prey, [`flags.${module.id}.preySwap`] : false });
  }

  /* Horde Breaker : after a weapon attack on its own turn, once a turn */
  static hordeButton(message, buttons, ray){
    if(!this.enabled() || (message.type !== TYPES.attack) || !message.system?.attackOf?.(ray)) return;
    const actor = message.getAssociatedActor?.();
    const item = message.getAssociatedItem?.();
    if(!actor?.isOwner || (item?.type !== "weapon") || !subclasses.has(actor, this.PREY) || (this.preyOf(actor) === "colossus")) return;
    if(usedThisTurn(actor, "hordeBreaker") || (game.combat?.started && (game.combat.combatant?.actor !== actor))) return;
    buttons.push({ id : "hordeBreaker", icon : "fa-people-group", label : module.i18n("subclasses.ranger.horde") });
  }

  static async hordeBreaker(message, ray){
    const actor = message.getAssociatedActor?.();
    const weapon = message.getAssociatedItem?.();
    const me = tokenOf(actor);
    const { TargetsField } = dnd5e.dataModels.chatMessage.fields;
    const first = tokenOf(TargetsField.resolve((message.system.targetsOf?.(ray) ?? [])[0] ?? {})?.token);
    if(!me || !weapon || !first || usedThisTurn(actor, "hordeBreaker")) return;
    const [other] = await pickTargets(me, { count : 1, range : getRange(weapon), disposition : "nonAlly", confirm : "auto", useTargets : false,
      filter : t => (t !== first) && (distanceBetween(t, first) <= 5) }) ?? [];
    if(!other) return;
    await markUsedThisTurn(actor, "hordeBreaker");
    await this.choosePrey(actor, "horde");
    await cardBuilder.roll(weapon, { use : false, targets : [other] });
  }

  /* Hunter's Lore : the marked creature's defences, to the Ranger's owner */
  static async huntersLore(effect, userId){
    const mark = effect?.getFlag?.(module.id, "huntersMark");
    if(!this.enabled() || !mark || (userId !== game.user.id)) return;
    const caster = fromUuidSync(mark.caster ?? "", { strict : false });
    const target = effect.parent;
    if(!subclasses.has(caster, this.LORE) || !target?.system?.traits) return;
    const list = key => {
      const trait = target.system.traits[key];
      const values = [...(trait?.value ?? [])].map(t => game.i18n.localize(CONFIG.DND5E.damageTypes[t]?.label ?? CONFIG.DND5E.conditionTypes?.[t]?.name ?? CONFIG.DND5E.conditionTypes?.[t]?.label ?? t));
      if(trait?.custom) values.push(trait.custom);
      return values.length ? values.join(", ") : module.i18n("subclasses.ranger.none");
    };
    const rows = [["di", "immune"], ["ci", "conditionImmune"], ["dr", "resist"], ["dv", "vulnerable"]]
      .map(([key, label]) => `<li><strong>${esc(module.i18n(`subclasses.ranger.${label}`))}</strong> : ${esc(list(key))}</li>`);
    await ChatMessage.implementation.create({
      speaker : ChatMessage.implementation.getSpeaker({ actor : caster }),
      whisper : [...new Set([...ownerIds(caster), ...game.users.filter(u => u.isGM).map(u => u.id)])],
      content : `<p>${esc(module.format("subclasses.ranger.lore", { name : target.name }))}</p><ul>${rows.join("")}</ul>`,
    });
    log.debug("Hunter's Lore", caster.name, target.name);
  }
}
