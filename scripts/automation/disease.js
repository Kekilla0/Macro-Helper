import { module } from '../module.js';
import { logger } from '../log.js';
import { gm } from '../gm.js';
import { esc, buttonRow, addButton, makeButton } from '../helpers/utils.js';
const log = logger.for(import.meta.url);

/**
 * Diseases (a card macro's applyDisease, Death Dog's Bite) : one effect that cascades. All its data is on the effect
 * (flags.macro-helper.disease) : { ability, dc, every (seconds), next (world time), stage, stages, removal, from }.
 *   stages  : what each failure brings, in order : [{ type, with, hpMax, changes, name }] (hpMax : a number or a
 *             formula, "-1d10", rolled each time that stage comes). The first comes with the
 *             failed save that gave it; each failed repeat save adds the next; past the last, the last again (Death
 *             Dog : its Hit Point maximum drops 5 more each time). Conditions and changes add up.
 *   every   : as game time passes, each time that much has gone by, its owner gets a card to roll the save again.
 *   cure    : what a successful save does : "full" (default : it ends, Death Dog) or "stage" (the latest stage goes,
 *             the one before stays; a success at the first stage ends it). Each stage's own statuses and rolled
 *             changes are kept (flags applied), so one goes back exactly.
 *   removal : what ends it : "save" (a success), "rest" (a Long Rest), "magical" (a spell or magic : by hand, the
 *             effect says so). A rest never brings back what it took otherwise : its changes are on the effect.
 */
export class disease{
  static UNITS = { s : 1, sec : 1, second : 1, m : 60, min : 60, minute : 60, h : 3600, hr : 3600, hour : 3600, d : 86400, day : 86400 };

  static register(){
    if(game.system.id !== "dnd5e") return;
    Hooks.on("updateWorldTime", () => this.due());
    Hooks.on("renderChatMessageHTML", (message, html) => this.render(message, html));
    Hooks.on("dnd5e.restCompleted", (actor, result) => this.onRest(actor, result));
    gm.handle("diseaseRoll", (data, user) => this.rolledAsGM(data, user));
  }

  /* "24h", "1 day", "10 minutes", 3600 : seconds */
  static seconds(every){
    if(Number.isFinite(Number(every))) return Number(every);
    const m = String(every ?? "").trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([a-z]+?)s?$/);
    return m ? Number(m[1]) * (this.UNITS[m[2]] ?? 0) : 0;
  }

  /* One stage's statuses and changes (its Hit Point maximum change rolled now : "-1d10") */
  static async stageData(stage = {}){
    const statuses = [stage.type, ...[stage.with ?? []].flat()].filter(Boolean);
    const changes = [...(stage.changes ?? [])];
    let hpMax = 0;
    if((stage.hpMax !== undefined) && (stage.hpMax !== null) && (stage.hpMax !== 0)){
      hpMax = Number.isFinite(Number(stage.hpMax)) ? Number(stage.hpMax)
        : Number((await new Roll(String(stage.hpMax)).evaluate()).total) || 0;
      if(hpMax) changes.push({ key : "system.attributes.hp.tempmax", type : "add", mode : 2, value : String(hpMax) });
    }
    return { statuses, changes, hpMax };
  }

  /* The card's failed save : the disease on the creature, its first stage */
  static async applyTo(actor, part, { origin = null } = {}){
    const item = origin ? fromUuidSync(origin, { strict : false }) : null;
    const name = part.name ?? item?.name ?? module.i18n("disease.name");
    const stages = (part.stages ?? []).filter(Boolean);
    const first = await this.stageData(stages[0]);
    const every = this.seconds(part.every);
    const removal = [part.removal ?? ["save"]].flat();
    const old = actor.effects.filter(e => e.getFlag(module.id, "disease") && (e.origin === origin));
    if(old.length) return log.debug("Already diseased", actor.name, name);
    await actor.createEmbeddedDocuments("ActiveEffect", [{ name, img : part.img ?? item?.img ?? "icons/svg/biohazard.svg", origin,
      statuses : first.statuses, changes : first.changes,
      description : `<p>${esc(module.format("disease.summary", { ability : CONFIG.DND5E.abilities[part.ability]?.label ?? part.ability, dc : part.dc,
        every : part.every, removal : removal.map(r => module.i18n(`disease.removal.${r}`)).join(", ") }))}</p>`,
      flags : { [module.id] : { cardCondition : true, disease : { ability : part.ability, dc : Number(part.dc) || null, every,
        next : every ? (game.time.worldTime + every) : null, stage : 0, stages, removal, cure : part.cure ?? "full", from : origin,
        applied : [{ statuses : first.statuses, changes : first.changes }] } } } }]);
  }

  /* Game time passed : each disease that's due posts its save card (the active GM), once per period */
  static async due(){
    if(!game.users.activeGM?.isSelf) return;
    const now = game.time.worldTime;
    for(const actor of gm.actors()){
      for(const effect of [...actor.effects]){
        const d = effect.getFlag(module.id, "disease");
        if(!d?.every || !Number.isFinite(d.next) || (d.next > now)) continue;
        await effect.setFlag(module.id, "disease.next", now + d.every);
        await this.post(actor, effect, d).catch(error => log.error(error));
      }
    }
  }

  static async post(actor, effect, d){
    const ability = CONFIG.DND5E.abilities[d.ability]?.label ?? d.ability;
    return ChatMessage.implementation.create({
      speaker : ChatMessage.implementation.getSpeaker({ actor }),
      content : `<p>${esc(module.format("disease.due", { name : actor.name, effect : effect.name, ability, dc : d.dc ?? "?" }))}</p>`,
      flags : { [module.id] : { diseaseCard : { actor : actor.uuid, effect : effect.uuid, rolled : false } } },
    });
  }

  /* The card's button : for the creature's owner (the GM for monsters) */
  static render(message, html){
    const data = message.getFlag?.(module.id, "diseaseCard");
    if(!data) return;
    const actor = fromUuidSync(data.actor, { strict : false });
    const effect = fromUuidSync(data.effect, { strict : false });
    if(!actor?.isOwner) return;
    const row = buttonRow(html, { key : `${module.id}-disease` });
    if(row.childElementCount) return;
    if(!effect) return addButton(row, makeButton({ icon : "fa-check", text : module.i18n("disease.ended"), disabled : true }));
    const d = effect.getFlag(module.id, "disease") ?? {};
    const ability = String(CONFIG.DND5E.abilities[d.ability]?.abbreviation ?? d.ability).toUpperCase();
    addButton(row, makeButton({ icon : "fa-dice-d20", text : `${ability} ${d.dc ?? ""}`.trim(), once : true, disabled : !!data.rolled,
      onClick : () => this.roll(message, actor, effect) }));
  }

  static async roll(message, actor, effect){
    const d = effect.getFlag(module.id, "disease") ?? {};
    const rolls = await actor.rollSavingThrow({ ability : d.ability, target : d.dc ?? undefined });
    const roll = Array.isArray(rolls) ? rolls[0] : rolls;
    if(!roll) return;
    const success = Number.isFinite(d.dc) ? (roll.total >= d.dc) : !!roll.isSuccess;
    await gm.run("diseaseRoll", { message : message.id, effect : effect.uuid, success });
  }

  /* GM : a success ends it (when a save can), a failure brings the next stage (past the last : the last again) */
  static async rolledAsGM({ message : id, effect : uuid, success } = {}, user){
    const message = game.messages.get(id);
    const effect = fromUuidSync(uuid ?? "", { strict : false });
    const actor = effect?.parent;
    if(!message || !effect || !(user.isGM || actor?.testUserPermission(user, "OWNER"))) return false;
    if(message.getFlag(module.id, "diseaseCard.rolled")) return false;
    await message.setFlag(module.id, "diseaseCard.rolled", true);
    const d = effect.getFlag(module.id, "disease") ?? {};
    if(success){
      if(!(d.removal ?? []).includes("save")) return true;
      const applied = [...(d.applied ?? [])];
      /* One stage back (cure "stage") : the latest stage's statuses and changes go */
      if((d.cure === "stage") && (applied.length > 1)){
        applied.pop();
        await effect.update({ statuses : [...new Set(applied.flatMap(a => a.statuses ?? []))], changes : applied.flatMap(a => a.changes ?? []),
          [`flags.${module.id}.disease.applied`] : applied, [`flags.${module.id}.disease.stage`] : Math.max(0, (Number(d.stage) || 0) - 1) });
        ui.notifications.info(module.format("disease.better", { name : actor.name, effect : effect.name }));
        return true;
      }
      await effect.delete({ [module.id] : { reason : module.i18n("disease.saved") } });
      ui.notifications.info(module.format("disease.cured", { name : actor.name, effect : effect.name }));
      return true;
    }
    const stages = d.stages ?? [];
    const stage = Math.min((Number(d.stage) || 0) + 1, Math.max(0, stages.length - 1));
    const next = await this.stageData(stages[stage]);
    const statuses = [...new Set([...(effect.statuses ?? []), ...next.statuses])];
    const changes = [...(effect.toObject().changes ?? []), ...next.changes];
    await effect.update({ statuses, changes, [`flags.${module.id}.disease.stage`] : stage,
      [`flags.${module.id}.disease.applied`] : [...(d.applied ?? []), { statuses : next.statuses, changes : next.changes }] });
    const lost = next.hpMax ? ` ${module.format("disease.hpMax", { n : Math.abs(next.hpMax) })}` : "";
    ui.notifications.info(module.format("disease.worse", { name : actor.name, effect : effect.name }) + lost);
    await ChatMessage.implementation.create({ speaker : ChatMessage.implementation.getSpeaker({ actor }),
      content : `<p>${esc(module.format("disease.worse", { name : actor.name, effect : effect.name }) + lost)}</p>` }).catch(() => null);
    return true;
  }

  /* A Long Rest ends the diseases a rest can end */
  static async onRest(actor, result){
    if(!result?.longRest || !actor?.isOwner) return;
    const ended = actor.effects.filter(e => (e.getFlag(module.id, "disease")?.removal ?? []).includes("rest"));
    if(ended.length) await actor.deleteEmbeddedDocuments("ActiveEffect", ended.map(e => e.id), { [module.id] : { reason : module.i18n("disease.rested") } }).catch(error => log.debug(error));
  }
}
