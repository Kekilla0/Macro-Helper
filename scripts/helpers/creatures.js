import { module } from '../module.js';

/**
 * Choosing creatures (and other things) from a grid of pictures, and whether a creature fits one of dnd5e's transform /
 * summon profiles. The creatures come from Macro Helper's compendiums (rules/compendiums.js) : index entries or actors.
 */

/* A creature's challenge rating as a number (¼ = 0.25) */
export function crOf(actor){
  return Number(actor?.system?.details?.cr) || 0;
}

/* "¼", "½", "1" */
export function crLabel(cr){
  return ({ 0.125 : "⅛", 0.25 : "¼", 0.5 : "½" })[cr] ?? String(cr);
}

/**
 * Does a creature fit one of dnd5e's transform / summon profiles (Wild Shape : CR ¼ Beast, no fly speed) ?
 * @param {Actor} actor
 * @param {object} profile             the activity's profile (cr formula, types, movement it excludes, sizes)
 * @param {object} [rollData]          for the CR formula
 * @returns {boolean}
 */
export function fitsProfile(actor, profile, rollData = {}){
  if(!actor || !profile) return false;
  const simplify = dnd5e.utils?.simplifyBonus ?? (v => Number(v) || 0);
  if((profile.cr !== "") && (profile.cr !== undefined) && (profile.cr !== null)){
    if(crOf(actor) > simplify(profile.cr, rollData)) return false;
  }
  const types = new Set(profile.types ?? []);
  if(types.size && !types.has(actor.system?.details?.type?.value)) return false;
  const sizes = new Set(profile.sizes ?? []);
  if(sizes.size && !sizes.has(actor.system?.traits?.size)) return false;
  const movement = actor.system?.attributes?.movement ?? {};
  for(const type of profile.movement ?? []){
    if((Number(movement.speeds?.[type] ?? movement[type]) || 0) > 0) return false;
  }
  return true;
}

const esc = s => foundry.utils.escapeHTML(String(s ?? ""));

/* A creature as a tile entry : picture, name, CR */
function entryOf(actor){
  return { value : actor.uuid, label : actor.name, img : actor.prototypeToken?.texture?.src || actor.img, detail : `CR ${crLabel(crOf(actor))}` };
}

/* One tile : picture, name, a detail line (CR, weapon type) */
function tile(entry, input){
  return `<label class="${module.id}-creature" data-uuid="${esc(entry.value)}">
      ${input}
      ${entry.img ? `<img src="${esc(entry.img)}" alt="">` : ""}
      <span class="name">${esc(entry.label)}</span>
      ${entry.detail ? `<span class="cr">${esc(entry.detail)}</span>` : ""}
    </label>`;
}

/**
 * Choose one creature from a grid of pictures.
 * @param {Actor[]} actors
 * @param {object} [options]
 * @param {string} [options.title]
 * @param {string} [options.prompt]
 * @param {string} [options.icon]
 * @param {object[]} [options.extra]   more buttons, as DialogV2 buttons ({ action, label, icon }) : their action is returned
 * @returns {Promise<string|null>}  the creature's uuid (or an extra button's action), null if closed
 */
export async function chooseCreature(actors, options = {}){
  return chooseOne(actors.map(entryOf), options);
}

/**
 * Choose one from a grid of tiles ({ value, label, img, detail }).
 * @returns {Promise<string|null>}  the value (or an extra button's action), null if closed
 */
export async function chooseOne(entries, { title, prompt = "", icon = "fa-solid fa-paw", extra = [], columns = null } = {}){
  if(!entries.length) return null;
  const grid = entries.map((e, i) => tile(e, `<input type="radio" name="creature" value="${esc(e.value)}"${i ? "" : " checked"}>`)).join("");
  const chosen = await foundry.applications.api.DialogV2.wait({
    window : { title, icon },
    classes : [`${module.id}-creatures`],
    content : `${prompt ? `<p>${esc(prompt)}</p>` : ""}<div class="${module.id}-creature-grid"${columns ? ` style="grid-template-columns : repeat(${columns}, 1fr)"` : ""}>${grid}</div>`,
    buttons : [
      { action : "ok", label : game.i18n.localize("Confirm"), icon : "fa-solid fa-check", default : true,
        callback : (event, button) => button.form.elements.creature?.value ?? null },
      ...extra,
    ],
    /* A double click on a picture chooses it */
    render : (event, dialog) => {
      dialog.element.querySelectorAll(`.${module.id}-creature`).forEach(el => el.addEventListener("dblclick", () => {
        el.querySelector("input").checked = true;
        dialog.element.querySelector('button[data-action="ok"]')?.click();
      }));
    },
    rejectClose : false,
  });
  return (!chosen || (chosen === "ok")) ? null : chosen;
}

/**
 * Choose a set of creatures (Wild Shape's known forms) : up to `max`, with at most `swaps` of the current ones taken away.
 * @param {Actor[]} actors
 * @param {object} options
 * @param {string[]} options.known    uuids chosen now
 * @param {number} options.max
 * @param {number} [options.swaps=Infinity]  how many of the known ones may be replaced
 * @param {string} [options.title]
 * @param {string} [options.prompt]
 * @returns {Promise<string[]|null>}  the new set, null if closed
 */
export async function chooseCreatures(actors, options = {}){
  return chooseSet(actors.map(entryOf), options);
}

/**
 * Choose a set from a grid of tiles ({ value, label, img, detail }) : up to `max`, with at most `swaps` of the current
 * ones taken away (more when there are more than `max` already : down to `max` is free).
 * @returns {Promise<string[]|null>}  the new set, null if closed
 */
export async function chooseSet(entries, { known = [], max, swaps = Infinity, title, prompt = "", icon = "fa-solid fa-paw", allowPast = false } = {}){
  /* Known ones no longer offered (deleted, moved out of the folder) don't count against the swaps */
  known = known.filter(value => entries.some(e => e.value === value));
  swaps += Math.max(0, known.length - max);
  const grid = entries.map(e => tile(e, `<input type="checkbox" name="creature" value="${esc(e.value)}"${known.includes(e.value) ? " checked" : ""}>`)).join("");
  const status = `<p class="${module.id}-creature-status"></p>`
    + (allowPast ? `<label class="${module.id}-past"><input type="checkbox" name="past"> ${esc(module.i18n("creatures.past"))}</label>` : "");
  const result = await foundry.applications.api.DialogV2.wait({
    window : { title, icon },
    classes : [`${module.id}-creatures`],
    content : `${prompt ? `<p>${esc(prompt)}</p>` : ""}${status}<div class="${module.id}-creature-grid">${grid}</div>`,
    buttons : [{ action : "ok", label : game.i18n.localize("Save Changes"), icon : "fa-solid fa-check", default : true,
      callback : (event, button) => Object.assign([...button.form.querySelectorAll('input[name="creature"]:checked')].map(i => i.value),
        { past : !!button.form.querySelector('input[name="past"]')?.checked }) }],
    /* The limits, as boxes are ticked : no more than max, and only `swaps` of the known ones can be unticked */
    render : (event, dialog) => {
      const root = dialog.element;
      const line = root.querySelector(`.${module.id}-creature-status`);
      const show = (warning = "") => {
        const picked = root.querySelectorAll('input[name="creature"]:checked').length;
        const removed = known.filter(uuid => !root.querySelector(`input[value="${CSS.escape(uuid)}"]`)?.checked).length;
        line.innerHTML = module.format("creatures.status", { picked, max, swaps : Number.isFinite(swaps) ? Math.max(0, swaps - removed) : "∞" })
          + (warning ? ` <strong class="warning">${esc(warning)}</strong>` : "");
      };
      const past = () => !!root.querySelector('input[name="past"]')?.checked;
      root.querySelector('input[name="past"]')?.addEventListener("change", () => show());
      root.querySelectorAll('input[name="creature"]').forEach(input => input.addEventListener("change", () => {
        const picked = root.querySelectorAll('input[name="creature"]:checked').length;
        const removed = known.filter(uuid => !root.querySelector(`input[value="${CSS.escape(uuid)}"]`)?.checked).length;
        if(input.checked && (picked > max)){ input.checked = false; return show(module.format("creatures.tooMany", { max })); }
        /* Past the rules : as many replaced as wanted, never more than the limit */
        if(!past() && !input.checked && known.includes(input.value) && (removed > swaps)){ input.checked = true; return show(module.i18n("creatures.noSwaps")); }
        show();
      }));
      show();
    },
    rejectClose : false,
  });
  return Array.isArray(result) ? result : null;
}
