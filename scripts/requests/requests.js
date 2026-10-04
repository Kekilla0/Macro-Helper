import { module } from '../module.js';
import { settings } from '../settings.js';
import { logger } from '../log.js';
import { gm } from '../gm.js';
import { limits } from '../rules/limits.js';
import { addDie, extraD20 } from '../roll-item/rerolls.js';
import { bard } from '../rules/classes/bard.js';
import { fighter } from '../rules/classes/fighter.js';
import { spendUses } from '../helpers/items.js';
import { findItem } from '../helpers/actors.js';
const log = logger.for(import.meta.url);

/**
 * Roll Requests (its own settings page) : the GM asks creatures for an ability check, skill, tool or save, with the DC
 * set before anyone rolls. One card, a row per creature; each owner rolls their own row with dnd5e (the Advantage
 * setting applies). The GM's client marks each row ✓ / ✗ against the DC.
 *
 *   The window : the small button by the hotbar (GM), or MacroHelper.rollRequest(). Who (the creatures on the scene,
 *                the player characters not on it), then the check in a tab : what (a category, then which), DC (5 to 30,
 *                ±2), how (Each rolls / Group check : the group succeeds when at least half succeed).
 *   Skill Challenge : more than one tab (the + by the tabs). Each tab is requested when the GM wants, posted exactly
 *                as a single request would be. The window keeps each check's outcome (a group check's; an "each rolls"
 *                check : the same at-least-half); once every tab is decided, a message says whether the challenge
 *                succeeded (a majority of the checks). The window stays open until then.
 *   DM Screen  : players see ✓ / ✗, never the DC.
 *   Messages   : Compact : the rolls go into the card; Reroll by the total (Rule Limits); Lucky / Bardic Inspiration /
 *                Tactical Mind at the card's foot for their owners. Individual : dnd5e's own roll messages, linked.
 *   Whisper    : the cards and the rolls only for the GM and the creatures' owners.
 */
export class rollRequests{
  static DIFFICULTIES = [[5, "veryEasy"], [10, "easy"], [15, "medium"], [20, "hard"], [25, "veryHard"], [30, "nearlyImpossible"]];
  static CATEGORIES = ["check", "save", "skill", "tool"];

  static enabled(){
    return (game.system.id === "dnd5e") && settings.value("requestsEnabled");
  }

  static compact(){
    return settings.value("requestsMessages") !== "individual";
  }

  static register(){
    if(game.system.id !== "dnd5e") return;
    Hooks.on("renderHotbar", (app, html) => this.addButton(html));
    Hooks.once("ready", () => this.addButton(document.getElementById("hotbar")));
    Hooks.on("renderChatMessageHTML", (message, html) => this.renderCard(message, html));
    Hooks.on("createChatMessage", message => this.onRollMessage(message));
    Hooks.on("updateChatMessage", message => {
      this.onRollMessage(message);
      /* A Skill Challenge check's card : the window takes its outcome */
      if(message.getFlag?.(module.id, "request")) RequestWindow.cardChanged(message.id);
    });
    gm.handle("requestStore", (data, user) => this.storeAsGM(data, user));
  }

  /* ---------- The button (GM) ---------- */

  static addButton(html){
    const hotbar = (html instanceof HTMLElement) ? html : html?.[0];
    if(!hotbar || !game.user?.isGM || !this.enabled() || hotbar.querySelector(`.${module.id}-request-button`)) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `${module.id}-request-button`;
    button.dataset.tooltip = module.i18n("requests.button");
    button.ariaLabel = module.i18n("requests.button");
    button.innerHTML = `<i class="fa-solid fa-dice-d20" inert></i>`;
    button.addEventListener("click", event => { event.preventDefault(); this.open(); });
    hotbar.append(button);
  }

  /* The window (one, kept : a Skill Challenge in progress survives closing it) */
  static open(){
    if(game.user.isGM) RequestWindow.show();
  }

  /* ---------- What can be asked ---------- */

  /* By category : ability checks, saves, skills (sorted, with their ability), tools */
  static choices(){
    const label = c => game.i18n.localize(c?.label ?? c ?? "");
    const abilities = Object.entries(CONFIG.DND5E.abilities ?? {});
    const short = k => game.i18n.localize(CONFIG.DND5E.abilities[k]?.abbreviation ?? k).toUpperCase();
    const keyLabel = dnd5e.documents?.Trait?.keyLabel;
    const byName = (x, y) => x.label.localeCompare(y.label);
    return {
      check : abilities.map(([k, a]) => ({ value : `check:${k}`, label : module.format("requests.check", { ability : label(a) }) })),
      save : abilities.map(([k, a]) => ({ value : `save:${k}`, label : module.format("requests.save", { ability : label(a) }) })),
      skill : Object.entries(CONFIG.DND5E.skills ?? {}).map(([k, s]) => ({ value : `skill:${k}`, label : `${label(s)} (${short(s.ability)})` })).sort(byName),
      tool : Object.keys(CONFIG.DND5E.tools ?? {}).map(k => ({ value : `tool:${k}`, label : keyLabel?.(k, { trait : "tool" }) ?? k })).sort(byName),
    };
  }

  static labelOf(kind, key){
    const label = c => game.i18n.localize(c?.label ?? c ?? key);
    if(kind === "check") return module.format("requests.check", { ability : label(CONFIG.DND5E.abilities[key]) });
    if(kind === "save") return module.format("requests.save", { ability : label(CONFIG.DND5E.abilities[key]) });
    if(kind === "skill") return label(CONFIG.DND5E.skills[key]);
    if(kind === "tool") return dnd5e.documents?.Trait?.keyLabel?.(key, { trait : "tool" }) ?? key;
    return key;
  }

  /* A check : { kind, key, label, dc } from "skill:ath" and a DC */
  static checkFor(what, dc){
    const [kind, key] = String(what).split(":");
    return { kind, key, label : this.labelOf(kind, key), dc : Number.isFinite(dc) ? dc : null };
  }

  /* The PHB's name for a DC (the nearest at or above it) */
  static difficultyOf(dc){
    if(!Number.isFinite(dc)) return "";
    const found = this.DIFFICULTIES.find(([at]) => dc <= at) ?? this.DIFFICULTIES.at(-1);
    return module.i18n(`requests.difficulty.${found[1]}`);
  }

  /* ---------- Who can be asked ---------- */

  /* Creatures on the scene (one row per token), then player characters who aren't on it */
  static candidates(){
    const seen = new Set();
    const list = [];
    for(const token of canvas.tokens?.placeables ?? []){
      if(!token.actor) continue;
      list.push({ id : token.document.uuid, actor : token.actor.uuid, token : token.document.uuid, name : token.name, img : token.document.texture?.src || token.actor.img,
        player : token.actor.hasPlayerOwner, controlled : token.controlled, onScene : true });
      if(token.document.actorLink) seen.add(token.actor.id);
    }
    for(const actor of game.actors.filter(a => (a.type === "character") && a.hasPlayerOwner && !seen.has(a.id))){
      list.push({ id : actor.uuid, actor : actor.uuid, token : null, name : actor.name, img : actor.img, player : true, controlled : false, onScene : false });
    }
    return list;
  }

  static esc(s){
    return foundry.utils.escapeHTML(String(s ?? ""));
  }

  /* The category picks what the second list offers */
  static fillWhat(select, category, selected = null){
    const esc = this.esc;
    const options = this.choices()[category] ?? [];
    const pick = (selected && options.some(o => o.value === selected)) ? selected : ((category === "skill") ? "skill:prc" : options[0]?.value);
    select.innerHTML = options.map(o => `<option value="${esc(o.value)}"${(o.value === pick) ? " selected" : ""}>${esc(o.label)}</option>`).join("");
  }

  /* ---------- The card ---------- */

  /**
   * Post a request card.
   * @param {object} options
   * @param {object[]} options.who      rows : { actor (uuid), token (uuid|null), name, img }
   * @param {string} options.what       "skill:ath", "save:dex", "check:str", "tool:thief"
   * @param {number|null} [options.dc]
   * @param {"each"|"group"} [options.mode]
   * @param {boolean} [options.whisper]  only the GM and the creatures' owners
   * @returns {Promise<ChatMessage>}
   */
  static async request({ who = [], what = "skill:prc", dc = null, mode = "each", whisper = false } = {}){
    const rows = who.map(p => ({ key : String(p.token ?? p.actor).replaceAll(".", "-"), actor : p.actor, token : p.token ?? null, name : p.name, img : p.img }));
    const request = {
      dc : Number.isFinite(dc) ? dc : null, hideDC : !!settings.value("requestsDmScreen"), mode : (mode === "group") ? "group" : "each", rows, results : {},
      rounds : { 1 : this.checkFor(what, dc) }, round : 1, compact : this.compact(), whisper : !!whisper,
    };
    return ChatMessage.implementation.create({
      speaker : { alias : module.i18n("requests.title") },
      content : `<div class="${module.id}-request"></div>`,
      whisper : whisper ? this.whisperTo(rows) : [],
      flags : { [module.id] : { request } },
    });
  }

  /* The GM and the creatures' owners */
  static whisperTo(rows){
    const ids = new Set(game.users.filter(u => u.isGM).map(u => u.id));
    for(const row of rows){
      const actor = fromUuidSync(row.actor, { strict : false });
      for(const u of game.users) if(actor?.testUserPermission(u, "OWNER")) ids.add(u.id);
    }
    return [...ids];
  }

  static checkOf(request, round = 1){
    return request.rounds?.[round] ?? {};
  }

  static dcOf(request, round = 1){
    const dc = this.checkOf(request, round).dc;
    return Number.isFinite(dc) ? dc : (Number.isFinite(request.dc) ? request.dc : null);
  }

  /**
   * A request's outcome : null until everyone has rolled (or without a DC); then at least half succeeded (one creature :
   * its own result). A group check's rule, and how a Skill Challenge counts an "each rolls" check.
   */
  static outcomeOf(request){
    const results = request.rows.map(r => request.results?.[1]?.[r.key]).filter(Boolean);
    if((this.dcOf(request) === null) || (results.length < request.rows.length)) return null;
    return results.filter(r => r.success).length >= Math.ceil(request.rows.length / 2);
  }

  /* A group check's line on its card */
  static summaryOf(request){
    if((request.mode !== "group") || (this.dcOf(request) === null)) return null;
    const won = this.outcomeOf(request);
    const now = Object.values(request.results?.[1] ?? {});
    const done = now.filter(r => r.success).length;
    if(won === null) return { text : module.format("requests.groupWaiting", { done : now.length, of : request.rows.length }) };
    return { text : module.format(won ? "requests.groupSuccess" : "requests.groupFailure", { done, of : request.rows.length }), success : won, done : true };
  }

  /* A stored roll back as a dnd5e roll */
  static rollOf(entry){
    if(!entry?.roll || (typeof entry.roll !== "object")) return null;
    try { return Roll.fromData(entry.roll); }
    catch { return null; }
  }

  static actorOf(row){
    return fromUuidSync(row.token ?? "", { strict : false })?.actor ?? fromUuidSync(row.actor, { strict : false });
  }

  /* "DC 15 · Medium", or "DC ?" for players with the DM Screen on */
  static dcText(request){
    const dc = this.dcOf(request);
    if(dc === null) return "";
    return (!request.hideDC || game.user.isGM) ? `${module.format("requests.dcValue", { dc })} · ${this.difficultyOf(dc)}` : module.i18n("requests.dcHidden");
  }

  static renderCard(message, html){
    const request = message.getFlag?.(module.id, "request");
    if(!request) return;
    const root = html.querySelector(`.${module.id}-request`) ?? html.querySelector(".message-content");
    if(!root) return;
    const esc = this.esc;
    const summary = this.summaryOf(request);
    const feet = [];
    const rows = this.rowsHtml(request, feet);
    const subtitle = [module.i18n(`requests.modes.${request.mode}`), request.whisper ? module.i18n("requests.whispered") : ""].filter(Boolean).join(" · ");
    const dc = this.dcText(request);
    root.innerHTML = `<div class="${module.id}-request-card">
        <header class="request-header"><i class="fa-solid fa-dice-d20" inert></i>
          <div class="titles"><strong>${esc(this.checkOf(request).label ?? "")}</strong><span class="subtitle">${esc(subtitle)}</span></div>
          ${dc ? `<span class="dc">${esc(dc)}</span>` : ""}</header>
        <ul class="unlist macro-helper-rows">${rows}</ul>
        ${summary ? `<div class="request-summary ${summary.success === true ? "success" : summary.success === false ? "failure" : ""}">${esc(summary.text)}</div>` : ""}
        ${feet.length ? `<div class="card-buttons request-feet">${feet.join("")}</div>` : ""}
      </div>`;
    this.wireCard(message, root);
  }

  /* The rows : a Roll button (the owner), the result, Reroll by it (Compact); the foot's buttons collected */
  static rowsHtml(request, feet){
    const esc = this.esc;
    const results = request.results?.[1] ?? {};
    const dmScreen = settings.value("rollItemDmScreen");
    return request.rows.map(row => {
      const actor = this.actorOf(row);
      const entry = results[row.key];
      const canRoll = !entry && !!actor?.isOwner;
      /* An NPC's total is the GM's business with the DM screen on */
      const showTotal = !dmScreen || game.user.isGM || actor?.hasPlayerOwner;
      const mark = (entry?.success === true) ? "success" : (entry?.success === false) ? "failure" : "";
      const roll = this.rollOf(entry);
      const detail = roll ? `${roll.formula} = ${roll.total}` : "";
      const resultHtml = entry ? `<span class="result ${mark}"${(detail && showTotal) ? ` data-tooltip="${esc(detail)}"` : ""}>
          ${showTotal ? esc(entry.total) : ""} ${mark ? `<i class="fa-solid ${mark === "success" ? "fa-check" : "fa-xmark"}" inert></i>` : ""}</span>` : "";
      const reroll = (entry && request.compact && roll && (actor?.isOwner || game.user.isGM))
        ? `<button type="button" class="icon" data-request-reroll="${esc(row.key)}" data-tooltip="${esc(module.i18n("rerolls.reroll"))}"><i class="fa-solid fa-rotate" inert></i></button>` : "";
      const rollButton = canRoll ? `<button type="button" class="save" data-request-roll="${esc(row.key)}"><i class="fa-solid fa-dice-d20" inert></i> ${esc(module.i18n("requests.roll"))}</button>`
        : !entry ? `<span class="pending"><i class="fa-solid fa-hourglass-half" inert></i></span>` : "";
      if(request.compact && entry && roll) feet.push(...this.footButtons(request, row, entry, actor, roll));
      return `<li class="macro-helper-row"><img class="token" src="${esc(row.img)}" alt=""><span class="name">${esc(row.name)}</span>${rollButton}${resultHtml}${reroll}</li>`;
    }).join("");
  }

  /* ---------- Compact : the buttons at the card's foot (each for its owner, the GM's spend) ---------- */

  static footButtons(request, row, entry, actor, roll){
    const esc = this.esc;
    const out = [];
    const button = (id, icon, text) => `<button type="button" data-request-feat="${id}" data-row="${esc(row.key)}"><i class="fa-solid ${icon}" inert></i> ${esc(text)}</button>`;
    const failed = entry.success !== true;
    const isCheck = ["check", "skill", "tool"].includes(this.checkOf(request).kind);
    if(actor?.isOwner){
      const lucky = settings.value("featRules") && findItem(actor, "lucky");
      if(lucky && (Number(lucky.system.uses?.value) > 0) && !entry.lucky && (Number(roll.options?.advantageMode ?? 0) !== 1)){
        out.push(button("lucky", "fa-clover", module.format("requests.featFor", { feat : lucky.name, name : row.name })));
      }
      const inspiration = failed && !entry.bardic && bard.inspirationOf(actor);
      if(inspiration) out.push(button("bardic", "fa-music", module.format("requests.featFor", { feat : module.format("classes.bard.use", { die : inspiration.die }), name : row.name })));
      const tactical = failed && isCheck && !entry.tactical && fighter.enabled() && actor.items.some(i => fighter.idOf(i) === fighter.TACTICAL_MIND)
        && (Number(fighter.secondWindOf(actor)?.system?.uses?.value) > 0);
      if(tactical) out.push(button("tactical", "fa-chess-knight", module.format("requests.featFor", { feat : module.i18n("classes.fighter.tactical"), name : row.name })));
    }
    if(game.user.isGM && entry.tactical && !entry.tacticalSpent && (entry.success !== false)){
      out.push(button("tacticalSpend", "fa-heart-crack", module.format("requests.featFor", { feat : module.i18n("classes.fighter.tacticalSpend"), name : row.name })));
    }
    return out;
  }

  static wireCard(message, root){
    const on = (selector, run) => root.querySelectorAll(selector).forEach(b => b.addEventListener("click", async event => {
      event.preventDefault();
      b.disabled = true;
      try { await run(b, event); }
      catch(error){ log.error(error); ui.notifications.warn(error.message); }
      finally { b.disabled = false; }
    }));
    on("[data-request-roll]", (b, event) => this.rollRow(message, b.dataset.requestRoll, { event }));
    on("[data-request-reroll]", b => this.reroll(message, b.dataset.requestReroll));
    on("[data-request-feat]", b => this.useFeat(message, b.dataset.row, b.dataset.requestFeat));
  }

  /* ---------- Rolling a row ---------- */

  /**
   * Roll a row with dnd5e. Compact : the roll goes into the card (no message of its own). Individual : dnd5e's message,
   * carrying which request and row it answers. The DC goes on the roll only when players may see it.
   */
  static async rollRow(message, rowKey, { event } = {}){
    const request = message.getFlag(module.id, "request");
    const row = request?.rows.find(r => r.key === rowKey);
    const actor = row && this.actorOf(row);
    if(!actor?.isOwner) return;
    const { kind, key } = this.checkOf(request);
    const config = { event };
    const dc = this.dcOf(request);
    if((dc !== null) && !request.hideDC) config.target = dc;
    const messageConfig = request.compact ? { create : false }
      : { data : { flags : { [module.id] : { requestRoll : { message : message.id, row : rowKey } } } } };
    if(request.whisper && !request.compact) messageConfig.rollMode = ("gm" in (CONFIG.ChatMessage.modes ?? {})) ? "gm" : "gmroll";
    let rolls = null;
    if(kind === "skill") rolls = await actor.rollSkill({ ...config, skill : key }, {}, messageConfig);
    else if(kind === "tool") rolls = await actor.rollToolCheck({ ...config, tool : key }, {}, messageConfig);
    else if(kind === "check") rolls = await actor.rollAbilityCheck({ ...config, ability : key }, {}, messageConfig);
    else if(kind === "save") rolls = await actor.rollSavingThrow({ ...config, ability : key }, {}, messageConfig);
    const roll = rolls?.[0];
    if(!request.compact || !roll) return;
    await this.showDice([roll], message);
    await gm.run("requestStore", { message : message.id, row : rowKey, roll : roll.toJSON() });
  }

  static async showDice(rolls, message){
    try { const { rollItem } = await import('../roll-item/roll-item.js'); await rollItem.showDice(rolls, message); }
    catch(error){ log.debug("Dice", error); }
  }

  /* Compact : a fresh roll for the row (Rule Limits : a free reroll isn't in the rules; the GM always may) */
  static async reroll(message, rowKey){
    const request = message.getFlag(module.id, "request");
    const row = request?.rows.find(r => r.key === rowKey);
    const roll = this.rollOf(request?.results?.[1]?.[rowKey]);
    if(!roll || !row) return;
    if(!limits.mayReroll(row.name, this.checkOf(request).label)) return;
    const fresh = await roll.reroll();
    await this.showDice([fresh], message);
    await gm.run("requestStore", { message : message.id, row : rowKey, roll : fresh.toJSON(), reset : true });
  }

  /* Compact : Lucky, Bardic Inspiration, Tactical Mind on a row; the GM's Second Wind spend */
  static async useFeat(message, rowKey, feat){
    const request = message.getFlag(module.id, "request");
    const row = request?.rows.find(r => r.key === rowKey);
    const roll = this.rollOf(request?.results?.[1]?.[rowKey]);
    const actor = row && this.actorOf(row);
    if(!roll || !actor) return;
    const store = (updated, mark) => gm.run("requestStore", { message : message.id, row : rowKey, roll : updated.toJSON(), mark });
    if(feat === "lucky"){
      const item = findItem(actor, "lucky");
      const result = await extraD20(roll, "kh");
      if(!item || !result || (result.status === "same")) return;
      if(result.extra) await this.showDice([result.extra], message);
      await store(result.updated, { lucky : true });
      await spendUses(item, 1, { warn : false });
    }
    else if(feat === "bardic"){
      const inspiration = bard.inspirationOf(actor);
      if(!inspiration) return;
      const { updated, extra } = await addDie(roll, inspiration.die);
      await this.showDice([extra], message);
      await store(updated, { bardic : true });
      if(inspiration.effect.isOwner) await inspiration.effect.delete();
    }
    else if(feat === "tactical"){
      const { updated, extra } = await addDie(roll, "1d10");
      await this.showDice([extra], message);
      await store(updated, { tactical : true });
    }
    else if((feat === "tacticalSpend") && game.user.isGM){
      const secondWind = fighter.secondWindOf(actor);
      if(secondWind) await spendUses(secondWind, 1, { warn : true });
      await store(roll, { tacticalSpent : true });
    }
  }

  /* GM : a row's roll stored on the card (its owner sent it), judged against the DC */
  static async storeAsGM({ message : id, row : rowKey, roll : data, mark = {}, reset = false } = {}, user){
    const card = game.messages.get(id);
    const request = card?.getFlag(module.id, "request");
    const row = request?.rows.find(r => r.key === rowKey);
    const actor = row && this.actorOf(row);
    if(!row || !(user?.isGM || actor?.testUserPermission(user, "OWNER"))) return false;
    const total = Number(data?.total ?? Roll.fromData(data).total);
    const before = reset ? {} : (request.results?.[1]?.[rowKey] ?? {});
    const dc = this.dcOf(request);
    const entry = { ...before, ...mark, total, roll : data, success : (dc === null) ? null : (total >= dc) };
    await card.setFlag(module.id, `request.results.1.${rowKey}`, entry);
    return true;
  }

  /* Individual : a dnd5e roll message answering a request (made, or changed by its buttons) : the GM marks the row */
  static async onRollMessage(message){
    const link = message?.getFlag?.(module.id, "requestRoll");
    if(!link || !game.users.activeGM?.isSelf) return;
    const card = game.messages.get(link.message);
    const request = card?.getFlag(module.id, "request");
    const roll = message.rolls?.[0];
    if(!request || !roll) return;
    const total = roll.total;
    const before = request.results?.[1]?.[link.row];
    if(before && (before.total === total) && (before.message === message.id)) return;
    const dc = this.dcOf(request);
    await card.setFlag(module.id, `request.results.1.${link.row}`, { total, message : message.id, success : (dc === null) ? null : (total >= dc) });
    log.debug("Request result", link.row, total);
  }

  /* ---------- Skill Challenge : the window's tally ---------- */

  /**
   * A Skill Challenge's standing from its checks' outcomes : succeeded on a majority of successful checks.
   * @param {(boolean|null)[]} outcomes   one per check (null : not decided yet)
   * @returns {{ wins : number, losses : number, done : boolean, success : boolean|null }}
   */
  static challengeOf(outcomes){
    const wins = outcomes.filter(o => o === true).length, losses = outcomes.filter(o => o === false).length;
    const done = outcomes.length > 0 && outcomes.every(o => o !== null);
    return { wins, losses, done, success : done ? (wins > outcomes.length / 2) : null };
  }

  /* The challenge's result, once every check is decided */
  static async postChallenge(checks, { whisper = false, who = [] } = {}){
    const esc = this.esc;
    const { wins, success } = this.challengeOf(checks.map(c => c.outcome));
    const list = checks.map((c, i) => `<li class="macro-helper-row"><span class="name">${i + 1}. ${esc(c.label)}</span>
      <span class="result ${c.outcome ? "success" : "failure"}"><i class="fa-solid ${c.outcome ? "fa-check" : "fa-xmark"}" inert></i></span></li>`).join("");
    return ChatMessage.implementation.create({
      speaker : { alias : module.i18n("requests.challenge") },
      whisper : whisper ? this.whisperTo(who) : [],
      content : `<div class="${module.id}-request-card">
          <header class="request-header"><i class="fa-solid fa-list-check" inert></i>
            <div class="titles"><strong>${esc(module.i18n("requests.challenge"))}</strong><span class="subtitle">${esc(module.format("requests.challengeCount", { wins, of : checks.length }))}</span></div></header>
          <ul class="unlist macro-helper-rows">${list}</ul>
          <div class="request-summary ${success ? "success" : "failure"}">${esc(module.i18n(success ? "requests.challengeWon" : "requests.challengeLost"))}</div>
        </div>`,
    });
  }
}

/**
 * The Roll Request window (GM, one of it). Who, then the checks in tabs (+ adds one) : what, DC, how. One tab : Request
 * posts it and closes. More : a Skill Challenge : each tab is requested when the GM wants (posted like any request),
 * its outcome comes back here, and once every tab is decided the challenge's result is posted. Closing keeps it.
 */
export class RequestWindow extends foundry.applications.api.ApplicationV2{
  static #instance = null;

  static DEFAULT_OPTIONS = {
    id : `${module.id}-roll-request`,
    classes : [`${module.id}-request-window`],
    window : { title : "requests.title", icon : "fa-solid fa-dice-d20", resizable : true },
    position : { width : 520, height : "auto" },
  };

  static show(){
    (this.#instance ??= new RequestWindow()).render({ force : true });
  }

  /* A posted check's card changed : its outcome, maybe the challenge's end */
  static cardChanged(id){
    this.#instance?.cardChanged(id);
  }

  constructor(){
    super();
    this.reset();
  }

  static newTab(){
    return { category : "skill", what : "skill:prc", dc : 15, mode : "each", card : null, outcome : null };
  }

  reset(){
    this.draft = { who : null, whisper : false, active : 0, tabs : [RequestWindow.newTab()], posted : false };
  }

  get challenge(){
    return this.draft.tabs.length > 1;
  }

  async _renderHTML(){
    const r = rollRequests, esc = r.esc, s = this.draft;
    const people = r.candidates();
    this.people = people;
    const anySelected = people.some(p => p.controlled);
    const ticked = p => s.who ? s.who.includes(p.id) : (anySelected ? p.controlled : (p.player && p.onScene));
    const who = people.map(p => `<label class="${module.id}-request-who${p.onScene ? "" : " off-scene"}">
        <input type="checkbox" name="who" value="${esc(p.id)}"${ticked(p) ? " checked" : ""}><img src="${esc(p.img)}" alt=""><span>${esc(p.name)}</span></label>`).join("");
    const tabs = s.tabs.map((t, i) => {
      const mark = (t.outcome === true) ? " ✓" : (t.outcome === false) ? " ✗" : t.card ? " …" : "";
      const cls = [(i === s.active) ? "active" : "", (t.outcome === true) ? "success" : (t.outcome === false) ? "failure" : ""].filter(Boolean).join(" ");
      return `<button type="button" class="${cls}" data-tab="${i}">${i + 1}${mark}</button>`;
    }).join("") + `<button type="button" class="add" data-add-tab data-tooltip="${esc(module.i18n("requests.addCheck"))}"><i class="fa-solid fa-plus" inert></i></button>`;
    const tab = s.tabs[s.active];
    const label = rollRequests.checkFor(tab.what, tab.dc).label;
    /* A requested tab : what it was and how it went; a new one : its what / DC / how */
    const panel = tab.card ? `<div class="requested">
          <strong>${esc(label)}</strong> · ${esc(module.format("requests.dcValue", { dc : tab.dc }))} · ${esc(module.i18n(`requests.modes.${tab.mode}`))}
          <span class="state ${(tab.outcome === true) ? "success" : (tab.outcome === false) ? "failure" : ""}">${esc(module.i18n((tab.outcome === true) ? "requests.succeeded" : (tab.outcome === false) ? "requests.failed" : "requests.waiting"))}</span>
        </div>` : `
        <div class="what-row"><select name="category">${r.CATEGORIES.map(c => `<option value="${c}"${(c === tab.category) ? " selected" : ""}>${esc(module.i18n(`requests.group.${c}`))}</option>`).join("")}</select>
          <select name="what"></select></div>
        <div class="dc-buttons">${r.DIFFICULTIES.map(([dc, n]) => `<button type="button" data-dc="${dc}" data-tooltip="${esc(module.i18n(`requests.difficulty.${n}`))}">${dc}</button>`).join("")}</div>
        <div class="dc-step"><button type="button" data-step="-2">−2</button><input type="number" name="dc" value="${tab.dc}" min="1" max="40"><button type="button" data-step="2">+2</button></div>
        <div class="difficulty">${esc(r.difficultyOf(tab.dc))}</div>
        <div class="how"><label><input type="radio" name="mode" value="each"${(tab.mode === "each") ? " checked" : ""}> ${esc(module.i18n("requests.modes.each"))}</label>
          <label><input type="radio" name="mode" value="group"${(tab.mode === "group") ? " checked" : ""}> ${esc(module.i18n("requests.modes.group"))}</label>
          ${(s.tabs.length > 1) ? `<button type="button" class="remove" data-remove-tab><i class="fa-solid fa-trash" inert></i> ${esc(module.i18n("requests.removeCheck"))}</button>` : ""}</div>`;
    const standing = this.challenge ? rollRequests.challengeOf(s.tabs.map(t => t.outcome)) : null;
    const tally = this.challenge ? `<div class="tally"><strong>${esc(module.i18n("requests.challenge"))}</strong>
        <span class="wins">✓ ${standing.wins}</span><span class="losses">✗ ${standing.losses}</span><span>${esc(module.format("requests.ofChecks", { n : s.tabs.length }))}</span></div>` : "";
    const canRequest = !tab.card && !s.posted;
    return `<div class="${module.id}-request-form">
        <fieldset><legend>${esc(module.i18n("requests.who"))}</legend>
          <div class="quick"><button type="button" data-who="players">${esc(module.i18n("requests.players"))}</button>
            <button type="button" data-who="all">${esc(module.i18n("requests.all"))}</button>
            <button type="button" data-who="none">${esc(module.i18n("requests.none"))}</button></div>
          <div class="${module.id}-request-people">${who || `<p>${esc(module.i18n("requests.nobody"))}</p>`}</div>
        </fieldset>
        <fieldset class="checks">${tally}<nav class="check-tabs">${tabs}</nav>${panel}</fieldset>
        <label class="whisper"><input type="checkbox" name="whisper"${s.whisper ? " checked" : ""}> ${esc(module.i18n("requests.whisper"))}</label>
        <footer class="form-footer">
          ${canRequest ? `<button type="button" data-request><i class="fa-solid fa-paper-plane" inert></i> ${esc(this.challenge ? module.format("requests.requestCheckN", { n : s.active + 1 }) : module.i18n("requests.send"))}</button>` : ""}
          ${(this.challenge && (s.posted || s.tabs.some(t => t.card))) ? `<button type="button" data-reset><i class="fa-solid fa-rotate-left" inert></i> ${esc(module.i18n("requests.newRequest"))}</button>` : ""}
        </footer>
      </div>`;
  }

  _replaceHTML(result, content){
    content.innerHTML = result;
    const r = rollRequests, s = this.draft, tab = s.tabs[s.active];
    const remember = () => {
      s.who = [...content.querySelectorAll('input[name="who"]:checked')].map(i => i.value);
      s.whisper = !!content.querySelector('input[name="whisper"]')?.checked;
      if(tab.card) return;
      const category = content.querySelector('select[name="category"]'), what = content.querySelector('select[name="what"]');
      const dc = content.querySelector('input[name="dc"]');
      if(category) tab.category = category.value;
      if(what?.value) tab.what = what.value;
      if(dc) tab.dc = Math.max(1, Number(dc.value) || 10);
      tab.mode = content.querySelector('input[name="mode"]:checked')?.value ?? tab.mode;
    };
    /* What : the category fills the list */
    const category = content.querySelector('select[name="category"]'), what = content.querySelector('select[name="what"]');
    if(category && what){
      r.fillWhat(what, category.value, tab.what);
      category.addEventListener("change", () => { r.fillWhat(what, category.value); remember(); });
      what.addEventListener("change", remember);
    }
    /* DC : the buttons, ±2, its name */
    const dc = content.querySelector('input[name="dc"]'), name = content.querySelector(".difficulty");
    const showDC = () => { if(name && dc) name.textContent = r.difficultyOf(Number(dc.value)); remember(); };
    content.querySelectorAll("[data-dc]").forEach(b => b.addEventListener("click", () => { dc.value = b.dataset.dc; showDC(); }));
    content.querySelectorAll("[data-step]").forEach(b => b.addEventListener("click", () => { dc.value = Math.max(1, (Number(dc.value) || 10) + Number(b.dataset.step)); showDC(); }));
    dc?.addEventListener("input", showDC);
    content.querySelectorAll('input[name="mode"], input[name="who"], input[name="whisper"]').forEach(i => i.addEventListener("change", remember));
    content.querySelectorAll("[data-who]").forEach(b => b.addEventListener("click", () => {
      content.querySelectorAll('input[name="who"]').forEach(i => {
        const p = this.people.find(x => x.id === i.value);
        i.checked = (b.dataset.who === "all") || ((b.dataset.who === "players") && !!p?.player);
      });
      remember();
    }));
    /* Tabs : switch, add (a copy of this one's choices), remove an unrequested one */
    content.querySelectorAll("[data-tab]").forEach(b => b.addEventListener("click", () => { remember(); s.active = Number(b.dataset.tab); this.render(); }));
    content.querySelector("[data-add-tab]")?.addEventListener("click", () => {
      remember();
      s.tabs.push({ ...RequestWindow.newTab(), category : tab.category, what : tab.what, dc : tab.dc, mode : tab.mode });
      s.active = s.tabs.length - 1;
      this.render();
    });
    content.querySelector("[data-remove-tab]")?.addEventListener("click", () => {
      s.tabs.splice(s.active, 1);
      s.active = Math.min(s.active, s.tabs.length - 1);
      this.render();
    });
    content.querySelector("[data-request]")?.addEventListener("click", () => { remember(); this.requestActive(); });
    content.querySelector("[data-reset]")?.addEventListener("click", () => { this.reset(); this.render(); });
  }

  /* Request the open tab : the card a single request would post. One tab : done, the window closes */
  async requestActive(){
    const s = this.draft, tab = s.tabs[s.active];
    const who = (this.people ?? []).filter(p => (s.who ?? []).includes(p.id));
    if(!who.length) return ui.notifications.warn(module.i18n("requests.pickSomeone"));
    const card = await rollRequests.request({ who, what : tab.what, dc : tab.dc, mode : tab.mode, whisper : s.whisper });
    if(!card) return;
    if(!this.challenge){
      this.reset();
      return this.close();
    }
    tab.card = card.id;
    tab.label = rollRequests.checkFor(tab.what, tab.dc).label;
    s.lastWho = who;
    /* On to the next tab not asked yet */
    const next = s.tabs.findIndex(t => !t.card);
    if(next >= 0) s.active = next;
    this.render();
  }

  tracks(id){
    return this.draft.tabs.some(t => t.card === id);
  }

  /* A requested check's card changed : its outcome here; every tab decided : the challenge's result is posted */
  async cardChanged(id){
    const tab = this.draft.tabs.find(t => t.card === id);
    const request = tab && game.messages.get(id)?.getFlag(module.id, "request");
    if(!request) return;
    tab.outcome = rollRequests.outcomeOf(request);
    const standing = rollRequests.challengeOf(this.draft.tabs.map(t => t.outcome));
    if(standing.done && !this.draft.posted){
      this.draft.posted = true;
      await rollRequests.postChallenge(this.draft.tabs.map(t => ({ label : t.label, outcome : t.outcome })), { whisper : this.draft.whisper, who : (this.draft.lastWho ?? []).map(p => ({ actor : p.actor })) });
    }
    if(this.rendered) this.render();
  }
}
