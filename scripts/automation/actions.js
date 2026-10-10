import { module } from '../module.js';
import { rollModes } from './roll-modes.js';
import { settings } from '../settings.js';
import { logger } from '../log.js';
import { gm } from '../gm.js';
import { pickTargets } from '../helpers/targets.js';
import { tokenOf, isDown } from '../helpers/tokens.js';
import { addTimedEffect, stabilize } from '../helpers/actors.js';
import { giveMode } from '../roll-item/reasons.js';
import { chooseOption, idOf } from '../helpers/utils.js';
import { uses } from '../uses.js';
const log = logger.for(import.meta.url);

/**
 * The basic actions dnd5e has no automation for, from items you add to a character (examples/items : dodge.json,
 * help.json), recognised by item identifier and activity name (Action Rules setting) :
 *
 *   Dash           : Dashing until the end of the turn (extra movement equal to your Speed : the action tracker).
 *   Disengage      : Disengaged until the end of the turn (your movement doesn't provoke Opportunity Attacks).
 *   Dodge          : Dodging until the start of your next turn. Attacks against you have disadvantage (conditions.js);
 *                    dnd5e gives the DEX save advantage and ends it when you're Incapacitated or can't move.
 *   Help :
 *     Assist Attack  : an enemy within 5 ft. The next attack roll against it by one of your allies (not you) has
 *                      advantage. Ends when used, or at the start of your next turn.
 *     Assist Check   : one of your skill or tool proficiencies, and an ally within 30 ft who can hear you (not
 *                      Deafened). Their next ability check with it has
 *                      advantage. Ends when used, or at the start of your next turn (out of combat : when used).
 *     Stabilize      : a creature at 0 HP within 5 ft. WIS (Medicine) DC 10 : on a success it's Stable (stabilize()).
 *
 * Help's choices and picks happen before dnd5e uses the activity (beforeUse, from Roll Item's use wrapper), so its
 * card targets who was picked and says what for. The marks it leaves go on the enemy / the ally, who the helper
 * usually doesn't own : the GM's client makes them, once the use went through.
 */
export class actions{
  static DODGE = "dodge";
  static DASH = "dash";
  static DISENGAGE = "disengage";
  /* Assist Check's reach in feet : how far coaching carries (Inspiring Leader, Rally) */
  static ASSIST_CHECK_RANGE = 30;
  static HELP = "help";

  /* Default Actions setting; a creature also needs the item */
  static enabled(){
    return (game.system.id === "dnd5e") && settings.value("actionRules");
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    /* Dodge, Dash and Disengage mark the creature here, not through Roll Item */
    Hooks.on(`${module.id}.selfEffects`, activity => !(this.enabled() && [this.DODGE, this.DASH, this.DISENGAGE, this.HELP].includes(idOf(activity?.item))));
    Hooks.on("dnd5e.postUseActivity", (activity, usage, results) => this.onUse(activity, usage, results));
    Hooks.on("dnd5e.renderChatMessage", (message, html) => {
      if(message.getFlag?.(module.id, "autoApplied")) html.classList?.add(`${module.id}-auto-applied`);
    });
    rollModes.add("help", config => this.onPreRollAttack(config));
    Hooks.on("dnd5e.rollAttackV2", rolls => this.consume(rolls?.[0]));
    Hooks.on("dnd5e.preRollSkillV2", config => this.onPreRollCheck(config, `skill:${config.skill}`));
    Hooks.on("dnd5e.preRollToolV2", config => this.onPreRollCheck(config, `tool:${config.tool}`));
    /* Help : who and what, chosen and picked before the use; the card shows them */
    uses.onActivity("action", async (activity, ctx, next) => {
      const before = await this.beforeUse(activity);
      if(before === false) return;
      if(before){
        uses.flag(ctx, before);
        uses.mark(ctx, { skipPick : true, before });
      }
      return next();
    });
    gm.handle("help", (data, user) => this.helpAsGM(data, user));
    gm.handle("helpUsed", (data, user) => this.helpUsedAsGM(data, user));
    gm.handle("stabilize", (data, user) => this.stabilizeAsGM(data, user));
    /* The Healer's Kit's Stabilize (2024 : a use, no check) : the creature picked first, nothing spent without one */
    uses.onActivity("healersKit", (activity, ctx, next) => this.healersKitStep(activity, ctx, next));
    /* Help's Medicine roll rerolled to a pass : the creature can still be stabilized */
    Hooks.on("updateChatMessage", (message, changes, options, userId) => this.onStabilizeReroll(message, changes, userId));
  }


  /* Which Help mode an activity is, by its name */
  static helpMode(activity){
    const name = (activity?.name ?? "").toLowerCase();
    if(name.includes("attack")) return "attack";
    if(name.includes("check")) return "check";
    if(name.includes("stabil")) return "stabilize";
    return null;
  }

  /**
   * Before dnd5e uses a Help activity : its choice and its pick. Returns what to note on the card (flags), false to
   * stop the use, or null when it isn't Help.
   * @param {Activity} activity
   * @returns {Promise<object|false|null>}
   */
  static async beforeUse(activity){
    if(!this.enabled() || (idOf(activity?.item) !== this.HELP) || !activity.actor?.isOwner) return null;
    const mode = this.helpMode(activity);
    const near = canvas.scene?.grid.distance ?? 5;
    /* Like Roll Item's picks : the creature you already target, unless Pick Targets is "always" */
    const useTargets = settings.value("rollItemPick") !== "always";
    const one = async options => (await pickTargets(activity.item, { count : 1, useTargets, ...options }))[0] ?? null;
    let target = null, help = { mode };
    if(mode === "attack"){
      target = await one({ range : near, disposition : "nonAlly" });
    }
    else if(mode === "check"){
      const choice = await this.chooseCheck(activity);
      if(!choice) return false;
      Object.assign(help, choice);
      /* "Near enough to assist verbally" : within 30 ft, and the ally can hear you */
      target = await one({ range : this.ASSIST_CHECK_RANGE, disposition : "ally", filter : t => !t.actor?.statuses?.has("deafened") });
    }
    else if(mode === "stabilize"){
      target = await one({ range : near, disposition : "any", filter : t => this.canStabilize(t.actor) });
    }
    else return null;
    if(!target) return false;
    help.target = target.document.uuid;
    const note = (mode === "check")
      ? module.format("actions.help.noteCheck", { check : help.label, name : target.name })
      : module.format(mode === "attack" ? "actions.help.noteAttack" : "actions.help.noteStabilize", { name : target.name });
    return { help, note };
  }

  /* After the use : Dodge, and what Help chose before it */
  static async onUse(activity, usage, results){
    if(!this.enabled() || !activity?.actor?.isOwner) return;
    const id = idOf(activity.item);
    try {
      /* On the token's own actor : an unlinked token opened from the sidebar would otherwise miss it */
      const own = activity.getUsageToken?.()?.actor ?? tokenOf(activity.actor)?.actor ?? activity.actor;
      if(id === this.DODGE) return await this.dodge(own).then(() => this.autoApplied(results));
      if(id === this.DASH) return await this.mark(own, "dash", "actions.dash.mark", "icons/skills/movement/feet-winged-boots-glowing-yellow.webp").then(() => this.autoApplied(results));
      if(id === this.DISENGAGE) return await this.mark(own, "disengage", "actions.disengage.mark", "icons/skills/movement/arrow-upward-yellow.webp").then(() => this.autoApplied(results));
      const help = usage?.[module.id]?.before?.help;
      if((id !== this.HELP) || !help?.target) return;
      if(help.mode === "attack") return await this.assistAttack(activity, help);
      if(help.mode === "check") return await this.assistCheck(activity, help);
      if(help.mode === "stabilize") return await this.stabilizeAction(activity, help);
    } catch(error){
      log.error(error);
      ui.notifications.warn(error.message);
    }
  }

  /* Applied by the module : the card's effect buttons are greyed out (for its owner and the GM) */
  static async autoApplied(results){
    const message = results?.message;
    if(message?.setFlag && message.isOwner) await message.setFlag(module.id, "autoApplied", true);
  }

  /* ---------- Dodge ---------- */

  static async dodge(actor){
    if(actor.statuses?.has("dodging")) return;
    const status = CONFIG.statusEffects.find(e => e.id === "dodging");
    await addTimedEffect(actor, {
      name : game.i18n.localize(status?.name ?? "Dodging"), img : status?.img, statuses : ["dodging"],
    }, { until : "turnStart" });
    log.debug("Dodging", actor.name);
  }

  /* ---------- Dash, Disengage ---------- */

  /* Marked until the end of this turn : Dashing (extra movement equal to its Speed), Disengaged (its movement
     doesn't provoke Opportunity Attacks). The action tracker reads them. */
  static async mark(actor, key, label, img){
    if(actor.effects.some(e => e.getFlag(module.id, key))) return;
    await addTimedEffect(actor, { name : module.i18n(label), img, flags : { [module.id] : { [key] : true } } }, { until : "turnEnd", thisTurn : true });
    log.debug(key, actor.name);
  }

  /* ---------- Help : Assist Attack ---------- */

  static async assistAttack(activity, help){
    const helper = tokenOf(activity.item);
    if(!helper) return;
    const target = fromUuidSync(help.target, { strict : false });
    await gm.ask("help", { mode : "attack", helper : activity.actor.uuid, side : helper.document.disposition, target : help.target },
      { actor : activity.actor, text : module.format("actions.help.askAttack", { name : activity.actor.name, target : target?.name ?? "" }),
        label : module.format("actions.help.askAttackButton", { target : target?.name ?? "" }) });
  }

  /* An ally of the helper (same side, not the helper) attacking a creature marked by Assist Attack : advantage, used up */
  static onPreRollAttack(config){
    if(!this.enabled()) return;
    const attacker = config.subject?.actor;
    const roll = config.rolls?.[0];
    const uuid = config[module.id]?.target;
    const target = uuid ? fromUuidSync(uuid, { strict : false }) : ((game.user.targets.size === 1) ? game.user.targets.first()?.document : null);
    if(!attacker || !roll || !target?.actor) return;
    const side = tokenOf(attacker)?.document.disposition;
    const mark = target.actor.effects.find(e => {
      const help = e.getFlag(module.id, "help");
      return help && (help.mode === "attack") && (help.helper !== attacker.uuid) && (help.side === side);
    });
    if(!mark) return;
    giveMode(roll, "advantage", module.format("actions.help.reason", { name : mark.getFlag(module.id, "help").name }));
    roll.options[module.id] = { ...(roll.options[module.id] ?? {}), helpUsed : mark.uuid };
  }

  static async consume(roll){
    const uuid = roll?.options?.[module.id]?.helpUsed;
    if(!uuid) return;
    const effect = fromUuidSync(uuid, { strict : false });
    if(effect?.isOwner) await effect.delete();
    else await gm.run("helpUsed", { effect : uuid });
  }

  /* ---------- Help : Assist Check ---------- */

  /* The helper's skill and tool proficiencies, as "skill:ath" / "tool:thief" */
  static proficiencies(actor){
    const list = [];
    for(const [key, skill] of Object.entries(actor.system.skills ?? {})){
      if(Number(skill.value) >= 1) list.push({ key : `skill:${key}`, label : CONFIG.DND5E.skills[key]?.label ?? key });
    }
    for(const [key, tool] of Object.entries(actor.system.tools ?? {})){
      if(Number(tool.value) >= 1) list.push({ key : `tool:${key}`, label : dnd5e.documents?.Trait?.keyLabel?.(key, { trait : "tool" }) ?? key });
    }
    return list.sort((a, b) => a.label.localeCompare(b.label));
  }

  /* Which proficiency : a list to choose from */
  static async chooseCheck(activity){
    const actor = activity.actor;
    const options = this.proficiencies(actor);
    if(!options.length){
      ui.notifications.warn(module.format("actions.help.noProficiency", { name : actor.name }));
      return null;
    }
    const key = await chooseOption({ title : activity.item.name, icon : "fa-solid fa-hands-helping", prompt : module.i18n("actions.help.chooseCheck"),
      options : options.map(o => ({ value : o.key, label : o.label })), confirm : module.i18n("actions.help.choose") });
    if(!key) return null;
    return { key, label : options.find(o => o.key === key)?.label ?? key };
  }

  static async assistCheck(activity, help){
    const target = fromUuidSync(help.target, { strict : false });
    await gm.ask("help", { mode : "check", helper : activity.actor.uuid, target : help.target, key : help.key, label : help.label },
      { actor : activity.actor, text : module.format("actions.help.askCheck", { name : activity.actor.name, target : target?.name ?? "", check : help.label ?? help.key }),
        label : module.format("actions.help.askCheckButton", { target : target?.name ?? "" }) });
  }

  /* The ally's next check with that skill / tool has advantage, and uses the help up */
  static onPreRollCheck(config, key){
    if(!this.enabled()) return;
    const actor = config.subject;
    const mark = actor?.effects?.find(e => (e.getFlag(module.id, "help")?.mode === "check") && (e.getFlag(module.id, "help").key === key));
    if(!mark) return;
    config.advantage = true;
    log.debug("Help on a check", actor.name, key);
    if(mark.isOwner) mark.delete();
  }

  /* ---------- GM side ---------- */

  /* The GM marks the enemy (Assist Attack) or the ally (Assist Check) : the asker must own the helper */
  static async helpAsGM({ mode, helper : helperUuid, side, target : targetUuid, key, label } = {}, user){
    const helper = fromUuidSync(helperUuid, { strict : false });
    const target = fromUuidSync(targetUuid, { strict : false })?.actor;
    if(!helper || !target) return null;
    if(!user?.isGM && !helper.testUserPermission(user, "OWNER")) throw new Error("Only the helper's owner can help.");
    const name = mode === "attack"
      ? module.format("actions.help.attackMark", { name : helper.name })
      : module.format("actions.help.checkMark", { name : helper.name, check : label ?? key });
    await addTimedEffect(target, {
      name, img : "icons/skills/social/diplomacy-handshake.webp",
      flags : { [module.id] : { help : { mode, helper : helperUuid, name : helper.name, side, key } } },
    }, { of : helper, until : "turnStart" });
    return true;
  }

  /* A Help mark used by someone who doesn't own its creature */
  static async helpUsedAsGM({ effect : uuid } = {}){
    const effect = fromUuidSync(uuid, { strict : false });
    if(effect?.getFlag(module.id, "help")) await effect.delete();
  }

  /* ---------- Help : Stabilize ---------- */

  static async stabilizeAction(activity, help){
    const token = fromUuidSync(help.target, { strict : false });
    if(!token?.actor) return;
    const [roll] = await activity.actor.rollSkill({ skill : "med", target : 10 }, { configure : false },
      { data : { flags : { [module.id] : { stabilize : token.uuid } } } }) ?? [];
    if(!roll) return;
    if(roll.total >= 10) await stabilize(token.actor);
    else ui.notifications.info(module.format("actions.stabilize.failed", { name : token.name }));
  }

  /* ---------- Healer's Kit : Stabilize ---------- */

  static HEALERS_KIT = "healers-kit";

  static isKitStabilize(activity){
    const item = activity?.item;
    const kit = (idOf(item) === this.HEALERS_KIT) || /^healer.?s kit$/i.test(item?.name ?? "");
    return kit && /stabili/i.test(activity?.name ?? "");
  }

  /* A creature at 0 HP within 5 ft first (none : nothing spent), then the use, then it's Stable (no check) */
  static async healersKitStep(activity, ctx, next){
    if(!this.enabled() || !this.isKitStabilize(activity) || !activity.actor?.isOwner) return next();
    const near = canvas.scene?.grid.distance ?? 5;
    const useTargets = settings.value("rollItemPick") !== "always";
    const [target] = await pickTargets(activity.item, { count : 1, useTargets, range : near, disposition : "any", filter : t => this.canStabilize(t.actor) });
    if(!target?.actor) return;
    uses.flag(ctx, { note : module.format("actions.kit.note", { name : target.name }) });
    const result = await next();
    if(result) await stabilize(target.actor);
    return result;
  }

  /* At 0 HP, not dead, not already stable */
  static canStabilize(actor){
    const hp = actor?.system?.attributes?.hp;
    return !!hp && (Number(hp.value) <= 0) && !actor.statuses?.has("dead") && !actor.statuses?.has("stable") && !isDown(tokenOf(actor) ?? actor);
  }

  static async onStabilizeReroll(message, changes, userId){
    const uuid = message.getFlag?.(module.id, "stabilize");
    if(!uuid || (userId !== game.user.id) || !("rolls" in (changes ?? {})) || message.getFlag(module.id, "stabilized")) return;
    if(!((message.rolls?.[0]?.total ?? 0) >= 10)) return;
    const token = fromUuidSync(uuid, { strict : false });
    if(!token?.actor) return;
    if(message.isOwner) await message.setFlag(module.id, "stabilized", true);
    await stabilize(token.actor);
  }

  static async stabilizeAsGM({ actor : uuid } = {}){
    const actor = fromUuidSync(uuid, { strict : false });
    if(!this.canStabilize(actor)) return false;
    await stabilize(actor, { confirmed : true });
    return true;
  }
}
