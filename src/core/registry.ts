import type {
  AtmosphereAPI, WorldAPI, TrainsAPI, PeopleAPI, MaintenanceAPI, EventsAPI, CameraAPI, UIAPI, AudioAPI, TrafficAPI, NatureAPI,
} from './apis';

/** Each subsystem assigns its API onto its slot during create<Name>(ctx). */
export class Registry {
  atmosphere!: AtmosphereAPI;
  world!: WorldAPI;
  /** v2: animals, birds, boats, river surface, crops (src/nature) */
  nature!: NatureAPI;
  trains!: TrainsAPI;
  /** v2: road vehicles, horses, cab rank, omnibus, level-crossing gates (src/traffic) */
  traffic!: TrafficAPI;
  people!: PeopleAPI;
  maintenance!: MaintenanceAPI;
  events!: EventsAPI;
  camera!: CameraAPI;
  ui!: UIAPI;
  audio!: AudioAPI;
}
