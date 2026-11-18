import ElectronStore from 'electron-store';

interface CompanionSettings {
  position: { x: number; y: number };
  skinId: string;
}

let store: ElectronStore<CompanionSettings> | undefined;

/** One instance lets appearance and voice observe the same saved selection. */
export function getCompanionStore(): ElectronStore<CompanionSettings> {
  return (store ??= new ElectronStore<CompanionSettings>({
    name: 'cyrvis-companion',
  }));
}
