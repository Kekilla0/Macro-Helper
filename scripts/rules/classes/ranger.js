import { module } from '../../module.js';
import { settings } from '../../settings.js';
import { logger } from '../../log.js';
import { gm } from '../../gm.js';
import { idOf, chooseOption, whisperOwners, waitFor } from '../../helpers/utils.js';
import { pickTargets } from '../../helpers/targets.js';
import { tokenOf } from '../../helpers/tokens.js';
import { uses } from '../../uses.js';
import { TYPES } from '../../roll-item/message.js';
const log = logger.for(import.meta.url);

/**
 * Ranger, levels 1-2 (Classes setting). Weapon Mastery is rules/weapon-mastery.js; the Fighting Style is
 * rules/fighting-styles.js (swapped in Rest Choices). Works from item identifiers, whatever made the items (Plutonium,
 * dnd5e's SRD, by hand) : none of Hunter's Mark's own activities are used.
 *
 *   Hunter's Mark  : using the spell (or Favored Enemy) asks how to pay (a Favored Enemy use, free; or a slot), then the
 *                    creature to mark (90 ft). The caster pays and concentrates at once; the chat card asks the GM
 *                    to mark the creature (a button : an effect on it). The mark ends with that Concentration. Every hit on the marked
 *                    creature with an attack roll adds 1d6 Force to the attack card (its own box, doubled on a crit).
 *                    The marked creature at 0 HP : its caster is told; using Hunter's Mark again then moves the mark
 *                    (no slot, no use : a Bonus Action).
 *   Favored Enemy  : its free castings : the item's uses when it has them, else counted here (2 / 3 / 4 / 5 / 6 at
 *                    Ranger levels 1 / 5 / 9 / 13 / 17), back on a Long Rest.
 */
export class ranger{
  static MARK = "hunters-mark";
  static FAVORED = "favored-enemy";
  static RANGE = 90;

  static enabled(){
    return (game.system.id === "dnd5e") && settings.value("classRules");
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    uses.onItem("huntersMark", (item, ctx, next) => {
      if(!this.enabled() || ![this.MARK, this.FAVORED].includes(idOf(item)) || !item.actor) return next();
      if((idOf(item) === this.MARK) && (item.type !== "spell")) return next();
      return this.use(item.actor);
    });
    gm.handle("huntersMark", (data, user) => this.applyMark(data, user));
    /* The damage : on the attack card, when it's made (the attacker's client) */
    Hooks.on("createChatMessage", (message, options, userId) => { if(userId === game.user.id) this.onAttackCard(message); });
    /* Concentration on the spell ends : so does the mark (the GM) */
    Hooks.on("deleteActiveEffect", effect => this.onConcentrationEnd(effect));
    /* The marked creature down : its caster is told */
    Hooks.on("updateActor", (actor, changes) => this.onDown(actor, changes));
    Hooks.on("dnd5e.restCompleted", (actor, result) => this.onRest(actor, result));
  }

  /* ---------- Favored Enemy ---------- */

  /* Free castings by Ranger level (2024 table) */
  static favoredMax(actor){
    const level = Number(actor?.classes?.ranger?.system?.levels) || 0;
    return level ? (2 + Math.floor((level - 1) / 4)) : 0;
  }

  static favoredItem(actor){
    return actor?.items?.find?.(i => idOf(i) === this.FAVORED) ?? null;
  }

  /* Free castings left */
  static favoredLeft(actor){
    const item = this.favoredItem(actor);
    if(!item) return 0;
    if(item.system.uses?.max) return Number(item.system.uses.value) || 0;
    return Math.max(0, this.favoredMax(actor) - (Number(actor.getFlag(module.id, "favoredEnemyUsed")) || 0));
  }

  static async spendFavored(actor){
    const item = this.favoredItem(actor);
    if(item?.system.uses?.max) return item.update({ "system.uses.spent" : (Number(item.system.uses.spent) || 0) + 1 });
    return actor.setFlag(module.id, "favoredEnemyUsed", (Number(actor.getFlag(module.id, "favoredEnemyUsed")) || 0) + 1);
  }

  static async onRest(actor, result){
    if(result?.longRest && actor?.isOwner && actor.getFlag(module.id, "favoredEnemyUsed")) await actor.unsetFlag(module.id, "favoredEnemyUsed");
  }

  /* ---------- Hunter's Mark ---------- */

  static spellOf(actor){
    return actor?.items?.find?.(i => (i.type === "spell") && (idOf(i) === this.MARK)) ?? null;
  }

  /* The mark this caster has out now : { effect, token } */
  static markOf(caster){
    for(const token of canvas.tokens?.placeables ?? []){
      const effect = token.actor?.effects?.find?.(e => e.getFlag(module.id, "huntersMark")?.caster === caster.uuid);
      if(effect) return { effect, token };
    }
    return null;
  }

  /* Is the caster concentrating on Hunter's Mark */
  static concentrationOf(caster, spell){
    return caster.effects.find(e => e.statuses?.has?.(CONFIG.specialStatusEffects.CONCENTRATING) && (e.getFlag("dnd5e", "item")?.uuid === spell?.uuid)) ?? null;
  }

  /* The ways to cast it now : a Favored Enemy use, then each slot level left */
  static payments(actor){
    const out = [];
    if(this.favoredLeft(actor) > 0) out.push({ value : "free", label : module.format("classes.ranger.payFree", { left : this.favoredLeft(actor) }), free : true });
    const spells = actor.system?.spells ?? {};
    for(let l = 1; l <= 9; l++){
      const slot = spells[`spell${l}`];
      if((Number(slot?.value) > 0) && (Number(slot?.max) > 0)) out.push({ value : `spell${l}`, label : module.format("classes.ranger.paySlot", { level : l, left : slot.value }), key : `spell${l}`, level : l });
    }
    if((Number(spells.pact?.value) > 0) && (Number(spells.pact?.level) >= 1)) out.push({ value : "pact", key : "pact", level : Number(spells.pact.level), label : module.format("classes.ranger.payPact", { level : spells.pact.level, left : spells.pact.value }) });
    return out;
  }

  /**
   * Using Hunter's Mark (or Favored Enemy) : move a mark whose creature is down, else cast it.
   * @param {Actor} actor
   */
  static async use(actor){
    const spell = this.spellOf(actor);
    if(!spell){
      ui.notifications.warn(module.format("classes.ranger.noSpell", { name : actor.name }));
      return null;
    }
    const current = this.markOf(actor);
    const down = current && ((Number(current.token.actor.system?.attributes?.hp?.value) || 0) <= 0);
    if(current && down && this.concentrationOf(actor, spell)) return this.place(actor, spell, { move : current });

    const payments = this.payments(actor);
    if(!payments.length){
      ui.notifications.warn(module.format("classes.ranger.noPay", { name : actor.name, spell : spell.name }));
      return null;
    }
    const value = await chooseOption({ title : spell.name, icon : "fa-solid fa-crosshairs", prompt : module.i18n("classes.ranger.payPrompt"), options : payments });
    const pay = payments.find(p => p.value === value);
    if(!pay) return null;
    return this.place(actor, spell, { pay });
  }

  /* Pick the creature, pay, concentrate, and have the GM mark it */
  static async place(actor, spell, { pay = null, move = null } = {}){
    const caster = tokenOf(actor);
    const [target] = await pickTargets(caster ?? spell, { count : 1, range : this.RANGE, disposition : "enemy", useTargets : false, confirm : "auto",
      filter : t => !move || (t.id !== move.token.id) });
    if(!target) return null;
    if(pay){
      if(pay.free) await this.spendFavored(actor);
      else await actor.update({ [`system.spells.${pay.key}.value`] : Math.max(0, Number(actor.system.spells[pay.key].value) - 1) });
      await this.concentrate(actor, spell, pay.level ?? 1);
    }
    /* The mark itself is on another creature : the GM's button */
    await gm.ask("huntersMark", { caster : actor.uuid, spell : spell.uuid, target : target.document.uuid, from : move?.effect.uuid ?? null, hours : this.hoursFor(pay?.level ?? 1) },
      { actor, text : module.format(move ? "classes.ranger.moved" : "classes.ranger.marked", { name : actor.name, target : target.name, spell : spell.name }),
        label : module.format(move ? "classes.ranger.moveButton" : "classes.ranger.markButton", { target : target.name }) });
    log.debug("Hunter's Mark", actor.name, target.name, move ? "moved" : pay?.value);
    return true;
  }

  /* 2024 : 1 hour; a level 3-4 slot 8 hours; 5+ 24 hours */
  static hoursFor(level){
    return (level >= 5) ? 24 : (level >= 3) ? 8 : 1;
  }

  /* Concentration on the spell (another one ends first) : dnd5e's own, or its effect made here for a spell without activities */
  static async concentrate(actor, spell, level){
    for(const effect of actor.concentration?.effects ?? []) await actor.endConcentration(effect);
    const activity = spell.system.activities?.find?.(a => a.duration?.concentration);
    const seconds = this.hoursFor(level) * 3600;
    if(activity){
      try { return await actor.beginConcentrating(activity, { duration : { value : seconds, units : "seconds" }, start : { time : game.time.worldTime } }); }
      catch(error){ log.debug("Concentration through the activity", error); }
    }
    const status = CONFIG.statusEffects.find(e => e.id === CONFIG.specialStatusEffects.CONCENTRATING);
    const [effect] = await actor.createEmbeddedDocuments("ActiveEffect", [{
      name : `${game.i18n.localize("EFFECT.DND5E.StatusConcentrating")}: ${spell.name}`, img : status?.img, origin : spell.uuid,
      statuses : [status?.id ?? "concentrating"], duration : { value : seconds, units : "seconds" }, start : { time : game.time.worldTime },
      flags : { dnd5e : { item : { type : spell.type, id : spell.id, uuid : spell.uuid } } },
    }]);
    return effect;
  }

  /* GM : the mark on the creature (moved : off the old one first) */
  static async applyMark({ caster : casterUuid, spell : spellUuid, target : targetUuid, from = null, hours = 1 } = {}, user){
    const caster = fromUuidSync(casterUuid ?? "", { strict : false });
    const target = fromUuidSync(targetUuid ?? "", { strict : false });
    const spell = fromUuidSync(spellUuid ?? "", { strict : false });
    if(!game.user.isGM || !caster || !target?.actor || (user && !caster.testUserPermission(user, "OWNER"))) return false;
    /* Concentration gone before the GM got to it : nothing to mark */
    if(!this.concentrationOf(caster, spell)){
      ui.notifications.warn(module.format("classes.ranger.noConcentration", { name : caster.name, spell : spell?.name ?? "" }));
      return false;
    }
    if(from){
      const old = fromUuidSync(from, { strict : false });
      if(old?.getFlag?.(module.id, "huntersMark")?.caster === caster.uuid) await old.delete();
    }
    else {
      /* A new casting : any mark of this caster's elsewhere goes */
      for(const t of canvas.tokens?.placeables ?? []){
        for(const e of t.actor?.effects?.filter?.(x => x.getFlag(module.id, "huntersMark")?.caster === caster.uuid) ?? []) await e.delete();
      }
    }
    await target.actor.createEmbeddedDocuments("ActiveEffect", [{
      name : module.format("classes.ranger.markName", { spell : spell?.name ?? "Hunter's Mark", name : caster.name }), img : spell?.img ?? "icons/svg/target.svg",
      origin : spellUuid, duration : { value : hours * 3600, units : "seconds" }, start : { time : game.time.worldTime },
      showIcon : CONST.ACTIVE_EFFECT_SHOW_ICON?.ALWAYS ?? 2,
      flags : { [module.id] : { huntersMark : { caster : caster.uuid, spell : spellUuid } } },
    }]);
    return true;
  }

  /* The mark this attacker has on a token */
  static markedBy(token, attacker){
    return token?.actor?.effects?.find?.(e => e.getFlag(module.id, "huntersMark")?.caster === attacker?.uuid) ?? null;
  }

  /* A new attack card : 1d6 Force on each hit on the attacker's marked creature */
  static async onAttackCard(message){
    if(!this.enabled() || (message.type !== TYPES.attack)) return;
    const attacker = message.getAssociatedActor?.();
    if(!attacker || !this.markOf(attacker)) return;
    /* Roll Item's staged card : attack first, then damage : the mark's die rolls with the damage */
    if(message.getFlag(module.id, "reveal") !== undefined){
      await waitFor(() => (game.messages.get(message.id)?.getFlag(module.id, "reveal") ?? 2) >= 2, { timeout : 15000 });
      message = game.messages.get(message.id) ?? message;
    }
    const rays = message.system.isMulti ? message.system.rays.map((_, i) => i) : [null];
    for(const ray of rays){
      /* Every attack at it, hit or miss (no die would tell a miss); its Apply only on a hit */
      const { TargetsField } = dnd5e.dataModels.chatMessage.fields;
      const marked = (message.system.targetsOf?.(ray) ?? []).some(t => this.markedBy(TargetsField.resolve(t)?.token, attacker));
      if(!marked || message.system.extraRolls(ray, "huntersMark").length) continue;
      const isCritical = !!message.system.attackOf(ray)?.isCritical;
      const roll = await new CONFIG.Dice.DamageRoll("1d6", {}, { type : "force", types : ["force"], isCritical, properties : ["mgc"] }).evaluate();
      const spell = this.spellOf(attacker);
      await message.system.addDamage([roll], { key : "huntersMark", ray, label : spell?.name ?? "Hunter's Mark", onHit : true, formula : "1d6" });
    }
  }

  /* Concentration on Hunter's Mark ended : the caster's mark goes (active GM) */
  static async onConcentrationEnd(effect){
    if(!game.users.activeGM?.isSelf || !effect?.statuses?.has?.(CONFIG.specialStatusEffects.CONCENTRATING)) return;
    const item = fromUuidSync(effect.getFlag("dnd5e", "item")?.uuid ?? "", { strict : false });
    const caster = effect.parent;
    if((idOf(item) !== this.MARK) || (caster?.documentName !== "Actor")) return;
    const mark = this.markOf(caster);
    if(mark) await mark.effect.delete();
  }

  /* The marked creature at 0 HP : its caster's owners are told the mark can move (active GM) */
  static async onDown(actor, changes){
    if(!game.users.activeGM?.isSelf || !foundry.utils.hasProperty(changes ?? {}, "system.attributes.hp.value")) return;
    if((Number(actor.system?.attributes?.hp?.value) || 0) > 0) return;
    const mark = actor.effects?.find?.(e => e.getFlag(module.id, "huntersMark"));
    const caster = mark && fromUuidSync(mark.getFlag(module.id, "huntersMark").caster, { strict : false });
    if(!caster) return;
    const spell = this.spellOf(caster);
    await whisperOwners(caster, module.format("classes.ranger.down", { target : actor.name, spell : spell?.name ?? "Hunter's Mark" }));
  }
}
