import { module } from '../module.js';
import { logger } from '../log.js';
import { tokenOf, forcedMove } from '../helpers/tokens.js';
const log = logger.for(import.meta.url);

/**
 * Card moves : every push and pull a card offers, at the bottom of the card, one button per creature with its
 * picture and name (the GM's). A click is a forcedMove; the card remembers it was used.
 *
 * Rules add theirs for each creature on the card : Hooks "macro-helper.cardMoves" (message, tokenUuid, moves, { result, ray })
 *   result   { hit } on an attack card (true / false), with { success } once its save is rolled (on-hit saves too)
 *   ray      the attack on a multi-attack card, else null
 *   moves.push({ id, direction, feet, from, name, label, done, allow, after })
 *     id          the rule's, once per creature (and attack)
 *     direction   "away" (a push, the default) or "toward" (a pull)
 *     from        a token, its uuid or a point; the card's creature when left out
 *     name        what moves it (the button's tooltip, Push Into Obstacles' line); the item's when left out
 *     label       the button's words, else "Push 10 ft" / "Pull 10 ft"
 *     done        already used, from what the rule keeps itself (one of a choice, once per turn); else the card's own
 *     allow()     asked on the click : false stops it (Rule Limits : too big to push)
 *     after(moved) once it moved : the feet it went (0 blocked), null when its owner had to ask
 */
export class cardMoves {
  /* Each creature's moves : [{ key, uuid, ray, move }] */
  static entries(message){
    const system = message?.system;
    if(!system || !message.isContentVisible) return [];
    const outcomes = system.outcomes ?? new Map();
    const success = uuid => outcomes.has(uuid) ? (outcomes.get(uuid) === "success") : undefined;
    /* Who's on the card : an attack's targets (each attack's on a multi card) with hit or miss, else the save's */
    const rows = [];
    if(typeof system.targetHits === "function"){
      const rays = system.isMulti ? system.rays.map((_, i) => i) : [null];
      for(const ray of rays){
        const { targets, hits } = system.targetHits(ray);
        for(const t of targets) rows.push({ uuid : t.token, ray, result : { hit : hits.includes(t), success : success(t.token) } });
      }
      /* An on-hit save's own creatures (Ice Knife's burst) */
      for(const uuid of outcomes.keys()) if(!rows.some(r => r.uuid === uuid)) rows.push({ uuid, ray : null, result : { success : success(uuid) } });
    }
    else for(const t of system.targets ?? []){
      rows.push({ uuid : t.token, ray : null, result : outcomes.has(t.token) ? { success : success(t.token) } : null });
    }

    const entries = [];
    for(const { uuid, ray, result } of rows){
      if(!uuid) continue;
      const moves = [];
      Hooks.callAll(`${module.id}.cardMoves`, message, uuid, moves, { result, ray });
      for(const move of moves){
        if(!move?.id || !(Number(move.feet) > 0)) continue;
        entries.push({ key : `${move.id}|${ray ?? "x"}|${uuid}`, uuid, ray, move });
      }
    }
    return entries;
  }

  static flagOf(key){
    return `moved.${String(key).replace(/[.|]/g, "-")}`;
  }

  static isDone(message, { key, move }){
    return !!move.done || !!message.getFlag(module.id, this.flagOf(key));
  }

  /* The bottom of the card : one button per creature (the GM's) */
  static context(message){
    if(!game.user.isGM) return [];
    const item = message.getAssociatedItem?.();
    return this.entries(message).map(entry => {
      const { key, uuid, move } = entry;
      const token = fromUuidSync(uuid, { strict : false });
      if(!token) return null;
      const done = this.isDone(message, entry);
      const pull = move.direction === "toward";
      const words = move.label ?? module.format(pull ? (done ? "tokens.pulled" : "tokens.pull") : (done ? "tokens.pushed" : "tokens.push"), { feet : move.feet });
      return {
        key, uuid, done,
        name : token.name,
        img : token.texture?.src ?? token.actor?.img ?? "icons/svg/mystery-man.svg",
        label : words,
        icon : pull ? "fa-arrows-to-dot" : "fa-arrows-left-right-to-line",
        tooltip : move.name ?? item?.name ?? "",
      };
    }).filter(Boolean);
  }

  /* The GM's click : that creature moved, once */
  static async click(message, key, button = null){
    if(!game.user.isGM || !message) return;
    const entry = this.entries(message).find(e => e.key === key);
    if(!entry || this.isDone(message, entry)) return;
    const { move, uuid } = entry;
    if(button) button.disabled = true;
    try {
      if(move.allow && !(await move.allow())) return;
      const target = fromUuidSync(uuid, { strict : false })?.object;
      const from = this.fromOf(message, move.from);
      if(!target || !from) return;
      const moved = await forcedMove(target, { direction : move.direction ?? "away", feet : Number(move.feet), from,
        item : message.getAssociatedItem?.() ?? null, name : move.name ?? null, confirmed : true });
      await message.setFlag(module.id, this.flagOf(key), true);
      await move.after?.(moved);
    }
    catch(error){
      log.error(error);
      ui.notifications.warn(error.message);
    }
    finally { if(button?.isConnected) button.disabled = this.isDone(message, entry); }
  }

  /* Where it moves from : a point, a token (or its uuid), else the card's creature */
  static fromOf(message, from){
    if(from && Number.isFinite(from.x) && Number.isFinite(from.y) && !from.document && !from.documentName) return from;
    if(typeof from === "string") return fromUuidSync(from, { strict : false })?.object ?? null;
    if(from) return tokenOf(from);
    return message.getAssociatedToken?.()?.object ?? tokenOf(message.getAssociatedActor?.());
  }
}
