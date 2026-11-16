const { isIPv4 } = require('node:net');
const { normalizeMac } = require('./discovery');

const MAX_SLOT_COUNT = 32;
const SLOT_NAMES = Array.from({ length: MAX_SLOT_COUNT }, (_, index) => 'ew' + (index + 1));

function parseRackLayout(config) {
  const result = { ...config };
  // An empty form field on an older connection still uses its saved individual slots.
  if (!config.rackLayout?.trim() && config.rackLayoutSaved !== true) return result;

  for (const slot of SLOT_NAMES) {
    delete result[slot + 'Mac'];
    delete result[slot + 'Ip'];
    delete result[slot + 'Id'];
  }

  const seenSlots = new Set();
  const addresses = new Set();
  const ids = new Set();
  const rows = (config.rackLayout || '').split(/\r?\n/);
  for (const [index, row] of rows.entries()) {
    const line = row.trim();
    if (!line || line.startsWith('#')) continue;

    const [position, address, id, extra] = line.split(/\s+/);
    const slot = /^(?:ew)?[1-9]\d?$/i.test(position) ? SLOT_NAMES[Number(position.replace(/^ew/i, '')) - 1] : undefined;
    const [baseAddress, probeIp, extraAddress] = (address || '').split('@');
    const mac = normalizeMac(baseAddress);
    if (!slot || (!mac && !isIPv4(baseAddress)) || (probeIp !== undefined && (!mac || !isIPv4(probeIp)))
        || extraAddress !== undefined || extra || (id && !/^[\p{L}\p{N}_-]{1,24}$/u.test(id))) {
      throw new Error('Rack order, line ' + (index + 1) + ': enter slot (1–32), MAC or IPv4, and an optional short ID.');
    }
    const identity = mac || baseAddress;
    if (seenSlots.has(slot) || addresses.has(identity) || (id && ids.has(id.toLowerCase()))) {
      throw new Error('Rack order, line ' + (index + 1) + ': slot, address and custom ID must each be unique.');
    }
    seenSlots.add(slot);
    addresses.add(identity);
    if (id) ids.add(id.toLowerCase());
    result[slot + (mac ? 'Mac' : 'Ip')] = identity;
    if (probeIp) result[slot + 'Ip'] = probeIp;
    if (id) result[slot + 'Id'] = id;
  }
  return result;
}

function updateDeviceTypeFields(config) {
  for (const slot of SLOT_NAMES) {
    const override = config[slot + 'Type'];
    const identity = config[slot + 'Mac'] || config[slot + 'Ip'];
    const detected = identity && config.detectedTypes?.[identity];
    config[slot + 'DeviceType'] = override === 'EM' || override === 'SR'
      ? override
      : detected === 'EM' || detected === 'SR' ? detected
        : config.deviceType === 'SR' ? 'SR' : 'EM';
  }
}

function configureDevices(config, previous) {
  const next = config.deviceSelectionsSaved === true ? { ...config } : parseRackLayout(config);
  delete next.rackLayout;
  delete next.rackLayoutSaved;
  for (const slot of SLOT_NAMES) {
    const selection = next[slot + 'Device'];
    if (typeof selection !== 'string' || (!selection && !config.deviceSelectionsSaved)) {
      const mac = normalizeMac(next[slot + 'Mac']);
      const ip = next[slot + 'Ip'];
      next[slot + 'Device'] = mac || (isIPv4(ip) ? 'ip:' + ip : '');
    }
  }

  const changedSlots = previous
    ? SLOT_NAMES.filter((slot) => next[slot + 'Device'] !== previous[slot + 'Device'])
    : [];
  if (changedSlots.length === 1) {
    const changed = changedSlots[0];
    const selected = next[changed + 'Device'];
    const oldSlot = SLOT_NAMES.find((slot) => slot !== changed && next[slot + 'Device'] === selected);
    if (selected && oldSlot) {
      next[oldSlot + 'Device'] = previous[changed + 'Device'] || '';
      [next[changed + 'Id'], next[oldSlot + 'Id']] = [next[oldSlot + 'Id'], next[changed + 'Id']];
      [next[changed + 'Type'], next[oldSlot + 'Type']] = [next[oldSlot + 'Type'] || 'default', next[changed + 'Type'] || 'default'];
    } else {
      delete next[changed + 'Id'];
      delete next[changed + 'Type'];
    }
  }

  if (previous) {
    for (const slot of SLOT_NAMES) {
      const chosenType = config[slot + 'DeviceType'];
      if ((chosenType === 'EM' || chosenType === 'SR') && chosenType !== previous[slot + 'DeviceType']) {
        next[slot + 'Type'] = chosenType;
      }
    }
  }

  const assigned = new Set();
  for (const slot of SLOT_NAMES) {
    const selected = next[slot + 'Device'];
    const mac = normalizeMac(selected);
    const ip = selected.startsWith('ip:') ? selected.slice(3) : '';
    const identity = mac || selected;
    if (selected && ((!mac && !isIPv4(ip)) || assigned.has(identity))) {
      throw new Error(slot.toUpperCase() + ': select a valid device that occupies only one slot.');
    }

    const existingProbe = normalizeMac(next[slot + 'Mac']) === mac && mac ? next[slot + 'Ip'] : undefined;
    delete next[slot + 'Mac'];
    delete next[slot + 'Ip'];
    if (mac) {
      next[slot + 'Mac'] = mac;
      if (isIPv4(existingProbe)) next[slot + 'Ip'] = existingProbe;
    } else if (ip) {
      next[slot + 'Ip'] = ip;
    }
    if (selected) assigned.add(identity);
    next[slot + 'Device'] = identity;
  }

  const probe = next.manualProbeIp?.trim();
  if (probe && !isIPv4(probe)) throw new Error('Manual discovery: enter a valid IPv4 address.');
  next.deviceSelectionsSaved = true;
  updateDeviceTypeFields(next);
  return next;
}

module.exports = { MAX_SLOT_COUNT, SLOT_NAMES, configureDevices, updateDeviceTypeFields };
