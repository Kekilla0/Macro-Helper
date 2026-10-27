import { module } from '../module.js';
import { logger } from '../log.js';
import { idOf } from '../helpers/utils.js';
import { settings } from '../settings.js';
import { uses } from '../uses.js';
import { tokenOf, fitSpace } from '../helpers/tokens.js';
import { giveEffect } from '../helpers/actors.js';
import { itemFixes } from './item-fixes.js';
import { limits } from './limits.js';
import { whenDamaged } from './when-damaged.js';
import { onHit, useOnLatestHit } from '../roll-item/hit-bonus.js';
import { teleport, giveCondition, isSmaller } from '../roll-item/card-builder.js';
const log = logger.for(import.meta.url);

/**
 * The 2024 Goliath (Species setting), from legos. Plutonium imports the ancestry as "Giant Ancestry (Fire)"
 * (giant-ancestry-<giant>), Large Form and Powerful Build.
 *
 *   Giant Ancestry   : uses equal to the Proficiency Bonus (Plutonium writes the number at import : it never grew).
 *     Cloud's Jaunt  : used, a teleport : an unoccupied space it can see within 30 ft (a Bonus Action, a use).
 *     Fire's Burn    : a button on its hits : +1d10 Fire (a use) (onHit).
 *     Frost's Chill  : a button on its hits : +1d6 Cold (a use), and the target's Speeds -10 ft until the start of
 *                      the Goliath's next turn.
 *     Hill's Tumble  : a button on its hits on a Large or smaller creature : it's Prone (a use).
 *                      Fire, Frost and Hill used from the sheet : on the latest hit they fit.
 *     Stone's Endurance : damage taken : Use / Pass (whenDamaged) : 1d12 + CON of that damage taken back (a Reaction).
 *     Storm's Thunder   : damage taken from a creature within 60 ft : Use / Pass : 1d8 Thunder at it (a Reaction).
 *   Large Form       : (character level 5 : species-levels) its effect, which Plutonium leaves out : Large, +10 ft
 *                      Speed, advantage on Strength checks, 10 minutes. Not in a space too small to grow in (Rule Limits).
 *   Powerful Build   : advantage on the check to escape a grapple (the Action Tracker's Escape); carrying capacity
 *                      one size larger (dnd5e's own powerfulBuild flag, which Plutonium leaves out).
 */
export class goliath{
  static ANCESTRY = "giant-ancestry-";
  static CLOUD = "giant-ancestry-cloud";
  static FIRE = "giant-ancestry-fire";
  static FROST = "giant-ancestry-frost";
  static HILL = "giant-ancestry-hill";
  static STONE = "giant-ancestry-stone";
  static STORM = "giant-ancestry-storm";
  static LARGE_FORM = "large-form";
  static POWERFUL_BUILD = "powerful-build";
  static EFFECT_IDS = { largeForm : "mhGoliathLarge01", powerfulBuild : "mhGoliathBuild01" };
  static #jaunting = new Set();

  static enabled(){
    return (game.system.id === "dnd5e") && settings.value("speciesRules");
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    const enabled = () => this.enabled();
    itemFixes.add({ name : "Giant Ancestry uses", where : "owned", plan : item => this.usesFix(item) });
    itemFixes.add({ name : "Storm's Thunder range", where : "owned", plan : item => this.stormFix(item) });
    itemFixes.add({ name : "Large Form effect", where : "owned", plan : item => this.largeFormFix(item) });
    itemFixes.add({ name : "Powerful Build effect", where : "owned", plan : item => this.powerfulBuildFix(item) });

    /* Fire, Frost, Hill : a use each, on a hit */
    const cost = hit => ({ item : hit.feature, amount : 1 });
    const noHit = actor => module.format("goliath.noHit", { name : actor?.name ?? "" });
    onHit({ id : this.FIRE, feature : this.FIRE, enabled, icon : "fa-fire", cost, noHit,
      formula : () => "1d10", types : () => ["fire"] });
    onHit({ id : this.FROST, feature : this.FROST, enabled, icon : "fa-snowflake", cost, noHit,
      formula : () => "1d6", types : () => ["cold"], after : hit => this.chill(hit) });
    onHit({ id : this.HILL, feature : this.HILL, enabled, icon : "fa-person-falling", cost, noHit,
      when : hit => !!hit.target && isSmaller(hit.target, "large"), after : hit => this.tumble(hit), conditions : ["prone"] });
    uses.onItem("giantAncestry", (item, ctx, next) => {
      const id = idOf(item);
      if(!this.enabled() || !item.actor || ![this.FIRE, this.FROST, this.HILL].includes(id)) return next();
      return useOnLatestHit(id, item.actor);
    });

    /* Cloud's Jaunt : the pick first, then the use (teleport uses the item : let that one through) */
    uses.onItem("cloudsJaunt", (item, ctx, next) => {
      if(!this.enabled() || (idOf(item) !== this.CLOUD) || this.#jaunting.has(item.uuid)) return next();
      return this.jaunt(item);
    });

    /* Stone's Endurance, Storm's Thunder */
    whenDamaged(this.STONE, { feature : this.STONE, enabled, icon : "fa-mountain", after : ctx => this.endure(ctx) });
    whenDamaged(this.STORM, { feature : this.STORM, enabled, icon : "fa-cloud-bolt", within : 60, atSource : true });

    /* Large Form : room to grow */
    uses.onActivity("largeForm", (activity, ctx, next) => this.roomToGrow(activity) ? next() : null);
  }

  /* ---------- Data fixes ---------- */

  static usesFix(item){
    if(!this.enabled() || (item?.type !== "feat") || !idOf(item).startsWith(this.ANCESTRY)) return null;
    const max = item.system?.uses?.max;
    return (max && (String(max) !== "@prof")) ? { update : { "system.uses.max" : "@prof" } } : null;
  }

  /* Its activity aims at the one who dealt the damage : 60 ft, one creature (Plutonium : Self) */
  static stormFix(item){
    if(!this.enabled() || (idOf(item) !== this.STORM)) return null;
    const activity = [...(item.system?.activities ?? [])].find(a => a.type === "damage");
    if(!activity || (activity.range?.units === "ft")) return null;
    return { update : {
      [`system.activities.${activity.id}.range`] : { value : "60", units : "ft", override : true },
      [`system.activities.${activity.id}.target.affects`] : { type : "creature", count : "1" },
    } };
  }

  static largeFormFix(item){
    if(!this.enabled() || (item?.type !== "feat") || (idOf(item) !== this.LARGE_FORM)) return null;
    const _id = this.EFFECT_IDS.largeForm;
    const activity = [...(item.system?.activities ?? [])].find(a => a.activation?.type === "bonus") ?? [...(item.system?.activities ?? [])][0];
    const linked = activity?.effects?.some?.(e => (e._id ?? e.id) === _id);
    if(item.effects?.has?.(_id) && (!activity || linked)) return null;
    const plan = {};
    if(!item.effects?.has?.(_id)){
      plan.create = { effects : [{ _id, name : item.name, img : item.img, transfer : false,
        description : module.i18n("goliath.largeFormEffect"), duration : { seconds : 600 },
        changes : [
          { key : "system.traits.size", type : "override", value : "lg" },
          { key : "system.attributes.movement.speeds.walk", type : "add", value : "10" },
          { key : "system.abilities.str.check.roll.mode", type : "add", value : "1" },
        ] }] };
    }
    if(activity && !linked) plan.update = { [`system.activities.${activity.id}.effects`] : [...(activity.effects ?? []).map(e => ({ _id : e._id ?? e.id })), { _id }] };
    return plan;
  }

  static powerfulBuildFix(item){
    if(!this.enabled() || (item?.type !== "feat") || (idOf(item) !== this.POWERFUL_BUILD)) return null;
    const _id = this.EFFECT_IDS.powerfulBuild;
    if(item.effects?.has?.(_id)) return null;
    return { create : { effects : [{ _id, name : item.name, img : item.img, transfer : true,
      changes : [{ key : "flags.dnd5e.powerfulBuild", type : "override", value : "true" }],
      flags : { [module.id] : { rule : { escapeMode : "advantage" } } } }] } };
  }

  /* ---------- Uses ---------- */

  static async jaunt(item){
    const token = tokenOf(item.actor);
    if(!token) return null;
    this.#jaunting.add(item.uuid);
    try {
      return await teleport(token, 30, { item });
    } finally {
      this.#jaunting.delete(item.uuid);
    }
  }

  static async chill(hit){
    if(!hit.target) return;
    const movement = hit.target.actor?.system?.attributes?.movement?.speeds ?? {};
    const changes = Object.keys(CONFIG.DND5E.movementTypes ?? { walk : {} }).filter(type => Number(movement[type]) > 0)
      .map(type => ({ key : `system.attributes.movement.speeds.${type}`, type : "add", value : "-10" }));
    if(!changes.length) return;
    await giveEffect(hit.target, { name : hit.feature?.name ?? "Frost's Chill", system : { changes } },
      { from : hit.feature, until : "turnStart", of : hit.actor });
  }

  static async tumble(hit){
    if(hit.target) await giveCondition(hit.target, "prone", { from : hit.feature, by : hit.token });
  }

  /* 1d12 + CON of the damage just taken, back (never more than it took) */
  static async endure(ctx){
    const roll = await new Roll("1d12 + @abilities.con.mod", ctx.actor.getRollData()).evaluate();
    const back = Math.min(roll.total, ctx.amount);
    await roll.toMessage({ speaker : ChatMessage.implementation.getSpeaker({ actor : ctx.actor }),
      flavor : module.format("goliath.endured", { item : ctx.item.name, amount : back }) });
    if(back > 0) await ctx.actor.applyDamage([{ value : back, type : "healing" }], { [module.id] : { takenBack : true } });
    log.debug("Stone's Endurance", ctx.actor.name, roll.total, back);
  }

  /* Large Form : a 2 x 2 space it can grow into, or Rule Limits */
  static roomToGrow(activity){
    if(!this.enabled() || (idOf(activity?.item) !== this.LARGE_FORM)) return true;
    const token = tokenOf(activity.actor);
    if(!token || (token.document.width >= 2)) return true;
    if(fitSpace(token, 2, 2)) return true;
    return limits.allow(module.format("goliath.noRoom", { name : token.name }), { who : token.name, what : activity.item.name });
  }
}
