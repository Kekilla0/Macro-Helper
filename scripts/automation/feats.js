import { module } from '../module.js';
import { esc, idOf } from '../helpers/utils.js';
import { settings } from '../settings.js';
import { logger } from '../log.js';
import { gm } from '../gm.js';
import { uses } from '../uses.js';
import { pickTargets } from '../helpers/targets.js';
import { findItem, preventDropToZero } from '../helpers/actors.js';
import { spendUses } from '../helpers/items.js';
import { itemFixes } from './item-fixes.js';
import { onDamage } from '../roll-item/damage.js';
import { saveModeAgainst } from './roll-modes.js';
import { rerollButton } from '../roll-item/reroll-buttons.js';
import { d20Button } from '../roll-item/d20-buttons.js';
import { onHitMove } from '../roll-item/card-moves.js';
import { unarmedDamage } from './unarmed.js';
import { initiativeSwap } from './initiative-swap.js';
const log = logger.for(import.meta.url);

/**
 * Feats and features dnd5e has no data for, found on the character by item identifier (Species and Feats settings)
 * and applied at the stage they affect. Each is a small, self-contained rule.
 *
 *   Tiefling (2024) : the species item's Darkvision is 60 ft (Plutonium's gives 120) : an item fix.
 *   Relentless Endurance : (an Orc, a creature with the trait) dropped to 0 HP but not killed outright : 1 HP instead,
 *                     once until a Long Rest (the item's own uses, or the module's mark when it has none); said in chat.
 *   Tortle          : Claws : its Unarmed Strike deals 1d6 + its modifier Slashing (unarmedDamage).
 *                     Shell Defense : using it puts on "Shell Defense" : +4 AC, advantage on STR / CON saves,
 *                     disadvantage on DEX saves, Prone, Speed 0, no Reactions, and no Action or Bonus Action but Emerge
 *                     (Rule Limits); its action bar's Emerge button, or Shell Defense used again (a toggle), ends it
 *                     (a Bonus Action), still Prone.
 *   Save traits     : advantage on saves against a condition (Brave : Frightened, Fey Ancestry : Charmed, Dwarven
 *                     Resilience : Poisoned), for saves rolled from a card whose activity applies it.
 * Origin feats, each built from legos the way an Item Macro would be :
 *   Savage Attacker : a button on each weapon hit (for its owner) rolls the damage again as an alternative,
 *                     each roll with its own APPLY; once per turn in combat (rerollButton "again").
 *   Alert           : right after its initiative is rolled, a swap with a willing ally (initiativeSwap).
 *   Lucky           : a Luck Point adds a second d20 : to its own attack roll, save, check or initiative (the higher
 *                     kept), or to an attack roll against it (the lower kept; the GM changes the card) (d20Button).
 *   Tavern Brawler  : the Unarmed Strike's own damage becomes 1d4 + its modifier, its 1s rerolled (unarmedDamage),
 *                     unless it already rolls a die (a Monk's Martial Arts). Once per turn, a hit can also push the
 *                     target 5 ft (the GM's button, onHitMove).
 *   Healer          : Healing Rerolls (1s on a spell's healing dice are rolled again, onDamage). Battle Medic : using the feat
 *                     picks a creature within 5 ft, reads its remaining Hit Dice (its player picks the size when it has several),
 *                     and runs the matching "Heal dX" activity; it needs a Healer's Kit use, and spends the target's Hit
 *                     Die of that size when its owner applies it.
 */
export class feats{
  /* Feats (Savage Attacker, Alert, Lucky, Tavern Brawler, Healer) */
  static enabled(){
    return (game.system.id === "dnd5e") && settings.value("featRules");
  }

  /* 2024 Tiefling : Darkvision 60 ft (any legacy) */
  static tieflingFix(item){
    if(!this.speciesEnabled() || (item?.type !== "race") || (String(item.system?.source?.rules ?? "") !== "2024")) return null;
    if(!String(item.system?.identifier ?? "").startsWith("tiefling")) return null;
    const range = Number(item._source?.system?.senses?.ranges?.darkvision);
    return (range > 60) ? { update : { "system.senses.ranges.darkvision" : 60 } } : null;
  }

  /* Species traits (Brave, Fey Ancestry, Dwarven Resilience) */
  static speciesEnabled(){
    return (game.system.id === "dnd5e") && settings.value("speciesRules");
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    itemFixes.add({ name : "Tiefling darkvision", where : "owned", plan : item => this.tieflingFix(item) });
    const enabled = () => this.enabled();
    const species = () => this.speciesEnabled();

    /* Savage Attacker */
    rerollButton({ id : this.SAVAGE, feature : this.SAVAGE, roll : "again", once : "turn", enabled, icon : "fa-hand-fist",
      when : card => card.getAssociatedItem?.()?.type === "weapon" });

    /* Lucky : a Luck Point each */
    const luckPoint = (actor, feat) => ({ item : feat, amount : 1 });
    d20Button({ id : this.LUCKY, feature : this.LUCKY, keep : "kh", cost : luckPoint, enabled, icon : "fa-clover",
      label : (actor, feat) => this.luckyLabel(feat, "adv") });
    d20Button({ id : `${this.LUCKY}-against`, feature : this.LUCKY, keep : "kl", against : true, tests : ["attack"], cost : luckPoint, enabled, icon : "fa-clover",
      label : (actor, feat) => this.luckyLabel(feat, "dis") });

    /* Tavern Brawler */
    unarmedDamage(this.BRAWLER, { die : 4, reroll : 1, enabled });
    onHitMove({ id : this.BRAWLER, feature : this.BRAWLER, feet : 5, once : "turn", enabled,
      when : row => row.unarmed || (idOf(row.item) === this.BRAWLER) });

    /* Alert */
    initiativeSwap(this.ALERT, { enabled });

    /* Healer : Healing Rerolls */
    onDamage((attack, damage) => this.healingRerolls(attack, damage));

    /* Tortle : Claws */
    unarmedDamage("claws", { die : 6, type : "slashing", enabled : species, when : attack => this.isTortle(attack.actor) });

    for(const [id, against] of Object.entries(this.SAVE_ADVANTAGES)) saveModeAgainst(id, against, { enabled : species });
    Hooks.on("dnd5e.preUseActivity", activity => this.battleMedicKit(activity));
    Hooks.on("dnd5e.postUseActivity", activity => this.shellDefense(activity));
    /* Shell Defense again while in the shell : a toggle, it emerges (nothing else happens) */
    uses.onActivity("shellToggle", async (activity, ctx, next) => {
      const actor = activity?.actor;
      if(!this.speciesEnabled() || (idOf(activity?.item) !== this.SHELL) || !actor?.effects?.some?.(e => e.getFlag(module.id, "rule")?.shell)) return next();
      await this.emerge(actor);
      return null;
    });
    Hooks.on("dnd5e.preApplyDamage", (actor, amount, updates, options) => this.relentless(actor, amount, updates, options));
    Hooks.on("dnd5e.restCompleted", (actor, result) => { if(result?.longRest && actor?.isOwner && actor.getFlag(module.id, "relentlessUsed")) actor.unsetFlag(module.id, "relentlessUsed"); });
    Hooks.on("dnd5e.postUseActivity", activity => this.battleMedicSpendKit(activity));
    Hooks.on(`${module.id}.preApplyRow`, (message, actor) => this.battleMedicHitDie(message, actor));

    /* Using the Healer feat itself : Battle Medic, sized by the target's Hit Dice */
    uses.onItem("healer", (item, ctx, next) => {
      if(!ctx.config.chooseActivity && this.enabled() && ((item.identifier ?? item.system?.identifier) === this.HEALER)) return this.battleMedic(item, ctx.config.event);
      return next();
    });
  }

  /* ---------- Save traits ---------- */

  /* Advantage on saves to avoid or end these conditions, by the item identifier of the trait that grants it (saveModeAgainst) */
  static SAVE_ADVANTAGES = {
    "brave" : ["frightened"],
    "fey-ancestry" : ["charmed"],
    "dwarven-resilience" : ["poisoned"],
  };

  /* ---------- Origin feats ---------- */

  static SAVAGE = "savage-attacker";
  static LUCKY = "lucky";
  static BRAWLER = "tavern-brawler";
  static ALERT = "alert";

  /* "Lucky : advantage (2)" : the Luck Points left */
  static luckyLabel(feat, mode){
    return module.format(`feats.lucky.${mode}`, { name : feat.name, left : feat.system.uses?.value ?? 0 });
  }

  /* ---------- Healer ---------- */

  static HEALER = "healer";

  static isBattleMedic(activity){
    const id = activity?.item?.identifier ?? activity?.item?.system?.identifier;
    return (id === this.HEALER) && (activity.type === "heal");
  }

  static healersKit(actor){
    return actor?.items?.find(i => ((i.identifier ?? i.system?.identifier) === "healers-kit") || /^healer.?s kit$/i.test(i.name ?? "")) ?? null;
  }

  /* ---------- Relentless Endurance ---------- */

  static RELENTLESS = "relentless-endurance";

  /* Dropped to 0 but not killed outright : 1 HP, once until a Long Rest. dnd5e's pending update is changed now
     (no await before it); the use and the message follow. */
  static relentless(actor, amount, updates, options = {}){
    if(!(this.speciesEnabled() || this.enabled()) || !(amount > 0) || !actor?.isOwner) return;
    /* By identifier, or by name (case and anything in parentheses ignored : "Relentless Endurance (1/Day)") */
    const plain = n => String(n ?? "").replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
    const item = actor.items?.find?.(i => ((i.identifier ?? i.system?.identifier) === this.RELENTLESS) || (plain(i.name) === "relentless endurance"));
    if(!item) return;
    const uses = item.system?.uses;
    const tracked = Number(uses?.max) > 0;
    if(tracked ? !(Number(uses.value) > 0) : actor.getFlag(module.id, "relentlessUsed")) return;
    if(!preventDropToZero(actor, amount, updates, { hp : 1, massiveDamage : true })) return;
    (async () => {
      if(tracked) await item.update({ "system.uses.spent" : (Number(uses.spent) || 0) + 1 });
      else await actor.setFlag(module.id, "relentlessUsed", true);
      await ChatMessage.implementation.create({ speaker : ChatMessage.implementation.getSpeaker({ actor }),
        content : `<p>${esc(module.format("species.relentless", { name : actor.name, item : item.name }))}</p>` });
      const { combatLog } = await import('./combat-log.js');
      await combatLog.add(actor, module.format("species.relentlessLog", { item : item.name }));
    })().catch(error => log.debug(error));
  }

  /* ---------- Tortle ---------- */

  static isTortle(actor){
    return !!actor?.items?.some?.(i => (i.type === "race") && String(i.system?.identifier ?? "").startsWith("tortle"));
  }

  static SHELL = "shell-defense";

  /* Shell Defense used : in its shell until it emerges */
  static async shellDefense(activity){
    const item = activity?.item, actor = activity?.actor;
    if(!this.speciesEnabled() || !actor?.isOwner || ((item?.identifier ?? item?.system?.identifier) !== this.SHELL)) return;
    if(actor.effects.some(e => e.getFlag(module.id, "rule")?.shell)) return;
    const changes = [
      { key : "system.attributes.ac.bonus", type : "add", mode : 2, value : "4" },
      { key : "system.abilities.str.save.roll.mode", type : "add", mode : 2, value : "1" },
      { key : "system.abilities.con.save.roll.mode", type : "add", mode : 2, value : "1" },
      { key : "system.abilities.dex.save.roll.mode", type : "add", mode : 2, value : "-1" },
      ...["walk", "fly", "climb", "swim", "burrow"].map(kind => ({ key : `system.attributes.movement.speeds.${kind}`, type : "override", mode : 5, value : "0" })),
    ];
    await actor.createEmbeddedDocuments("ActiveEffect", [{ name : item.name, img : item.img, origin : item.uuid, changes,
      flags : { [module.id] : { rule : { shell : true, noReactions : true } } } }]);
    if(!actor.statuses?.has?.("prone")) await actor.toggleStatusEffect("prone", { active : true });
  }

  /* Emerge (its Bonus Action) : out of the shell, still Prone */
  static async emerge(actor){
    const shell = actor?.effects?.filter?.(e => e.getFlag(module.id, "rule")?.shell) ?? [];
    if(!shell.length) return;
    const { actionTracker } = await import('./action-tracker.js');
    await actor.deleteEmbeddedDocuments("ActiveEffect", shell.map(e => e.id), { [module.id] : { reason : module.i18n("species.emerged") } });
    await actionTracker.spend(actor, { kind : "bonus", what : module.i18n("species.emerge") }).catch(() => null);
  }

  /* Healing Rerolls : a spell's healing dice reroll 1s (once), for a caster with the Healer feat */
  static healingRerolls(attack, damage){
    if(!this.enabled() || (attack.type !== "heal") || !attack.spell || !findItem(attack.actor, this.HEALER)) return;
    damage.reroll(1);
  }

  /**
   * Battle Medic : pick a creature within 5 ft (yourself too), read its remaining Hit Dice, and use the Healer's
   * "Heal dX" activity of that size (asking which when it has several). The kit and the Hit Die are handled when the
   * activity is used and when its healing is applied.
   */
  static async battleMedic(item, event){
    const activities = item.system.activities?.filter(a => a.type === "heal") ?? [];
    if(!activities.length) return null;
    if(this.battleMedicKit(activities[0]) === false) return null;

    const pick = settings.value("rollItemPick");
    const [token] = await pickTargets(item, { count : 1, range : canvas.scene?.grid.distance ?? 5, disposition : "any",
      includeSelf : true, useTargets : pick !== "always", confirm : "auto" });
    const target = token?.actor;
    if(!target) return null;

    /* Its Hit Dice : remaining, by size */
    const sizes = new Map();
    for(const cls of target.items.filter(i => i.type === "class")){
      const left = Number(cls.system.hd?.value) || 0;
      const die = String(cls.system.hd?.denomination ?? "");
      if(left > 0 && die) sizes.set(die, (sizes.get(die) ?? 0) + left);
    }
    if(!sizes.size){
      ui.notifications.warn(module.format("feats.healer.noHitDice", { name : target.name }));
      return null;
    }
    let die = [...sizes.keys()][0];
    if(sizes.size > 1){
      /* It's the healed creature's Hit Die to spend : its player picks the size (the healer when it's theirs or an NPC) */
      const player = gm.playerFor(target);
      if(player && !player.isSelf) ui.notifications.info(module.format("feats.healer.asking", { name : target.name, player : player.name }));
      die = await gm.askPlayer(target, {
        title : item.name, icon : "fa-solid fa-kit-medical",
        content : `<p>${module.format("feats.healer.chooseDie", { name : foundry.utils.escapeHTML(target.name), healer : foundry.utils.escapeHTML(item.actor?.name ?? "") })}</p>`,
        buttons : [...sizes].sort((a, b) => parseInt(b[0].slice(1)) - parseInt(a[0].slice(1))).map(([d, left], i) => ({
          action : d, label : `${d} (${left})`, default : i === 0,
        })),
      });
      if(!die || !sizes.has(die)) return null;
    }

    const activity = activities.find(a => new RegExp(`\\b${die}\\b`, "i").test(a.name ?? ""));
    if(!activity){
      ui.notifications.warn(module.format("feats.healer.noActivity", { item : item.name, die }));
      return null;
    }
    return activity.use({ event, [module.id] : { skipPick : true } });
  }

  /* Battle Medic needs a Healer's Kit use */
  static battleMedicKit(activity){
    if(!this.enabled() || !this.isBattleMedic(activity)) return;
    const kit = this.healersKit(activity.actor);
    if(kit && (!(Number(kit.system.uses?.max) > 0) || (Number(kit.system.uses?.value) > 0))) return;
    ui.notifications.warn(module.i18n("feats.healer.noKit"));
    return false;
  }

  static async battleMedicSpendKit(activity){
    if(!this.enabled() || !this.isBattleMedic(activity) || !activity.actor?.isOwner) return;
    const kit = this.healersKit(activity.actor);
    if(kit && (Number(kit.system.uses?.max) > 0)) await spendUses(kit, 1, { warn : false });
  }

  /* Battle Medic : the target spends one of its Hit Dice of the size used ("Heal d8"), or it can't be applied */
  static battleMedicHitDie(message, actor){
    if(!this.enabled()) return;
    const activity = message.getAssociatedActivity?.();
    if(!this.isBattleMedic(activity)) return;
    const size = String(activity.name ?? "").match(/d(\d+)/i)?.[1];
    if(!size) return;
    const cls = (actor.items?.filter?.(i => i.type === "class") ?? [])
      .find(c => (String(c.system.hd?.denomination) === `d${size}`) && (Number(c.system.hd?.value) > 0));
    if(!cls){
      ui.notifications.warn(module.format("feats.healer.noHitDie", { name : actor.name, die : `d${size}` }));
      return false;
    }
    cls.update({ "system.hd.spent" : (Number(cls.system.hd.spent) || 0) + 1 });
  }
}
