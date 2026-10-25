import { module } from '../module.js';
import { esc } from '../helpers/utils.js';
import { distanceBetween } from '../helpers/tokens.js';
import { actionTracker } from './action-tracker.js';
import { actionReady } from './action-ready.js';
import { zones } from './zones.js';
import { cardBuilder, grapplesOn, grappling, attachedTo } from '../roll-item/card-builder.js';

/**
 * The action bar (Action Tracker on) : just above Foundry's hotbar, one creature's turn in a started combat it's in :
 * its Actions, Bonus Actions and Reactions (pips; an added one is ringed, a used one dimmed : a click marks one used or
 * gives it back), its Action pip emptying as the Attack action's attacks are made, its movement this turn against
 * its Speed, its object interaction, and the turn's log.
 * On its turn, End Turn (its owner or the GM) moves the combat on.
 *   Whose : a player's selected token (one they own), else their assigned character; the GM's first selected token.
 */
export class actionBar{
  static ID = `${module.id}-action-bar`;
  static #timer = null;
  static #logOpen = false;

  static register(){
    if(game.system.id !== "dnd5e") return;
    const later = () => this.schedule();
    for(const hook of ["canvasReady", "controlToken", "updateCombat", "combatStart", "deleteCombat", "createCombatant", "deleteCombatant", "updateCombatant",
      "moveToken", "updateUser", "renderHotbar", "createRegion", "updateRegion", "deleteRegion"]) Hooks.on(hook, later);
    Hooks.on("updateActor", (actor, changes) => {
      if(foundry.utils.hasProperty(changes ?? {}, `flags.${module.id}.economy`) || foundry.utils.hasProperty(changes ?? {}, "system.attributes.movement")) later();
    });
    Hooks.on("createActiveEffect", later);
    Hooks.on("updateActiveEffect", later);
    Hooks.on("deleteActiveEffect", later);
    Hooks.once("ready", later);
  }

  static schedule(){
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.render(), 60);
  }

  /* Whose bar : { token, actor } or null */
  static subject(){
    const controlled = canvas.ready ? (canvas.tokens?.controlled ?? []) : [];
    if(game.user.isGM) return controlled[0] ? { token : controlled[0], actor : controlled[0].actor } : null;
    const own = controlled.find(t => t.actor?.isOwner);
    if(own) return { token : own, actor : own.actor };
    const character = game.user.character;
    if(!character) return null;
    const token = character.getActiveTokens?.(false, false)?.[0] ?? null;
    return { token, actor : token?.actor ?? character };
  }

  static element(){
    let el = document.getElementById(this.ID);
    if(el) return el;
    const hotbar = document.getElementById("hotbar");
    if(!hotbar?.parentElement) return null;
    el = document.createElement("div");
    el.id = this.ID;
    hotbar.parentElement.insertBefore(el, hotbar);
    return el;
  }

  static render(){
    const el = this.element();
    if(!el) return;
    const who = actionTracker.enabled() ? this.subject() : null;
    const st = who?.actor ? actionTracker.state(who.actor) : null;
    if(!st){ el.hidden = true; el.innerHTML = ""; return; }
    const { actor, token } = who;
    const rec = st.rec;
    const action = token?.document?.movementAction ?? "walk";
    const speed = actionTracker.movementOf(actor, action);
    const moved = (token ? actionTracker.movedOf(token) : 0) + (Number(rec.standing) || 0);
    /* The big button above the bar : a death save while dying, Stand Up while Prone (its turn) */
    const death = actor.system?.attributes?.death;
    const dying = st.mine && (actor.type === "character") && (Number(actor.system?.attributes?.hp?.value) <= 0) && !!death
      && ((Number(death.failure) || 0) < 3) && ((Number(death.success) || 0) < 3) && !actor.statuses?.has?.("dead") && !actor.statuses?.has?.("stable") && (game.user.isGM || actor.isOwner);
    /* Prone : Stand Up, unless in a Tortle's shell (it must Emerge first) */
    const prone = !dying && st.mine && actor.statuses?.has?.("prone") && !actor.statuses?.has?.("unconscious") && (game.user.isGM || actor.isOwner)
      && !actor.effects?.some?.(e => !e.disabled && e.getFlag(module.id, "rule")?.shell);
    const may = game.user.isGM || actor.isOwner;
    const free = !actionTracker.OUT_OF_ACTION.some(s => actor.statuses?.has?.(s));
    /* One Escape per grapple on it (its turn), one Release per creature it holds (any time) */
    const grapples = (!dying && st.mine && free && may) ? grapplesOn(actor) : [];
    const holds = (!dying && may && token) ? grappling(token) : [];
    /* Wake a creature within 5 ft (Sleep Breath) : its Action, on its turn */
    const sleepers = (!dying && st.mine && free && may && token) ? actionTracker.sleepersNear(token) : [];
    /* Pull someone out of a creature that engulfed it (Gelatinous Cube) : within 5 ft of it, its Action */
    const engulfed = (!dying && st.mine && free && may && token) ? canvas.tokens.placeables.filter(t => (t !== token) && t.actor?.effects?.some?.(e => {
      const by = e.getFlag(module.id, "engulfedBy"); const cube = by ? fromUuidSync(by, { strict : false })?.object : null;
      return !!cube && (cube !== token) && !actor.effects?.some?.(x => x.getFlag(module.id, "engulfedBy")) && (distanceBetween(token, cube) <= 5);
    })) : [];
    /* Moving at random (Euphoria Breath) : its turn, its whole movement */
    const random = !dying && st.mine && may && token && actor.effects?.some?.(e => !e.disabled && e.getFlag(module.id, "rule")?.randomMove);
    /* Its areas it can move (Moonbeam) : its turn */
    const areas = (!dying && st.mine && free && may) ? zones.movable(actor) : [];
    /* In its shell (Tortle) : Emerge, its Bonus Action */
    const shell = !dying && st.mine && may && actor.effects?.some?.(e => !e.disabled && e.getFlag(module.id, "rule")?.shell);
    const buttons = dying ? [`<button type="button" class="death-save"><i class="fa-solid fa-skull" inert></i> ${esc(module.i18n("actionTracker.bar.deathSave"))}</button>`]
      : [prone ? `<button type="button" class="stand-up"><i class="fa-solid fa-person-arrow-up-from-line" inert></i> ${esc(module.format("actionTracker.bar.standUp", { cost : Math.floor(speed / 2) }))}</button>` : "",
         ...grapples.map(g => `<button type="button" class="escape" data-effect="${g.effect.id}"><i class="fa-solid fa-hand-back-fist" inert></i> ${esc(module.format(g.effect.getFlag(module.id, "grapple")?.engulf ? "actionTracker.bar.escapeEngulf" : g.attach ? "actionTracker.bar.detachFrom" : g.free ? "actionTracker.bar.breakFree" : "actionTracker.bar.escapeFrom", { name : g.free ? g.effect.name : g.byName, dc : g.dc }))}</button>`),
         ...holds.map(t => { const attached = attachedTo(token)?.document === (t.document ?? t);
           return `<button type="button" class="release" data-target="${(t.document ?? t).uuid}"${attached ? ` data-attached="1"` : ""}><i class="fa-solid fa-hand" inert></i> ${esc(module.format(attached ? "actionTracker.bar.detach" : "actionTracker.bar.release", { name : t.name }))}</button>`; }),
         shell ? `<button type="button" class="emerge"><i class="fa-solid fa-shield-halved" inert></i> ${esc(module.i18n("species.emergeButton"))}</button>` : "",
         ...areas.map(a => `<button type="button" class="move-zone" data-region="${a.region.id}"${(a.moves.cost && (actionTracker.remaining(rec, a.moves.cost) <= 0)) ? " disabled" : ""}><i class="fa-solid fa-up-down-left-right" inert></i> ${esc(module.format("zones.moveButton", { zone : a.item.name }))}</button>`),
         random ? `<button type="button" class="random-move"><i class="fa-solid fa-shuffle" inert></i> ${esc(module.i18n("actionTracker.bar.randomMove"))}</button>` : "",
         ...engulfed.map(t => `<button type="button" class="pull-out" data-target="${t.id}"><i class="fa-solid fa-hand-holding-hand" inert></i> ${esc(module.format("actionTracker.bar.pullOut", { name : t.name }))}</button>`),
         ...sleepers.map(t => `<button type="button" class="wake" data-target="${t.id}"><i class="fa-solid fa-bell" inert></i> ${esc(module.format("actionTracker.bar.wake", { name : t.name }))}</button>`)].filter(Boolean);
    const big = buttons.length ? `<div class="big-action">${buttons.join("")}</div>` : "";
    const log = (rec.log ?? []).slice().reverse();
    el.hidden = false;
    el.classList.toggle("mine", st.mine);
    el.innerHTML = `${big}
      <div class="who" data-tooltip="${esc(st.mine ? module.i18n("actionTracker.bar.yourTurn") : module.i18n("actionTracker.bar.notTurn"))}">
        <img src="${esc(token?.document?.texture?.src ?? actor.img)}" alt=""><span>${esc(token?.name ?? actor.name)}</span></div>
      <div class="pips">${actionTracker.pipsHTML(rec)}</div>
      ${actionTracker.extrasHTML(actor) ? `<div class="extras">${actionTracker.extrasHTML(actor)}</div>` : ""}
      ${rec.ready ? `<div class="ready-chip">${actionTracker.readyHTML(rec)} ${esc(rec.ready.name)}</div>`
        : (st.mine && (game.user.isGM || actor.isOwner)) ? `<button type="button" class="ready-button"${(actionTracker.remaining(rec, "action") <= 0) ? " disabled" : ""} data-tooltip="${esc(module.i18n("actionTracker.ready.tip"))}"><i class="fa-solid fa-hourglass-half" inert></i> ${esc(module.i18n("actionTracker.ready.button"))}</button>` : ""}
      <div class="move${(speed && (moved > speed)) ? " over" : ""}" data-tooltip="${esc(module.i18n("actionTracker.movement"))}"><i class="fa-solid fa-shoe-prints" inert></i> ${moved} / ${speed} ft</div>
      <div class="object${(rec.objects >= 1) ? " spent" : ""}" data-tooltip="${esc(module.i18n((rec.objects >= 1) ? "actionTracker.bar.objectUsed" : "actionTracker.bar.objectFree"))}"><i class="fa-solid fa-hand-holding" inert></i></div>
      <button type="button" class="log-toggle" data-tooltip="${esc(module.i18n("actionTracker.bar.log"))}"><i class="fa-solid fa-list" inert></i></button>
      ${(st.mine && (game.user.isGM || st.combatant.isOwner)) ? `<button type="button" class="end-turn"><i class="fa-solid fa-forward-step" inert></i> ${esc(module.i18n("actionTracker.bar.endTurn"))}</button>` : ""}
      <div class="log"${this.#logOpen ? "" : " hidden"}>${log.length
        ? `<ol>${log.map(e => `<li>${esc(e.text)}</li>`).join("")}</ol>` : `<p>${esc(module.i18n("actionTracker.bar.noLog"))}</p>`}</div>`;
    actionTracker.listen(el.querySelector(".pips"), actor);
    el.querySelector(".death-save")?.addEventListener("click", event => { event.currentTarget.disabled = true; actionTracker.deathSave(actor, st.combat); });
    el.querySelector(".stand-up")?.addEventListener("click", event => { event.currentTarget.disabled = true; actionTracker.standUp(actor, token); });
    el.querySelectorAll(".escape").forEach(b => b.addEventListener("click", event => { event.currentTarget.disabled = true; actionTracker.escape(actor, event.currentTarget.dataset.effect); }));
    el.querySelectorAll(".pull-out").forEach(b => b.addEventListener("click", event => { event.currentTarget.disabled = true;
      cardBuilder.pullOut(actor, token, canvas.tokens.get(event.currentTarget.dataset.target)); }));
    el.querySelector(".emerge")?.addEventListener("click", async event => { event.currentTarget.disabled = true;
      const { feats } = await import('./feats.js'); feats.emerge(actor); });
    el.querySelectorAll(".move-zone").forEach(b => b.addEventListener("click", async event => {
      const button = event.currentTarget;
      button.disabled = true;
      if(!await zones.moveArea(actor, canvas.scene.regions.get(button.dataset.region))) button.disabled = false; }));
    el.querySelector(".random-move")?.addEventListener("click", event => { event.currentTarget.disabled = true; cardBuilder.randomMove(token); });
    el.querySelectorAll(".wake").forEach(b => b.addEventListener("click", event => { event.currentTarget.disabled = true;
      actionTracker.wake(actor, token, canvas.tokens.get(event.currentTarget.dataset.target)); }));
    el.querySelectorAll(".release").forEach(b => b.addEventListener("click", async event => {
      const button = event.currentTarget;
      button.disabled = true;
      await cardBuilder.release(token, fromUuidSync(button.dataset.target, { strict : false }));
      /* Detaching itself (a Darkmantle) : 5 ft of its movement (its own Speed again, once detached) */
      if(button.dataset.attached){ await new Promise(resolve => setTimeout(resolve, 300)); await actionTracker.useMovement(token, -5); } }));
    el.querySelector(".ready-button")?.addEventListener("click", () => actionReady.ready(token, actor));
    el.querySelector(".end-turn")?.addEventListener("click", async event => {
      event.currentTarget.disabled = true;
      if(st.combat.combatant?.id === st.combatant.id) await st.combat.nextTurn();
    });
    el.querySelector(".log-toggle")?.addEventListener("click", () => {
      this.#logOpen = !this.#logOpen;
      el.querySelector(".log").hidden = !this.#logOpen;
    });
  }
}
