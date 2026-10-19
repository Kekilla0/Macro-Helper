import { module } from '../../module.js';
import { logger } from '../../log.js';
import { gm } from '../../gm.js';
import { idOf, originItem } from '../../helpers/utils.js';
import { heal } from '../../helpers/actors.js';
import { tokenOf, distanceBetween, canSee, getTokensWithin } from '../../helpers/tokens.js';
import { isAlly, pickSpace } from '../../helpers/targets.js';
import { spendUses } from '../../helpers/items.js';
import { chooseOne, divideAmong } from '../../helpers/creatures.js';
import { giveMode } from '../../roll-item/reasons.js';
import { onDamage } from '../../roll-item/damage.js';
import { cardBuilder } from '../../roll-item/card-builder.js';
import { TYPES } from '../../roll-item/message.js';
import { uses } from '../../uses.js';
import { rollModes } from '../roll-modes.js';
import { conditions } from '../conditions.js';
import { itemFixes } from '../item-fixes.js';
import { actionTracker } from '../action-tracker.js';
import { subclasses } from './common.js';
const log = logger.for(import.meta.url);

/**
 * Cleric subclasses, level 3 (Subclasses setting). The domain spells are the import's; Radiance of the Dawn's save is
 * the item's own data.
 *
 *   Life     Disciple of Life     a spell cast with a slot that restores Hit Points : + 2 + the slot's level on its
 *                                 healing roll (each creature it heals gets it).
 *            Preserve Life        the Bloodied creatures within 30 ft (you too) : divide 5 × Cleric level among them,
 *                                 none above half its Hit Point maximum. Your own creatures heal at once; others' : the
 *                                 GM's button on the card.
 *   Light    Radiance of the Dawn after it : magical Darkness (a Darkness spell's area) within 30 ft is dispelled
 *                                 (the GM's button).
 *            Warding Flare        a creature the Cleric sees within 30 ft makes an attack roll : Warding Flare on the
 *                                 card (a use, its Reaction) : a second d20, the lower kept (after the roll, like
 *                                 Protection).
 *   Trickery Blessing of the Trickster  Plutonium's effect is given its Advantage on Stealth checks and no end but the
 *                                 Cleric's Long Rest, or blessing again (the old one goes).
 *            Invoke Duplicity     the illusion : a space within 30 ft you can see, a copy of your token there (the GM's
 *                                 client makes it), for 1 minute, until you're Incapacitated or end it (its effect on
 *                                 you). Distract : Advantage on your attacks against a creature when you and the
 *                                 illusion are both within 5 ft of it and it can see the illusion. Move Duplicate : 30
 *                                 ft, within 120 ft of you.
 *   War      Guided Strike        a missed attack roll, yours or a creature's within 30 ft : +10 (a Channel Divinity
 *                                 use; another's : your Reaction).
 *            War Priest           after using it : one attack with a weapon or an Unarmed Strike (chosen), part of it.
 */
export class clericDomains{
  static DISCIPLE = "disciple-of-life";
  static PRESERVE = "preserve-life";
  static RADIANCE = "radiance-of-the-dawn";
  static FLARE = "warding-flare";
  static BLESSING = "blessing-of-the-trickster";
  static DUPLICITY = "invoke-duplicity";
  static GUIDED = "guided-strike";
  static WAR_PRIEST = "war-priest";
  static CHANNEL = "channel-divinity";

  static enabled(){
    return subclasses.enabled();
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    onDamage((attack, damage) => this.discipleOfLife(attack, damage));
    /* Preserve Life */
    subclasses.onUseStep(this.PRESERVE, (activity, ctx, next) => this.preserveStep(activity, ctx, next));
    Hooks.on(`${module.id}.preRollItem`, activity => !(this.enabled() && (idOf(activity?.item) === this.PRESERVE)));
    Hooks.on("dnd5e.postUseActivity", (activity, usage) => this.afterUse(activity, usage));
    gm.handle("preserveLife", data => this.preserveAsGM(data));
    gm.handle("dispelDarkness", data => this.dispelAsGM(data));
    /* Warding Flare, Guided Strike */
    Hooks.on(`${module.id}.cardButtons`, (message, buttons, { ray } = {}) => this.cardButtons(message, buttons, ray ?? null));
    Hooks.on(`${module.id}.cardButton`, (message, id, { ray } = {}) => this.cardClicked(message, String(id), ray ?? null));
    /* Blessing of the Trickster */
    itemFixes.add({ name : "Blessing of the Trickster", where : "owned", plan : item => this.blessingFix(item) });
    Hooks.on("dnd5e.restCompleted", (actor, result) => { if(result?.longRest) this.blessingsEnd(actor); });
    /* Invoke Duplicity */
    conditions.endOnIncapacitated(this.DUPLICITY);
    subclasses.onUseStep(this.DUPLICITY, (activity, ctx, next) => this.duplicityStep(activity, ctx, next));
    gm.handle("duplicity", (data, user) => this.duplicityAsGM(data, user));
    Hooks.on("deleteActiveEffect", effect => this.duplicityEnds(effect));
    rollModes.add("duplicity", config => this.distract(config));
  }

  /* ---------- Life ---------- */

  /* A healing spell from a slot : 2 + the slot's level on its healing roll */
  static discipleOfLife(attack, damage){
    if(!this.enabled() || !attack.spell || (attack.type !== "heal") || !subclasses.has(attack.actor, this.DISCIPLE)) return;
    if(damage.rolls[0]?.options?.type !== "healing") return;
    const level = (Number(attack.item.system?.level) || 0) + (Number(attack.item.getFlag?.("dnd5e", "scaling") ?? damage.config?.scaling) || 0);
    if(level < 1) return;
    damage.add(String(2 + level));
    log.debug("Disciple of Life", attack.actor.name, 2 + level);
  }

  static bloodied(actor){
    const hp = actor?.system?.attributes?.hp;
    return !!hp && (Number(hp.max) > 0) && (Number(hp.value) <= Number(hp.max) / 2);
  }

  /* Who gets how much, before the use (nothing to heal : no use) */
  static async preserveStep(activity, ctx, next){
    const actor = activity.getUsageToken?.()?.actor ?? activity.actor;
    const me = tokenOf(actor);
    if(!me) return next();
    const tokens = getTokensWithin(me, 30, { includeSelf : true, includeDead : true, filter : t => this.bloodied(t.actor)
      && (Number(t.actor.system.attributes.hp.value) < Math.floor(Number(t.actor.system.attributes.hp.max) / 2)) });
    if(!tokens.length) return ui.notifications.warn(module.format("subclasses.cleric.noBloodied", { name : actor.name }));
    const total = 5 * (Number(actor.classes?.cleric?.system?.levels) || 1);
    const shares = await divideAmong(tokens, total, { title : activity.item.name, prompt : module.format("subclasses.cleric.preservePrompt", { total }),
      max : t => Math.floor(Number(t.actor.system.attributes.hp.max) / 2) - Number(t.actor.system.attributes.hp.value) });
    if(!shares) return;
    uses.mark(ctx, { skipPick : true, preserveLife : [...shares].filter(([, n]) => n > 0).map(([t, n]) => [t.document.uuid, n]) });
    ctx.config.create = { ...(ctx.config.create ?? {}), measuredTemplate : false };
    /* The shares are the healing : no dnd5e healing roll after the use */
    ctx.config.subsequentActions = false;
    return next();
  }

  static async afterUse(activity, usage){
    if(!this.enabled() || !activity?.actor?.isOwner) return;
    const id = idOf(activity.item);
    const actor = activity.getUsageToken?.()?.actor ?? activity.actor;
    try {
      if(id === this.PRESERVE) await this.preserve(actor, usage?.[module.id]?.preserveLife ?? []);
      else if(id === this.RADIANCE) await this.radiance(actor);
      else if(id === this.BLESSING) await this.blessingAgain(activity);
      else if((id === this.DUPLICITY) && (activity.type === "summon")) await this.makeDuplicate(actor, activity, usage?.[module.id]?.duplicity);
      else if((id === this.DUPLICITY) && (activity.type === "utility")) await this.moveDuplicate(actor);
      else if(id === this.WAR_PRIEST) await this.warPriest(actor);
    }
    catch(error){ log.error(error); ui.notifications.warn(error.message); }
  }

  static async preserve(actor, shares){
    const others = [];
    for(const [uuid, amount] of shares){
      const target = fromUuidSync(uuid, { strict : false });
      if(!target?.actor) continue;
      if(target.actor.isOwner && !game.user.isGM) await heal(target.actor, amount);
      else others.push([uuid, amount]);
    }
    if(!others.length) return;
    const names = others.map(([uuid, n]) => `${fromUuidSync(uuid, { strict : false })?.name ?? "?"} ${n}`).join(", ");
    await gm.ask("preserveLife", { shares : others }, { actor, label : module.i18n("subclasses.cleric.preserveApply"),
      text : module.format("subclasses.cleric.preserveAsk", { name : actor.name, list : names }) });
  }

  static async preserveAsGM({ shares = [] } = {}){
    for(const [uuid, amount] of shares){
      const target = fromUuidSync(uuid, { strict : false });
      if(target?.actor) await heal(target.actor, amount);
    }
    return true;
  }

  /* ---------- Light ---------- */

  /* The areas of Darkness spells within 30 ft */
  static darknessNear(actor){
    const me = tokenOf(actor);
    if(!me || !canvas.scene) return [];
    const reach = 30 * canvas.grid.size / canvas.grid.distance;
    const c = me.center;
    return canvas.scene.regions.filter(r => {
      const spell = fromUuidSync(r.getFlag("dnd5e", "item") ?? "", { strict : false });
      if(idOf(spell) !== "darkness") return false;
      const b = r.object?.bounds;
      if(!b) return false;
      const dx = Math.max(b.x - c.x, 0, c.x - (b.x + b.width)), dy = Math.max(b.y - c.y, 0, c.y - (b.y + b.height));
      return Math.hypot(dx, dy) <= reach;
    });
  }

  static async radiance(actor){
    const regions = this.darknessNear(actor);
    if(!regions.length) return;
    await gm.ask("dispelDarkness", { regions : regions.map(r => r.uuid) }, { actor, label : module.i18n("subclasses.cleric.dispel"),
      text : module.format("subclasses.cleric.dispelAsk", { name : actor.name, count : regions.length }) });
  }

  static async dispelAsGM({ regions = [] } = {}){
    for(const uuid of regions) await fromUuidSync(uuid, { strict : false })?.delete?.();
    return true;
  }

  /* ---------- Warding Flare, Guided Strike : on attack cards ---------- */

  static channelOf(actor){
    return subclasses.has(actor, this.CHANNEL);
  }

  /* This user's creatures with that feature that can use it on that attacker now */
  static helpers(attacker, id, { range, reaction = true, self = false } = {}){
    if(!this.enabled() || !attacker) return [];
    return (canvas.tokens?.placeables ?? []).filter(t => t.actor?.isOwner && subclasses.has(t.actor, id)
      && ((t === attacker) ? self : (distanceBetween(t, attacker) <= range) && canSee(t, attacker) && (!reaction || actionTracker.left(t.actor, "reaction")))
      && !actionTracker.OUT_OF_ACTION.some(s => t.actor.statuses?.has?.(s)));
  }

  static #done = new Set();

  static cardButtons(message, buttons, ray){
    if(!this.enabled() || (message.type !== TYPES.attack) || !message.system?.attackOf?.(ray)) return;
    const attacker = tokenOf(message.getAssociatedToken?.() ?? message.getAssociatedActor?.());
    const key = `${message.id}|${ray}`;
    /* Warding Flare : an attack roll by a creature not on its side */
    if(!this.#done.has(`flare|${key}`)){
      for(const t of this.helpers(attacker, this.FLARE, { range : 30 })){
        if(isAlly(t, attacker) || !(Number(subclasses.has(t.actor, this.FLARE)?.system?.uses?.value) > 0)) continue;
        buttons.push({ id : `flare|${t.document.uuid}`, icon : "fa-sun", label : subclasses.has(t.actor, this.FLARE).name });
      }
    }
    /* Guided Strike : a miss, yours or a creature's within 30 ft */
    if(!message.system.isHitOn?.(ray) && !this.#done.has(`guided|${key}`)){
      for(const t of this.helpers(attacker, this.GUIDED, { range : 30, self : true })){
        if(!(Number(this.channelOf(t.actor)?.system?.uses?.value) > 0)) continue;
        buttons.push({ id : `guided|${t.document.uuid}`, icon : "fa-crosshairs", label : module.format("subclasses.cleric.guided", { name : subclasses.has(t.actor, this.GUIDED).name }) });
      }
    }
  }

  static async cardClicked(message, id, ray){
    const [kind, uuid] = id.split("|");
    if(!["flare", "guided"].includes(kind)) return;
    const token = tokenOf(fromUuidSync(uuid ?? "", { strict : false }));
    const attacker = tokenOf(message.getAssociatedToken?.() ?? message.getAssociatedActor?.());
    const key = `${kind}|${message.id}|${ray}`;
    if(!token?.actor?.isOwner || this.#done.has(key)) return;
    this.#done.add(key);
    if(kind === "flare"){
      const item = subclasses.has(token.actor, this.FLARE);
      if(!item || !await spendUses(item, 1)) return;
      await actionTracker.spend(token.actor, { kind : "reaction", what : item.name }).catch(() => null);
      const result = await subclasses.changeRoll(message, { ray, d20 : "kl" }, token.actor);
      if(result === "same") ui.notifications.info(module.i18n("feats.lucky.same"));
    }
    else {
      const channel = this.channelOf(token.actor);
      if(!channel || !await spendUses(channel, 1)) return;
      if(token !== attacker) await actionTracker.spend(token.actor, { kind : "reaction", what : subclasses.has(token.actor, this.GUIDED)?.name ?? "" }).catch(() => null);
      await subclasses.changeRoll(message, { ray, add : "10" }, token.actor);
    }
    log.debug("Domain reaction", kind, token.name);
  }

  /* ---------- Trickery ---------- */

  /* Plutonium's blessing : a description, 1 round. Advantage on Stealth checks, until the Long Rest */
  static blessingFix(item){
    if(!this.enabled() || (idOf(item) !== this.BLESSING)) return null;
    const changesOf = e => [...(e.changes ?? e.system?.changes ?? [])];
    /* v14's duration : { value, units, expiry } (null : no end of its own) */
    const timed = e => (e._source?.duration?.value ?? null) !== null;
    const updateEffects = [...(item.effects ?? [])].filter(e => !e.transfer && (!changesOf(e).length || timed(e)))
      .map(e => ({ _id : e.id, duration : { value : null, units : "seconds", expiry : null },
        ...(changesOf(e).length ? {} : { changes : [{ key : "system.skills.ste.roll.mode", type : "add", mode : 2, value : "1" }] }) }));
    return updateEffects.length ? { updateEffects } : null;
  }

  /* Every blessing this Cleric's item gave (on the scene's creatures and the world's) */
  static blessings(item){
    const actors = new Set([...game.actors, ...(canvas.tokens?.placeables ?? []).map(t => t.actor).filter(Boolean)]);
    return [...actors].flatMap(a => a.effects.filter(e => (e.origin === item.uuid) || (originItem(e) === item)));
  }

  /* Blessing again : the one from before goes (the GM's client removes it) */
  static async blessingAgain(activity){
    const old = this.blessings(activity.item);
    if(!old.length) return;
    await gm.run("subclassEffectsEnd", { effects : old.map(e => e.uuid), item : activity.item.uuid });
  }

  static async blessingsEnd(actor){
    const item = subclasses.has(actor, this.BLESSING);
    if(!this.enabled() || !item || !actor.isOwner) return;
    const old = this.blessings(item);
    if(old.length) await gm.run("subclassEffectsEnd", { effects : old.map(e => e.uuid), item : item.uuid });
  }

  /* ---------- Invoke Duplicity ---------- */

  static duplicateOf(actor){
    const effect = actor?.effects?.find?.(e => e.getFlag(module.id, "duplicity"));
    const token = effect ? fromUuidSync(effect.getFlag(module.id, "duplicity").token ?? "", { strict : false }) : null;
    return token ? { effect, token : token.object ?? null } : null;
  }

  /* The illusion's space first (cancelled : nothing used) */
  static async duplicityStep(activity, ctx, next){
    if(activity.type !== "summon") return next();
    const me = tokenOf(activity.getUsageToken?.()?.actor ?? activity.actor);
    if(!me) return next();
    const space = await pickSpace(me, { range : 30, size : Math.max(1, Math.round(me.document.width ?? 1)), seen : true, notice : activity.item.name });
    if(!space) return;
    uses.mark(ctx, { skipPick : true, duplicity : space });
    ctx.config.create = { ...(ctx.config.create ?? {}), summons : false };
    return next();
  }

  static async makeDuplicate(actor, activity, space){
    const me = tokenOf(actor);
    if(!me || !space) return;
    const old = this.duplicateOf(actor);
    if(old) await old.effect.delete();
    const uuid = await gm.run("duplicity", { token : me.document.uuid, x : space.x, y : space.y });
    if(!uuid) return;
    await actor.createEmbeddedDocuments("ActiveEffect", [{ name : activity.item.name, img : activity.item.img, origin : activity.item.uuid,
      duration : { seconds : 60 }, start : { time : game.time.worldTime }, flags : { [module.id] : { duplicity : { token : uuid } } } }]);
  }

  static async moveDuplicate(actor){
    const found = this.duplicateOf(actor);
    const me = tokenOf(actor);
    if(!found?.token || !me) return ui.notifications.warn(module.format("subclasses.cleric.noDuplicate", { name : actor.name }));
    const px = canvas.grid.size / canvas.grid.distance;
    const space = await pickSpace(found.token, { range : 30, size : Math.max(1, Math.round(found.token.document.width ?? 1)),
      check : s => (Math.hypot(s.x - me.document.x, s.y - me.document.y) / px > 120) ? module.i18n("subclasses.cleric.tooFar") : "" });
    if(space) await gm.run("duplicity", { token : me.document.uuid, move : found.token.document.uuid, x : space.x, y : space.y });
  }

  /* GM : the copy made (or moved) */
  static async duplicityAsGM({ token : uuid, move = null, x, y } = {}, user){
    const source = fromUuidSync(uuid ?? "", { strict : false });
    if(!source?.actor || !(user?.isGM || source.actor.testUserPermission(user, "OWNER"))) return null;
    if(move){
      const copy = fromUuidSync(move, { strict : false });
      if(copy?.getFlag(module.id, "duplicate")?.of !== uuid) return null;
      await copy.update({ x, y }, { animate : false });
      return copy.uuid;
    }
    const data = source.toObject();
    delete data._id;
    Object.assign(data, { x, y, alpha : 0.6, name : module.format("subclasses.cleric.illusionName", { name : source.name }),
      flags : { ...(data.flags ?? {}), [module.id] : { duplicate : { of : uuid } } } });
    const [made] = await source.parent.createEmbeddedDocuments("Token", [data]);
    return made?.uuid ?? null;
  }

  /* The effect gone (its minute, Incapacitated, dismissed) : the copy goes */
  static async duplicityEnds(effect){
    const flag = effect?.getFlag?.(module.id, "duplicity");
    if(!flag || !game.users.activeGM?.isSelf) return;
    await fromUuidSync(flag.token ?? "", { strict : false })?.delete?.();
  }

  /* Distract : you and the illusion both within 5 ft of it, and it sees the illusion */
  static distract(config){
    if(!this.enabled()) return;
    const actor = config.subject?.actor;
    const found = this.duplicateOf(actor);
    const target = conditions.targetOf(config);
    const me = tokenOf(actor);
    if(!found?.token || !target || !me) return;
    if((distanceBetween(me, target) <= 5) && (distanceBetween(found.token, target) <= 5) && canSee(target, found.token) && config.rolls?.[0]){
      giveMode(config.rolls[0], "advantage", found.effect.name);
    }
  }

  /* ---------- War Priest ---------- */

  static async warPriest(actor){
    const weapons = actor.items.filter(i => (i.type === "weapon") && (i.system.equipped || (idOf(i) === "unarmed-strike"))
      && [...(i.system.activities ?? [])].some(a => a.type === "attack"));
    if(!weapons.length) return ui.notifications.warn(module.format("subclasses.cleric.noWeapon", { name : actor.name }));
    const uuid = (weapons.length === 1) ? weapons[0].uuid : await chooseOne(weapons.map(w => ({ value : w.uuid, label : w.name, img : w.img })),
      { title : subclasses.has(actor, this.WAR_PRIEST)?.name, icon : "fa-solid fa-khanda" });
    const weapon = uuid ? fromUuidSync(uuid, { strict : false }) : null;
    if(weapon) await cardBuilder.roll(weapon, { use : false });
  }
}
