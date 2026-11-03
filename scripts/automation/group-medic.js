import { settings } from '../settings.js';
import { rollRequests } from '../requests/requests.js';
import { isIncapacitated } from '../helpers/tokens.js';
import { groupTravel } from './group-travel.js';
import { groupWeather } from './group-weather.js';

/**
 * Group Travel : Medic on the road (homebrew switch homebrewMedic). A Medic job on the Members tab. At the end of each
 * hour the group travels (a leg; not Pass Time), each Stable member at 0 HP (a patient) is looked after :
 *   a Medic (on its feet, not Incapacitated; several share the patients in turn) : a card for the Medic's player,
 *     Wisdom (Medicine) DC 10, or a Healer's Kit use instead of the roll (a success);
 *   no Medic : only in rough weather (heavy rain or snow, Extreme Cold or Heat), the patient's own Constitution save,
 *     DC 10, unless it's sheltered (the GM's tick, a covered vehicle).
 *   A failure : a Loses Stable button for the patient's player or the GM (back to Death Saving Throws). The cards go
 *   with the leg's Undo; Stable already lost stays lost.
 */
export class groupMedic{
  static DC = 10;
  static KIT = ["healers-kit"];

  static on(){
    return groupTravel.enabled() && !!settings.value("homebrewMedic");
  }

  static i18n(key, data){
    return data ? game.i18n.format(`groupTravel.medic.${key}`, data) : game.i18n.localize(`groupTravel.medic.${key}`);
  }

  /* Stable at 0 HP, not dead */
  static patients(group){
    return groupTravel.creatures(group).filter(a => (Number(a.system.attributes?.hp?.value) <= 0) && a.statuses?.has("stable") && !a.statuses?.has("dead"));
  }

  static medics(group){
    return groupTravel.creatures(group).filter(a => (groupTravel.memberOf(group, a).job === "medic") && groupTravel.hasJob(group, a)
      && (Number(a.system.attributes?.hp?.value) > 0) && !isIncapacitated(a));
  }

  /* Heavy rain or snow, Extreme Cold or Heat, and it isn't sheltered */
  static rough(group, actor){
    const weather = groupWeather.of(group);
    const rough = ["rain", "snow"].includes(weather.precipitation) || ["cold", "heat"].includes(weather.temperature);
    return rough && !groupWeather.roadShelter(group, actor);
  }

  /**
   * Each hour the leg passed : the patients' cards (on the GM's client).
   * @param {Actor} group
   * @param {object} options
   * @param {number} options.start     the world time the leg started at
   * @param {number} options.seconds
   * @returns {Promise<ChatMessage[]>}
   */
  static async hourly(group, { start, seconds }){
    if(!this.on()) return [];
    const cards = [];
    const outcomes = { success : this.i18n("staysStable"), failure : this.i18n("losesStable") };
    for(const time of groupWeather.hourMarks(start, seconds)){
      const patients = this.patients(group);
      if(!patients.length) break;
      const { time : clock } = groupTravel.formatted(time);
      const medics = this.medics(group);
      if(medics.length){
        for(const [index, patient] of patients.entries()){
          const medic = medics[index % medics.length];
          cards.push(await rollRequests.request({ who : [{ actor : medic.uuid, name : medic.name, img : medic.img, target : patient.uuid, targetName : patient.name }],
            what : "skill:med", dc : this.DC, hideDC : false, speaker : group, onFail : "unstable", instead : { items : this.KIT }, outcomes,
            label : this.i18n("check", { skill : rollRequests.labelOf("skill", "med"), name : patient.name, time : clock }) }));
        }
        continue;
      }
      const who = patients.filter(a => this.rough(group, a)).map(a => ({ actor : a.uuid, name : a.name, img : a.img }));
      if(!who.length) continue;
      cards.push(await rollRequests.request({ who, what : "save:con", dc : this.DC, hideDC : false, speaker : group, onFail : "unstable", outcomes,
        label : this.i18n("save", { save : rollRequests.labelOf("save", "con"), time : clock }) }));
    }
    return cards;
  }
}
