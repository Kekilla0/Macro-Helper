import { module } from '../module.js';

/**
 * Creatures kept in Actors sidebar folders for features to choose from (Wild Shape forms, familiars), so a table
 * uses its own imports (art, stats) rather than dnd5e's compendium search.
 */

/**
 * The actors in the first folder found by these names (case ignored), subfolders included.
 * @param {string[]} names  e.g. ["Familiars", "Wild Companions"]
 * @returns {Actor[]}
 */
export function folderActors(names){
  const wanted = names.map(n => n.toLowerCase());
  const folder = game.folders?.find(f => (f.type === "Actor") && wanted.includes(String(f.name).toLowerCase()));
  if(!folder) return [];
  const ids = new Set([folder.id]);
  /* Subfolders, however deep */
  let grew = true;
  while(grew){
    grew = false;
    for(const f of game.folders){
      if((f.type === "Actor") && !ids.has(f.id) && ids.has(f.folder?.id ?? f.folder)){ ids.add(f.id); grew = true; }
    }
  }
  return game.actors.filter(a => ids.has(a.folder?.id ?? a.folder))
    .sort((a, b) => (crOf(a) - crOf(b)) || a.name.localeCompare(b.name));
}

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

/* One creature's tile : picture, name, CR */
function tile(actor, input){
  return `<label class="${module.id}-creature" data-uuid="${esc(actor.uuid)}">
      ${input}
      <img src="${esc(actor.prototypeToken?.texture?.src || actor.img)}" alt="">
      <span class="name">${esc(actor.name)}</span>
      <span class="cr">CR ${crLabel(crOf(actor))}</span>
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
export async function chooseCreature(actors, { title, prompt = "", icon = "fa-solid fa-paw", extra = [] } = {}){
  if(!actors.length) return null;
  const grid = actors.map((a, i) => tile(a, `<input type="radio" name="creature" value="${esc(a.uuid)}"${i ? "" : " checked"}>`)).join("");
  const chosen = await foundry.applications.api.DialogV2.wait({
    window : { title, icon },
    classes : [`${module.id}-creatures`],
    content : `${prompt ? `<p>${esc(prompt)}</p>` : ""}<div class="${module.id}-creature-grid">${grid}</div>`,
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
export async function chooseCreatures(actors, { known = [], max, swaps = Infinity, title, prompt = "" } = {}){
  /* Known ones no longer offered (deleted, moved out of the folder) don't count against the swaps */
  known = known.filter(uuid => actors.some(a => a.uuid === uuid));
  const grid = actors.map(a => tile(a, `<input type="checkbox" name="creature" value="${esc(a.uuid)}"${known.includes(a.uuid) ? " checked" : ""}>`)).join("");
  const status = `<p class="${module.id}-creature-status"></p>`;
  const result = await foundry.applications.api.DialogV2.wait({
    window : { title, icon : "fa-solid fa-paw" },
    classes : [`${module.id}-creatures`],
    content : `${prompt ? `<p>${esc(prompt)}</p>` : ""}${status}<div class="${module.id}-creature-grid">${grid}</div>`,
    buttons : [{ action : "ok", label : game.i18n.localize("Save Changes"), icon : "fa-solid fa-check", default : true,
      callback : (event, button) => [...button.form.querySelectorAll('input[name="creature"]:checked')].map(i => i.value) }],
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
      root.querySelectorAll('input[name="creature"]').forEach(input => input.addEventListener("change", () => {
        const picked = root.querySelectorAll('input[name="creature"]:checked').length;
        const removed = known.filter(uuid => !root.querySelector(`input[value="${CSS.escape(uuid)}"]`)?.checked).length;
        if(input.checked && (picked > max)){ input.checked = false; return show(module.format("creatures.tooMany", { max })); }
        if(!input.checked && known.includes(input.value) && (removed > swaps)){ input.checked = true; return show(module.i18n("creatures.noSwaps")); }
        show();
      }));
      show();
    },
    rejectClose : false,
  });
  return Array.isArray(result) ? result : null;
}
