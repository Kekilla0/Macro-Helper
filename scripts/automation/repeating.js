import { module } from '../module.js';
import { settings } from '../settings.js';
import { logger } from '../log.js';
import { gm } from '../gm.js';
import { idOf, esc, buttonRow, addButton, makeButton } from '../helpers/utils.js';
import { itemFixes } from './item-fixes.js';
const log = logger.for(import.meta.url);

/**
 * Repeating effects (Characters → Spells) : an effect that comes back to its creature each turn, or lasts its time.
 * On the effect : flags["macro-helper"].repeat =
 *   { label : "start" | "end" | "time",                     start / end of a turn : a roll then; time : until its duration ends
 *     from : { item, actor },                                what it came from (uuids)
 *     roll : { type : "save" | "check", ability, skill, dc } what to roll (none for "time"), the DC from the item's save
 *     when : { at : "start" | "end", of },                   whose turn (actor uuid : the affected creature, unless the
 *                                                            spell says the caster's)
 *     damage : "1d6[fire]",                                  taken first, at that turn (Searing Smite, Ensnaring Strike)
 *     onFail : "unconscious",                                a failed roll turns it into that condition for the rest
 *                                                            of its duration, with no more rolls (Sleep)
 *     endsOnDamage : true }                                  it ends when the creature takes damage (Sleep)
 * The items carry a template (TABLE, put on their effects by an item fix), so the effect has it however it's applied
 * (a save card's row, dnd5e's effect tray); the rest is filled in as it lands on the creature. At that turn (combat),
 * the active GM posts a card : the affected creature's owner rolls (and takes the damage) from it; a success ends the
 * effect. "time" effects are removed once their duration has run out.
 */
export class repeating{
  /* 2024 spells, by identifier : label, what's rolled (action : it takes an action, offered at the turn), damage dice
     (one more a slot level above the spell's), whose turn ("caster" : the spell says the caster's, else the target's) */
  static TABLE = {
    "hold-person" : { label : "end", roll : { type : "save", ability : "wis" } },
    "wrathful-smite" : { label : "end", roll : { type : "save", ability : "wis" } },
    "searing-smite" : { label : "start", roll : { type : "save", ability : "con" }, damage : { die : "d6", type : "fire" } },
    "ensnaring-strike" : { label : "start", roll : { type : "check", ability : "str", skill : "ath", action : true }, damage : { die : "d6", type : "piercing" } },
    "ray-of-sickness" : { label : "time", of : "caster" },
    "chill-touch" : { label : "time", of : "caster" },
    /* 2024 Sleep : Incapacitated, the save again at the end of its next turn; failed : Unconscious; damage wakes it */
    "sleep" : { label : "end", roll : { type : "save", ability : "wis" }, onFail : "unconscious", endsOnDamage : true },
  };

  static enabled(){
    return (game.system.id === "dnd5e") && settings.value("spellRules");
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    itemFixes.add({ name : "Repeating effects", where : "owned", plan : item => this.templateFix(item) });
    Hooks.on("preCreateActiveEffect", (effect, data, options, userId) => { if(userId === game.user.id) this.fill(effect); });
    Hooks.on("combatTurnChange", (combat, prior, current) => this.onTurnEnd(combat, prior, current));
    /* The start of a turn once the order is settled (Initiative Each Round rolls first) */
    Hooks.on(`${module.id}.turnStart`, (combat, combatant) => this.onTurnStart(combat, combatant));
    Hooks.on("updateWorldTime", () => this.expireTimed());
    Hooks.on("renderChatMessageHTML", (message, html) => this.render(message, html));
    Hooks.on("dnd5e.applyDamage", (actor, amount) => this.onDamaged(actor, amount));
  }

  /* ---------- The template on the item's effects ---------- */

  static templateFix(item){
    if(!this.enabled() || (item?.type !== "spell") || (String(item.system?.source?.rules ?? "") === "2014")) return null;
    const entry = this.TABLE[idOf(item)];
    if(!entry) return null;
    const updateEffects = (item.effects?.contents ?? [...(item.effects ?? [])]).filter(e => !e.getFlag?.(module.id, "repeat"))
      .map(e => ({ _id : e.id, [`flags.${module.id}.repeat`] : { template : true, label : entry.label, roll : entry.roll ?? null, damage : entry.damage ?? null, of : entry.of ?? "target",
        onFail : entry.onFail ?? null, endsOnDamage : !!entry.endsOnDamage } }));
    return updateEffects.length ? { updateEffects } : null;
  }

  /* An effect with a template landing on a creature : what it came from, the DC, whose turn */
  static fill(effect){
    const repeat = effect.getFlag?.(module.id, "repeat");
    if(!repeat?.template || !(effect.parent?.documentName === "Actor")) return;
    const origin = effect.origin ? fromUuidSync(effect.origin, { strict : false }) : null;
    const item = (origin?.documentName === "Item") ? origin : (origin?.item ?? null);
    const caster = item?.actor ?? null;
    const save = [...(item?.system?.activities ?? [])].find(a => a.type === "save");
    const dc = Number(save?.save?.dc?.value) || Number(caster?.system?.attributes?.spell?.dc) || null;
    /* The damage grows with the slot (Searing Smite +1d6 a level above its own) */
    const castLevel = Number(effect.getFlag?.("dnd5e", "spellLevel")) || Number(item?.system?.level) || 1;
    const dice = Math.max(1, 1 + castLevel - (Number(item?.system?.level) || 1));
    const filled = {
      template : false,
      label : repeat.label,
      from : { item : item?.uuid ?? effect.origin ?? null, actor : caster?.uuid ?? null },
      roll : repeat.roll ? { ...repeat.roll, dc } : null,
      when : (repeat.label === "time") ? null : { at : repeat.label, of : (repeat.of === "caster") ? (caster?.uuid ?? null) : effect.parent.uuid },
      damage : repeat.damage ? `${dice}${repeat.damage.die}[${repeat.damage.type}]` : null,
      onFail : repeat.onFail ?? null,
      endsOnDamage : !!repeat.endsOnDamage,
    };
    /* Replaced whole (the template's own keys don't stay behind) */
    const flags = foundry.utils.deepClone(effect._source?.flags ?? effect.flags ?? {});
    flags[module.id] = { ...(flags[module.id] ?? {}), repeat : filled };
    effect.updateSource({ flags }, { recursive : false });
  }

  /* ---------- At the turn ---------- */

  static onTurnEnd(combat, prior, current){
    if(!game.users.activeGM?.isSelf) return;
    /* Same round and turn : the order was re-sorted (initiative rolled), nobody's turn ended */
    if((prior?.round === current?.round) && (prior?.turn === current?.turn)) return;
    this.due("end", combat.combatants.get(prior?.combatantId)?.actor?.uuid ?? null);
    this.expireTimed();
  }

  static onTurnStart(combat, combatant){
    if(!game.users.activeGM?.isSelf) return;
    this.due("start", combatant?.actor?.uuid ?? null);
  }

  /* The cards due at the start / end of that creature's turn */
  static due(label, uuid){
    if(!uuid) return;
    for(const actor of gm.actors()){
      for(const effect of actor.effects){
        const repeat = effect.getFlag(module.id, "repeat");
        if(repeat?.template || repeat?.done || (repeat?.label !== label) || (repeat.when?.of !== uuid)) continue;
        this.post(actor, effect, repeat).catch(error => log.error(error));
      }
    }
  }

  /* The card : what's due, with the affected creature's owner's buttons */
  static async post(actor, effect, repeat){
    const what = [];
    if(repeat.damage) what.push(module.format("repeating.damage", { damage : repeat.damage.replace(/\[(\w+)\]/, " $1") }));
    if(repeat.roll) what.push(this.rollLabel(repeat.roll));
    return ChatMessage.implementation.create({
      speaker : ChatMessage.implementation.getSpeaker({ actor }),
      content : `<p>${esc(module.format(`repeating.${repeat.label}`, { name : actor.name, effect : effect.name }))}${what.length ? ` ${esc(what.join(" · "))}` : ""}</p>`,
      flags : { [module.id] : { repeatCard : { actor : actor.uuid, effect : effect.uuid, damageDone : !repeat.damage, rolled : false } } },
    });
  }

  static rollLabel(roll){
    const ability = CONFIG.DND5E.abilities[roll.ability]?.label ?? roll.ability;
    const skill = roll.skill ? (CONFIG.DND5E.skills[roll.skill]?.label ?? roll.skill) : null;
    return module.format(roll.type === "save" ? "repeating.save" : "repeating.check", { ability : skill ? `${ability} (${skill})` : ability, dc : roll.dc ?? "?" })
      + (roll.action ? ` ${module.i18n("repeating.action")}` : "");
  }

  /* The card's buttons : for the affected creature's owner (the GM for monsters) */
  static render(message, html){
    const data = message.getFlag?.(module.id, "repeatCard");
    if(!data) return;
    const actor = fromUuidSync(data.actor, { strict : false });
    const effect = fromUuidSync(data.effect, { strict : false });
    const repeat = effect?.getFlag?.(module.id, "repeat");
    if(!actor?.isOwner) return;
    const row = buttonRow(html, { key : `${module.id}-repeat` });
    if(row.childElementCount) return;
    if(!effect){ return addButton(row, makeButton({ icon : "fa-check", text : module.i18n("repeating.ended"), disabled : true })); }
    if(repeat?.damage) addButton(row, makeButton({ icon : "fa-burst", text : module.format("repeating.take", { damage : repeat.damage.replace(/\[(\w+)\]/, " $1") }), once : true,
      disabled : !!data.damageDone, onClick : () => this.takeDamage(message, actor, repeat) }));
    if(repeat?.roll) addButton(row, makeButton({ icon : "fa-dice-d20", text : this.rollLabel(repeat.roll), once : true,
      disabled : !!data.rolled, onClick : () => this.roll(message, actor, effect, repeat) }));
  }

  static async takeDamage(message, actor, repeat){
    const roll = await new CONFIG.Dice.DamageRoll(repeat.damage, {}, {}).evaluate();
    await roll.toMessage({ speaker : ChatMessage.implementation.getSpeaker({ actor }), flavor : message.getFlag(module.id, "repeatCard") ? (fromUuidSync(message.getFlag(module.id, "repeatCard").effect, { strict : false })?.name ?? "") : "" });
    const type = repeat.damage.match(/\[(\w+)\]/)?.[1];
    await actor.applyDamage([{ value : roll.total, type }], { isDelta : true });
    await message.setFlag(module.id, "repeatCard.damageDone", true);
  }

  /* The roll : a success ends the effect on this creature */
  static async roll(message, actor, effect, repeat){
    const { type, ability, skill, dc } = repeat.roll;
    const config = { ability, skill, target : dc ?? undefined };
    const rolls = (type === "save") ? await actor.rollSavingThrow(config)
      : skill ? await actor.rollSkill({ skill, ability, target : dc ?? undefined }) : await actor.rollAbilityCheck(config);
    const roll = Array.isArray(rolls) ? rolls[0] : rolls;
    if(!roll) return;
    await message.setFlag(module.id, "repeatCard.rolled", true);
    const success = Number.isFinite(dc) ? (roll.total >= dc) : !!roll.isSuccess;
    if(success && effect && !effect.isDeleted){
      await effect.delete();
      ui.notifications.info(module.format("repeating.endedOn", { name : actor.name, effect : effect.name }));
    }
    /* Failed, and the effect worsens (Sleep : Unconscious for the rest of it), no more rolls */
    else if(!success && repeat.onFail && effect && !effect.isDeleted){
      await effect.update({ statuses : [repeat.onFail], [`flags.${module.id}.repeat.done`] : true });
      ui.notifications.info(module.format("repeating.worsened", { name : actor.name, effect : effect.name,
        condition : game.i18n.localize(CONFIG.statusEffects.find(s => s.id === repeat.onFail)?.name ?? repeat.onFail) }));
    }
  }

  /* Damage taken : the effects it ends (Sleep), on the client that applied it */
  static async onDamaged(actor, amount){
    if(!(Number(amount) > 0) || !actor?.isOwner) return;
    const ended = actor.effects.filter(e => e.getFlag(module.id, "repeat")?.endsOnDamage && !e.getFlag(module.id, "repeat")?.template);
    if(!ended.length) return;
    await actor.deleteEmbeddedDocuments("ActiveEffect", ended.map(e => e.id)).catch(error => log.debug(error));
    ui.notifications.info(module.format("repeating.woken", { name : actor.name, effect : ended.map(e => e.name).join(", ") }));
  }

  /* "time" effects whose duration has run out : removed (the active GM) */
  static async expireTimed(){
    if(!game.users.activeGM?.isSelf) return;
    for(const actor of gm.actors()){
      for(const effect of [...actor.effects]){
        if((effect.getFlag(module.id, "repeat")?.label === "time") && effect.duration?.expired) await effect.delete().catch(() => {});
      }
    }
  }
}
