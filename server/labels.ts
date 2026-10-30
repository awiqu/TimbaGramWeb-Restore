import { labelRegistry, SERVER_LABEL_PREFIX, type LabelOverrides, type LabelsDTO } from '@timba/shared';
import { getSettings, updateSettings } from './settings.js';
import { txt } from './strings.js';

/** Server texts (service messages, errors, bot answers) that the admin can replace; keys start with `server.` */
const registry = labelRegistry(txt as unknown as Record<string, unknown>, SERVER_LABEL_PREFIX);

export const serverLabelDefaults = registry.defaults;

export function labelsDTO(): LabelsDTO {
  const s = getSettings();
  return { version: s.labelsVersion, labels: s.labels };
}

/** Puts the saved replacements into `txt`; called on start and after every change. */
export function applyServerLabels() {
  registry.apply(getSettings().labels);
}

/** null brings back the built-in text */
export function updateLabels(set: Record<string, string | null>) {
  const labels: LabelOverrides = { ...getSettings().labels };
  for (const [key, value] of Object.entries(set)) {
    if (value === null) delete labels[key];
    else labels[key] = value;
  }
  updateSettings({ labels, labelsVersion: getSettings().labelsVersion + 1 });
  applyServerLabels();
  return labelsDTO();
}
