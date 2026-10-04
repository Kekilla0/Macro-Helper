import { module } from '../module.js';
import { settings } from '../settings.js';
import { logger } from '../log.js';
import { gm } from '../gm.js';
import { rerolls, extraD20 } from '../roll-item/rerolls.js';
import { feats } from './feats.js';
const log = logger.for(import.meta.url);

/**
 * Auto-Roll Initiative, done by the active GM once the combat update has landed : when combat begins, everyone
 * without an initiative rolls, and the first turn goes to the top of the new order. Anyone added later rolls as they
 * join, and the current turn stays where it is. Rolled initiative goes through
 * dnd5e (its bonuses, Alert's card...). Homebrew's Initiative Each Round uses roll() too.
 *
 * Compact Initiative : instead of one chat message per combatant, one card per combat round lists everyone's
 * initiative, highest first (hover a total for its dice), with a Reroll button for the combatant's owner and the GM.
 * Hidden combatants go on a second card only the GM sees. The GM's client keeps the cards : players' own rolls are
 * sent there. The card shows the tracker's current initiative (a swap or an edit re-sorts it), and an Alert
 * character's swap offer : buttons on its allies' rows, each previewing where both would end up.
 *
 * Summons join the combat their summoner is in (Summon Initiative setting) : Roll Initiative (their own roll, now when
 * the combat is under way, else with everyone) or Shared Initiative (right after the summoner, following its
 * initiative when it changes).
 */
export class initiative{
  static register(){
    Hooks.on("updateCombat", (combat, changes) => this.onUpdate(combat, changes));
    Hooks.on("createCombatant", combatant => this.onJoin(combatant));
    Hooks.on("preCreateChatMessage", (message, data, options, userId) => this.onPreCreate(message, userId));
    Hooks.on("dnd5e.renderChatMessage", (message, html) => this.wireCard(message, html));
    /* The card follows the tracker : initiative changes, swap offers, turns passing */
    Hooks.on("updateCombatant", combatant => this.redraw(combatant.combat ?? combatant.parent));
    Hooks.on("updateCombat", combat => this.redraw(combat));
    gm.handle("initiativeRows", (data, user) => this.addRowsAsGM(data, user));
    /* Summons : dnd5e's own and the module's familiars (both announce dnd5e.postSummon) */
    Hooks.on("dnd5e.postSummon", (activity, profile, tokens) => this.onSummon(activity?.actor, tokens));
    Hooks.on("updateCombatant", (combatant, changes) => this.followLeader(combatant, changes));
    gm.handle("summonsJoin", (data, user) => this.summonsJoinAsGM(data, user));
  }

  static async onUpdate(combat, changes = {}){
    if(!game.users.activeGM?.isSelf || !("round" in changes)) return;
    const round = Number(changes.round) || 0;
    /* Combat began : round 0 to 1 */
    if((round !== 1) || !(settings.value("initiativeMethod") === "auto")) return;
    const ids = combat.combatants.filter(c => (c.initiative === null) && !this.leaderOf(c)).map(c => c.id);
    if(ids.length) await this.roll(combat, ids, "begin");
  }

  /* Joining a combat already under way : roll now, keeping whoever's turn it is */
  static async onJoin(combatant){
    const combat = combatant?.combat ?? combatant?.parent;
    if(!game.users.activeGM?.isSelf || !combat?.started || !(settings.value("initiativeMethod") === "auto") || (combatant.initiative !== null)) return;
    if(this.leaderOf(combatant)) return;
    log.debug("Rolling initiative", "joined", combatant.name);
    await combat.rollInitiative([combatant.id], { updateTurn : true });
  }

  /* ---------- Summons ---------- */

  /* Shared Initiative : just after its summoner */
  static SHARED_GAP = 0.01;

  /* The combatant a summon shares initiative with (Shared Initiative), by id */
  static leaderOf(combatant){
    return combatant?.getFlag?.(module.id, "sharedWith") ?? null;
  }

  /**
   * Summoned tokens join the summoner's combat. From the summoning client : the active GM adds them.
   * @param {Actor} summoner
   * @param {TokenDocument[]} tokens
   */
  static async onSummon(summoner, tokens = []){
    const uuids = (tokens ?? []).map(t => t?.uuid ?? t?.document?.uuid).filter(Boolean);
    if(!summoner || !uuids.length) return;
    try { await gm.run("summonsJoin", { summoner : summoner.uuid, tokens : uuids }); }
    catch(error){ log.error("Summons joining combat", error); }
  }

  /* The summoner's combatant in a combat : its token's, or its Wild Shape form's */
  static summonerIn(combat, summoner){
    return combat.combatants.find(c => c.actor && ((c.actor.id === summoner.id) || (c.actor.uuid === summoner.uuid)
      || (c.actor.getFlag?.("dnd5e", "originalActor") === summoner.id))) ?? null;
  }

  static async summonsJoinAsGM({ summoner : uuid, tokens = [] } = {}, user){
    const summoner = fromUuidSync(uuid ?? "", { strict : false });
    if(!summoner?.testUserPermission(user, "OWNER")) return false;
    const shared = settings.value("summonInitiative") === "shared";
    for(const tokenUuid of tokens){
      const token = fromUuidSync(tokenUuid, { strict : false });
      if(!token?.parent) continue;
      const combat = game.combats.find(c => ((c.scene?.id ?? c.scene) === token.parent.id) && this.summonerIn(c, summoner))
        ?? game.combats.find(c => !c.scene && this.summonerIn(c, summoner));
      if(!combat || combat.combatants.some(c => c.tokenId === token.id)) continue;
      const leader = this.summonerIn(combat, summoner);
      const data = { tokenId : token.id, sceneId : token.parent.id, actorId : token.actorId, hidden : token.hidden };
      if(shared){
        data.initiative = (leader.initiative === null) ? null : (leader.initiative - this.SHARED_GAP);
        data.flags = { [module.id] : { sharedWith : leader.id } };
      }
      const [combatant] = await combat.createEmbeddedDocuments("Combatant", [data]);
      log.debug("Summon joins combat", token.name, shared ? "shared" : "rolls");
      /* Its own roll now, when Auto-Rolled Initiative isn't doing it already (onJoin) */
      if(!shared && combatant && combat.started && (combatant.initiative === null) && (settings.value("initiativeMethod") !== "auto")){
        await combat.rollInitiative([combatant.id], { updateTurn : true });
      }
    }
    return true;
  }

  /* Shared Initiative : the summoner's initiative changes (rolled, rerolled, swapped), its summons follow (active GM) */
  static async followLeader(combatant, changes){
    if(!game.users.activeGM?.isSelf || !("initiative" in (changes ?? {}))) return;
    const combat = combatant.combat ?? combatant.parent;
    const followers = combat?.combatants?.filter(c => this.leaderOf(c) === combatant.id) ?? [];
    if(!followers.length) return;
    const initiative = (combatant.initiative === null) ? null : (combatant.initiative - this.SHARED_GAP);
    const updates = followers.filter(c => c.initiative !== initiative).map(c => ({ _id : c.id, initiative }));
    if(updates.length) await combat.updateEmbeddedDocuments("Combatant", updates);
  }

  /* Roll, then start from the top of the new order */
  static async roll(combat, ids, why){
    log.debug("Rolling initiative", why, ids.length);
    await combat.rollInitiative(ids, { updateTurn : false });
    await combat.update({ turn : 0 });
  }

  /* ---------- Compact Initiative ---------- */

  static #pending = [];
  static #rolling = [];
  static #flush = null;
  static #chain = Promise.resolve();

  static compact(){
    return settings.value("initiativeMessages") === "compact";
  }

  /* An initiative message about to be made here : its roll goes to the round's card instead (Foundry already set the
     combatant's initiative) */
  static onPreCreate(message, userId){
    if((userId !== game.user.id) || !this.compact() || !message.getFlag?.("core", "initiativeRoll")) return;
    const combat = game.combat;
    const roll = message.rolls?.[0];
    const { token, actor } = message.speaker ?? {};
    const combatant = combat?.combatants.find(c => (token && (c.tokenId === token)) || (!token && (c.actorId === actor)));
    if(!roll || !combatant) return;
    this.#rolling.push(this.#show(roll, combatant));
    this.#pending.push({ combatant : combatant.id, roll : JSON.stringify(roll) });
    clearTimeout(this.#flush);
    this.#flush = setTimeout(async () => {
      /* The numbers go on the card once the dice have landed */
      await Promise.allSettled(this.#rolling.splice(0));
      const rows = this.#pending.splice(0);
      if(rows.length) gm.run("initiativeRows", { combat : combat.id, rows }).catch(error => log.error(error));
    }, 150);
    return false;
  }

  /* The dice still roll (Dice So Nice), privately for hidden combatants */
  static #show(roll, combatant){
    /* No Dice So Nice : the dice sound, once for a batch */
    if(!game.dice3d){
      if(!this.#pending.length) foundry.audio.AudioHelper.play({ src : CONFIG.sounds.dice }, true);
      return;
    }
    const whisper = combatant.hidden ? game.users.filter(u => u.isGM).map(u => u.id) : null;
    /* In the colours of the combatant's player (their own dice), the GM's for creatures no player owns */
    const player = (combatant.players ?? []).find(u => u.active && !u.isGM) ?? (combatant.players ?? []).find(u => !u.isGM) ?? game.user;
    return game.dice3d.showForRoll(roll, player, true, whisper);
  }

  /**
   * The GM's client : put rows on the round's card(s), made the first time. The asker must own each combatant.
   * @param {{ combat : string, rows : { combatant : string, roll : string }[], reroll? : boolean }} data
   */
  static addRowsAsGM(data, user){
    const run = this.#chain.then(() => this.#addRows(data, user));
    this.#chain = run.catch(() => {});
    return run;
  }

  static async #addRows({ combat : combatId, rows = [], reroll = false } = {}, user){
    const combat = game.combats.get(combatId);
    if(!combat) return false;
    const allowed = rows.filter(r => {
      const c = combat.combatants.get(r.combatant);
      return c && (user?.isGM || c.actor?.testUserPermission(user, "OWNER"));
    });
    for(const hidden of [false, true]){
      const mine = allowed.filter(r => !!combat.combatants.get(r.combatant).hidden === hidden);
      if(mine.length) await this.#write(combat, mine, hidden);
    }
    /* A reroll from the card : the combatant's initiative follows */
    if(reroll){
      const updates = allowed.map(r => ({ _id : r.combatant, initiative : Roll.fromData(JSON.parse(r.roll)).total }));
      await combat.updateEmbeddedDocuments("Combatant", updates);
    }
    return true;
  }

  /* The round's card for these rows (public, or the GM's for hidden combatants) : made or updated */
  static async #write(combat, rows, hidden){
    const key = { combat : combat.id, round : combat.round, hidden };
    const card = game.messages.contents.findLast(m => {
      const info = m.getFlag(module.id, "initiative");
      return info && (info.combat === key.combat) && (info.round === key.round) && (!!info.hidden === hidden);
    });
    /* One roll per combatant : a new one replaces the old */
    const byCombatant = new Map((card?.rolls ?? []).map(r => [r.options?.[module.id]?.combatant, r]));
    for(const row of rows){
      const roll = Roll.fromData(JSON.parse(row.roll));
      roll.options[module.id] = { ...(roll.options[module.id] ?? {}), combatant : row.combatant };
      byCombatant.set(row.combatant, roll);
    }
    const rolls = [...byCombatant.values()].filter(Boolean);
    const content = this.#content(combat, rolls, hidden);
    /* The dice already rolled where they were rolled : Dice So Nice mustn't roll them again */
    const skip = game.dice3d ? { "dice-so-nice" : { skip : true } } : {};
    if(card) return card.update({ content, rolls : rolls.map(r => JSON.stringify(r)), flags : skip });
    return ChatMessage.implementation.create({
      speaker : { alias : module.i18n("initiative.title") },
      content, rolls : rolls.map(r => JSON.stringify(r)), sound : null,
      whisper : hidden ? game.users.filter(u => u.isGM).map(u => u.id) : [],
      flags : { [module.id] : { initiative : key }, ...skip },
    });
  }

  static #content(combat, rolls, hidden){
    const esc = s => foundry.utils.escapeHTML(String(s ?? ""));
    const rows = rolls
      .map(roll => ({ roll, combatant : combat.combatants.get(roll.options?.[module.id]?.combatant) }))
      .filter(r => r.combatant)
      .sort((a, b) => b.roll.total - a.roll.total)
      .map(({ roll, combatant }) => `
        <li class="macro-helper-row" data-combatant="${combatant.id}">
          <img class="token" src="${esc(combatant.img)}" alt="">
          <span class="name">${esc(combatant.name)}</span>
          <span class="result" data-tooltip="${esc(`${roll.result} = ${roll.total}`)}">${roll.total}</span>
        </li>`).join("");
    const title = module.format(hidden ? "initiative.hiddenRound" : "initiative.round", { round : combat.round || 1 });
    return `<div class="macro-helper-initiative"><p class="title"><strong>${esc(title)}</strong></p><ul class="unlist macro-helper-rows">${rows}</ul></div>`;
  }

  /* Redraw a combat's initiative cards for the current round */
  static redraw(combat){
    if(!combat || !this.compact()) return;
    for(const message of game.messages.contents){
      const info = message.getFlag?.(module.id, "initiative");
      if(info && (info.combat === combat.id) && (info.round === combat.round)) ui.chat?.updateMessage(message);
    }
  }

  static ordinal(n){
    const s = ["th", "st", "nd", "rd"], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  /* Where two combatants would be in the order if they traded initiative : { mine, theirs } as places (1 = first) */
  static previewSwap(combat, a, b){
    const swapped = feats.swappedInitiatives(a, b);
    const list = (combat.combatants.contents ?? [...combat.combatants]).filter(c => c.initiative !== null)
      .map(c => ({ id : c.id, init : (c.id === a.id) ? swapped.a : (c.id === b.id) ? swapped.b : c.initiative }));
    list.sort((x, y) => y.init - x.init);
    return { mine : list.findIndex(c => c.id === a.id) + 1, theirs : list.findIndex(c => c.id === b.id) + 1, a : swapped.a, b : swapped.b };
  }

  static #button(icon, label, onClick){
    const button = document.createElement("button");
    button.type = "button";
    button.className = "icon";
    button.dataset.tooltip = label;
    button.ariaLabel = label;
    button.innerHTML = `<i class="fa-solid ${icon}" inert></i>`;
    button.addEventListener("click", async event => {
      event.preventDefault();
      button.disabled = true;
      try { await onClick(event); }
      catch(error){ ui.notifications.warn(error.message); }
      finally { button.disabled = false; }
    });
    return button;
  }

  /* The rows : current initiative and order, Reroll for each row's owner and the GM, Alert's swap offer */
  static wireCard(message, html){
    const info = message.getFlag?.(module.id, "initiative");
    const combat = info ? game.combats.get(info.combat) : null;
    if(!combat) return;
    const list = html.querySelector(".macro-helper-initiative ul");
    const items = [...html.querySelectorAll(".macro-helper-initiative li[data-combatant]")];

    /* The tracker's initiative (after a swap or an edit), highest first */
    for(const li of items){
      const combatant = combat.combatants.get(li.dataset.combatant);
      const result = li.querySelector(".result");
      if(combatant && result && Number.isFinite(combatant.initiative) && (String(combatant.initiative) !== result.textContent.trim())){
        result.dataset.tooltip = `${result.dataset.tooltip ?? ""} · ${module.i18n("initiative.changed")}`;
        result.textContent = combatant.initiative;
      }
    }
    if(list) items.sort((a, b) => (combat.combatants.get(b.dataset.combatant)?.initiative ?? -Infinity) - (combat.combatants.get(a.dataset.combatant)?.initiative ?? -Infinity))
      .forEach(li => list.append(li));

    /* Alert : the owner of the Alert character gets a swap on each ally's row, and "Do not swap" on its own */
    if(!info.hidden){
      for(const { combatant : alert } of feats.openAlerts(combat)){
        if(!alert.isOwner) continue;
        const ask = ally => gm.run("alertSwap", { combat : combat.id, combatant : alert.id, ally }, { timeout : 90000 })
          .then(notes => { for(const note of notes ?? []) ui.notifications.info(note); });
        for(const ally of feats.alliesOf(alert, combat)){
          const li = items.find(i => i.dataset.combatant === ally.id);
          if(!li) continue;
          const at = this.previewSwap(combat, alert, ally);
          const label = module.format("feats.alert.preview", { a : alert.name, mine : this.ordinal(at.mine), myInit : at.a,
            b : ally.name, theirs : this.ordinal(at.theirs), theirInit : at.b });
          li.append(this.#button("fa-right-left", label, () => {
            ui.notifications.info("feats.alert.asking", { localize : true });
            return ask(ally.id);
          }));
        }
        items.find(i => i.dataset.combatant === alert.id)?.append(this.#button("fa-ban", module.i18n("feats.alert.keep"), () => ask(null)));
      }
    }

    for(const li of items){
      const combatant = combat.combatants.get(li.dataset.combatant);
      if(!combatant?.isOwner) continue;
      li.append(this.#button("fa-rotate", module.i18n("rerolls.reroll"), event => this.rerollRow(combat, combatant, event)));
    }
  }

  /* A fresh initiative roll for one combatant, with advantage / disadvantage chosen like any reroll */
  static async rerollRow(combat, combatant, event){
    const mode = await rerolls.modeFor(event);
    if(!mode) return;
    let roll = await combatant.getInitiativeRoll().evaluate();
    const keep = (mode.advantage && !mode.disadvantage) ? "kh" : (mode.disadvantage && !mode.advantage) ? "kl" : null;
    if(keep) roll = (await extraD20(roll, keep))?.updated ?? roll;
    await this.#show(roll, combatant);
    await gm.run("initiativeRows", { combat : combat.id, rows : [{ combatant : combatant.id, roll : JSON.stringify(roll) }], reroll : true });
  }
}
