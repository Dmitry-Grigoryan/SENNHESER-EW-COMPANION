const { InstanceBase, InstanceStatus } = require('@companion-module/base');
const { isDeepStrictEqual } = require('node:util');
const { isIPv4 } = require('node:net');
const { setTimeout: delay } = require('node:timers/promises');
const {
  normalizeMac, scanTargets, readNeighbors, WSM_PORT, probeWsm, parseAnnouncement,
} = require('./discovery');

const { getPresets } = require('./presets');
const { MAX_SLOT_COUNT, SLOT_NAMES, configureDevices, updateDeviceTypeFields } = require('./rack-layout');

const PORT = 53212;
const DEFAULT_SLOT_COUNT = 4;
const DEVICE_TYPES = [
  { id: 'EM', label: 'EM (Receiver / Mic)' },
  { id: 'SR', label: 'SR (Transmitter / IEM)' },
];

class SennheiserEW extends InstanceBase {
  constructor(internal) {
    super(internal);
    this.socket = null;
    this.config = null;
    this.layoutError = null;
    this.socketReady = false;
    this.discoverySocket = null;
    this.discoverySocketReady = false;
    this.discoverySocketSettled = new Promise((resolve) => { this.resolveDiscoverySocket = resolve; });
    this.hasDiscoverySnapshot = false;
    this.onlineDeviceTypes = new Set();
    this.scanController = null;
    this.discoveryResults = null;
    this.deviceCatalog = new Map();
    this.discoveredIps = [];
    this.nextFullScan = 0;
    this.status = null;
    this.devices = {};
    this.deviceNames = [];
    this.encoderModes = {};
    this.pushIntervals = {};
    this.readInterval = null;
    this.lastPublishedVariables = {};
  }

  async init(config) {
    try {
      this.config = configureDevices(config);
      if (!isDeepStrictEqual(config, this.config)) this.saveConfig(this.config, undefined);
    } catch (error) {
      this.layoutError = error.message;
      this.config = config;
    }
    this.initDevices();
    this.initVariables();
    this.initActions();
    this.initFeedbacks();
    this.initPresets();
    this.updateVariableValues();
    this.initDiscoverySocket();
    this.initSocket();
  }

  initDevices() {
    const requestedCount = Number(this.config.slotCount);
    const slotCount = Number.isInteger(requestedCount)
      ? Math.min(MAX_SLOT_COUNT, Math.max(1, requestedCount))
      : DEFAULT_SLOT_COUNT;
    this.deviceNames = SLOT_NAMES.slice(0, slotCount);
    this.encoderModes = Object.fromEntries(this.deviceNames.map((name) => [name, this.encoderModes[name] || 'af_out']));
    this.devices = {};
    for (const name of this.deviceNames) {
      this.devices[name] = this.emptyDevice();
      const identity = normalizeMac(this.config[name + 'Mac']) || this.config[name + 'Ip'];
      const saved = identity && this.config.detectedTypes?.[identity];
      if (saved === 'EM' || saved === 'SR') this.devices[name].detectedType = saved;
    }
  }

  deviceType(name) {
    const override = this.config[name + 'Type'];
    if (override === 'EM' || override === 'SR') return override;
    const detected = this.devices[name]?.detectedType;
    if (detected) return detected;
    return this.config.deviceType === 'SR' ? 'SR' : 'EM';
  }

  emptyDevice() {
    return {
      ip: null,
      muteState: false,
      frequency: '---',
      deviceName: 'Unknown',
      lastMessage: '---',
      afOut: '---',
      afLevel: '0',
      afLevelRight: '0',
      afPeakHold1: '0',
      afPeakHold2: '0',
      rfMuteFlags: '',
      rfLevel1: '0',
      rfLevel2: '0',
      rfMin1: '0',
      rfMax1: '0',
      rfMin2: '0',
      rfMax2: '0',
      battery: '?',
      sensitivity: '---',
      mode: '---',
      squelch: '---'
    };
  }

  initSocket() {
    this.updateStatus(InstanceStatus.Connecting);
    const socket = this.createSharedUdpSocket('udp4');
    this.socket = socket;
    socket.once('listening', () => {
      if (this.socket !== socket) {
        socket.close();
        return;
      }
      this.socketReady = true;
      this.startReadingIPs();
    });
    socket.on('message', (msg, rinfo) => {
      if (this.socket !== socket || rinfo.port !== PORT) return;
      const scan = this.scanController;
      const probe = scan?.media.get(rinfo.address);
      if (probe) {
        for (const line of msg.toString().split('\r')) {
          const response = line.trim();
          const name = response.match(/^Name[ \t]+(.*)$/)?.[1];
          if (name !== undefined) probe.name = name;
          if (/^AfOut\s+-?\d+$/i.test(response)) probe.em = true;
          if (/^Sensitivity\s+-?\d+$/i.test(response)) probe.sr = true;
        }
      }
      for (const [name, device] of Object.entries(this.devices)) {
        if (device.ip === rinfo.address) {
          this.handleMessage(name, msg);
          break;
        }
      }
    });
    socket.on('error', (err) => {
      if (this.socket !== socket) return;
      this.status = null;
      this.updateStatus(InstanceStatus.ConnectionFailure, err.message);
      this.log('error', 'UDP error: ' + err.message);
    });
    socket.bind(PORT);
  }

  initDiscoverySocket() {
    const socket = this.createSharedUdpSocket('udp4');
    this.discoverySocket = socket;
    socket.once('listening', () => {
      if (this.discoverySocket !== socket) socket.close();
      else this.discoverySocketReady = true;
      this.resolveDiscoverySocket();
    });
    socket.on('message', (message, remote) => {
      const scan = this.scanController;
      if (this.discoverySocket !== socket || !scan || remote.port !== WSM_PORT) return;
      const device = parseAnnouncement(message, remote);
      if (device) scan.announcements.set(device.ip, device);
    });
    socket.on('error', (error) => {
      if (this.discoverySocket !== socket) return;
      this.discoverySocketReady = false;
      this.resolveDiscoverySocket();
      this.log('warn', 'WSM discovery: ' + error.message);
    });
    socket.bind(WSM_PORT);
  }

  startReadingIPs() {
    clearInterval(this.readInterval);
    if (this.layoutError) {
      this.updateStatus(InstanceStatus.BadConfig, this.layoutError);
      return;
    }
    const macs = new Set();
    const ips = new Set();
    for (const slot of this.deviceNames) {
      const rawMac = this.config[slot + 'Mac']?.trim();
      const ip = this.config[slot + 'Ip']?.trim();
      const mac = normalizeMac(rawMac);
      if ((rawMac && (!mac || macs.has(mac))) || (ip && (!isIPv4(ip) || ips.has(ip)))) {
        this.updateStatus(InstanceStatus.BadConfig, slot + ': enter a valid, unique MAC and/or IPv4 address');
        return;
      }
      if (mac) macs.add(mac);
      if (ip) ips.add(ip);
    }
    this.scanNetwork();
    this.readInterval = setInterval(() => this.scanNetwork(), 12000);
  }

  async scanNetwork() {
    if (this.scanController || !this.socketReady) return;
    const controller = new AbortController();
    const { signal } = controller;
    const scan = { controller, announcements: new Map(), media: new Map() };
    this.scanController = scan;

    try {
      if (!this.discoverySocketReady) {
        await Promise.race([this.discoverySocketSettled, delay(300, undefined, { signal, ref: false })]);
      }
      if (signal.aborted) return;
      if (this.discoverySocketReady) {
        await probeWsm();
        await delay(1000, undefined, { signal });
      }
      if (signal.aborted) return;

      const manualIps = this.deviceNames.map((slot) => this.config[slot + 'Ip']?.trim()).filter(Boolean);
      const manualProbe = this.config.manualProbeIp?.trim();
      if (manualProbe) manualIps.push(manualProbe);
      // A periodic Media Control probe also covers units that do not respond to WSM multicast.
      const announcedMacs = new Set([...scan.announcements.values()].map((device) => device.mac));
      const assignedMacs = this.deviceNames.map((slot) => normalizeMac(this.config[slot + 'Mac'])).filter(Boolean);
      const needsFallback = announcedMacs.size < this.deviceNames.length
        || assignedMacs.some((mac) => !announcedMacs.has(mac));
      const fullScan = this.config.allowSubnetScan === true && needsFallback && Date.now() >= this.nextFullScan;
      const localTargets = fullScan ? scanTargets() : [];
      const targets = [...new Set([...manualIps, ...scan.announcements.keys(), ...this.discoveredIps, ...localTargets])];
      const batchSize = fullScan ? 4 : 16;
      for (let offset = 0; offset < targets.length; offset += batchSize) {
        for (const ip of targets.slice(offset, offset + batchSize)) {
          scan.media.set(ip, {});
          this.socket.send(Buffer.from('Name\r'), PORT, ip);
          if (!scan.announcements.has(ip)) {
            this.socket.send(Buffer.from('AfOut\r'), PORT, ip);
            this.socket.send(Buffer.from('Sensitivity\r'), PORT, ip);
          }
        }
        await delay(fullScan ? 100 : 40, undefined, { signal });
      }
      await delay(700, undefined, { signal });

      let neighbors;
      try {
        neighbors = await readNeighbors();
      } catch (error) {
        this.log('debug', 'Neighbor table: ' + error.message);
        neighbors = new Map();
      }
      if (signal.aborted) return;

      const byMac = new Map();
      const byIp = new Map();
      for (const [ip, probe] of scan.media) {
        if (probe.name === undefined) continue;
        const announcement = scan.announcements.get(ip);
        const neighbor = neighbors.get(ip);
        if (announcement && neighbor && announcement.mac !== neighbor) continue;
        const mac = announcement?.mac || neighbor;
        const type = announcement?.type || (probe.em !== probe.sr ? (probe.em ? 'EM' : 'SR') : undefined);
        const device = { ip, mac, type, name: probe.name, model: announcement?.model };
        byIp.set(ip, device);
        if (mac) byMac.set(mac, byMac.has(mac) ? null : device);
      }

      if (fullScan) this.nextFullScan = Date.now() + 300000;
      this.discoveredIps = [...byIp.keys()];
      const found = [...byMac.values()].filter(Boolean);
      const summary = [
        ...found.map((device) =>
          [device.mac, device.ip, device.name, device.model || device.type].filter(Boolean).join(' · ')
        ),
        ...[...scan.announcements.values()]
          .filter((device) => !byIp.has(device.ip))
          .map((device) => device.mac + ' · ' + device.ip + ' · ' + device.model + ' · no valid reply on UDP 53212'),
      ].sort().join('; ');
      if (summary !== this.discoveryResults) {
        this.discoveryResults = summary;
        this.log('info', 'Discovered: ' + (summary || 'none'));
      }
      this.deviceCatalog = new Map(found.map((device) => [device.mac, device]));
      if (manualProbe && byIp.has(manualProbe) && !byIp.get(manualProbe).mac) {
        this.deviceCatalog.set('ip:' + manualProbe, byIp.get(manualProbe));
      }
      this.hasDiscoverySnapshot = true;
      this.applyDiscovery(byMac, byIp);
    } catch (error) {
      if (signal.aborted) return;
      for (const slot of this.deviceNames) this.clearDevice(slot);
      if (this.onlineDeviceTypes.size) {
        this.onlineDeviceTypes = new Set();
        this.initPresets();
      }
      this.status = null;
      this.updateStatus(InstanceStatus.ConnectionFailure, 'Discovery: ' + error.message);
    } finally {
      if (this.scanController === scan) this.scanController = null;
    }
  }

  applyDiscovery(byMac, byIp) {
    const previousConfig = this.config;
    const config = { ...previousConfig };
    const detectedTypes = { ...config.detectedTypes };
    const savedDevices = {};
    const assignedSelections = new Set(SLOT_NAMES.map((slot) => config[slot + 'Device']).filter(Boolean));
    for (const slot of SLOT_NAMES) {
      const selection = config[slot + 'Device'];
      if (!selection) continue;
      const device = selection.startsWith('ip:') ? byIp.get(selection.slice(3)) : byMac.get(selection);
      if (selection.startsWith('ip:') && device?.mac && byMac.get(device.mac)?.ip === device.ip && !assignedSelections.has(device.mac)) {
        config[slot + 'Device'] = device.mac;
        config[slot + 'Mac'] = device.mac;
        delete config[slot + 'Ip'];
        assignedSelections.add(device.mac);
      }
      const key = config[slot + 'Device'];
      if (device) savedDevices[key] = { name: device.name, ip: device.ip };
      else if (previousConfig.savedDevices?.[selection]) savedDevices[key] = previousConfig.savedDevices[selection];
    }
    if (Object.keys(savedDevices).length || previousConfig.savedDevices) config.savedDevices = savedDevices;

    const usedIps = new Set();
    const assignments = this.deviceNames.map((slot) => {
      const mac = normalizeMac(config[slot + 'Mac']);
      const ip = config[slot + 'Ip']?.trim();
      const device = mac ? byMac.get(mac) : byIp.get(ip);
      if (!device || usedIps.has(device.ip)) return [slot, null];
      usedIps.add(device.ip);
      const identity = mac || ip;
      if (device.type) detectedTypes[identity] = device.type;
      return [slot, device];
    });
    if (JSON.stringify(detectedTypes) !== JSON.stringify(previousConfig.detectedTypes || {})) {
      config.detectedTypes = detectedTypes;
    }

    const typesBefore = this.deviceNames.map((slot) => this.deviceType(slot));
    updateDeviceTypeFields(config);
    this.config = config;
    for (const [slot, device] of assignments) {
      const previous = this.devices[slot];
      if (previous.ip && (previous.ip !== device?.ip || (device.type && device.type !== previous.detectedType))) {
        this.clearDevice(slot);
      }
      if (device?.type) this.devices[slot].detectedType = device.type;
    }
    const typesChanged = this.deviceNames.some((slot, index) => this.deviceType(slot) !== typesBefore[index]);
    const assignedTypesByIp = new Map(assignments.flatMap(([slot, device]) =>
      device ? [[device.ip, this.deviceType(slot)]] : []));
    const onlineTypes = new Set([...byIp.values()].map((device) => assignedTypesByIp.get(device.ip) || device.type)
      .filter((type) => type === 'EM' || type === 'SR'));
    const onlineChanged = onlineTypes.size !== this.onlineDeviceTypes.size
      || [...onlineTypes].some((type) => !this.onlineDeviceTypes.has(type));
    this.onlineDeviceTypes = onlineTypes;
    if (typesChanged) {
      this.initVariables();
      this.initActions();
      this.updateVariableValues();
    }
    if (typesChanged || onlineChanged) this.initPresets();
    for (const [slot, device] of assignments) {
      if (device) this.connectToDevice(slot, device.ip);
    }

    const assigned = this.deviceNames.filter((slot) => config[slot + 'Mac'] || config[slot + 'Ip']).length;
    const online = assignments.filter(([, device]) => device).length;
    const status = online && online === assigned ? InstanceStatus.Ok
      : online ? InstanceStatus.UnknownWarning : InstanceStatus.Connecting;
    const discoveredCount = this.deviceCatalog.size;
    const message = !online && assigned && discoveredCount
      ? 'Saved rack offline. ' + discoveredCount + ' other devices found. Select devices in the slot dropdowns.'
      : assigned ? online + '/' + assigned + ' assigned devices found'
        : discoveredCount + ' devices found; select a device in each slot';
    const key = status + message;
    if (this.status !== key) {
      this.status = key;
      this.updateStatus(status, message);
    }
    if (!this.layoutError && JSON.stringify(config) !== JSON.stringify(previousConfig)) this.saveConfig(config, undefined);
  }

  clearDevice(name) {
    clearInterval(this.pushIntervals[name]);
    delete this.pushIntervals[name];
    const detectedType = this.devices[name]?.detectedType;
    this.devices[name] = { ...this.emptyDevice(), detectedType };
    this.updateVariableValues(name);
    this.checkFeedbacks('mute_state_' + name, 'rf_level_' + name);
  }

  connectToDevice(name, ip) {
    if (this.devices[name].ip === ip) return;
    this.clearDevice(name);
    this.devices[name].ip = ip;

    this.sendCommand(name, 'Push 60 ' + (parseInt(this.config.updateRate) || 500) + ' 7');
    this.sendCommand(name, 'Name\r');
    this.sendCommand(name, 'Frequency\r');

    if (this.deviceType(name) === 'SR') {
      this.sendCommand(name, 'Sensitivity\r');
      this.sendCommand(name, 'Mode\r');
    } else {
      this.sendCommand(name, 'AfOut\r');
      this.sendCommand(name, 'Squelch\r');
    }

    this.pushIntervals[name] = setInterval(() => {
      this.sendCommand(name, 'Push 60 ' + (parseInt(this.config.updateRate) || 500) + ' 7');
    }, 30000);

    this.updateVariableValues(name);
    this.checkFeedbacks('mute_state_' + name, 'rf_level_' + name);
  }

  sendCommand(name, cmd) {
    const device = this.devices[name];
    if (!this.socketReady || !device?.ip) return false;
    try {
      this.socket.send(Buffer.from(cmd.trimEnd() + '\r'), PORT, device.ip);
      return true;
    } catch (error) {
      this.log('error', name + ': ' + error.message);
      return false;
    }
  }

  async sendActionCommand(name, cmd) {
    const device = this.devices[name];
    if (!this.socketReady || !device?.ip) {
      this.log('warn', name + ': ' + cmd + ' skipped because the receiver is offline');
      return false;
    }

    const expectedMac = normalizeMac(this.config[name + 'Mac']);
    if (expectedMac) {
      try {
        const neighbors = await readNeighbors();
        if (device !== this.devices[name] || !this.socketReady) return false;
        if (neighbors.get(device.ip) !== expectedMac) {
          this.clearDevice(name);
          this.status = null;
          this.updateStatus(InstanceStatus.Connecting, name + ': MAC changed or unavailable');
          this.log('warn', name + ': MAC address could not be confirmed. Waiting for discovery.');
          return false;
        }
      } catch (error) {
        this.log('warn', name + ': ' + error.message);
        return false;
      }
    }

    return this.sendCommand(name, cmd);
  }

  handleMessage(name, msg) {
    const device = this.devices[name];
    if (!device) return;

    const transmitter = this.deviceType(name) === 'SR';
    const previousMute = device.muteState;
    const previousRf = device.rfLevel1;
    const lines = msg.toString().split('\r');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (/^\d{4}:/.test(trimmed)) {
        this.log('debug', name + ': receiver replied ' + trimmed);
        continue;
      }

      const split = trimmed.split(/\s+/);

      if (trimmed.startsWith('Name')) {
        device.deviceName = trimmed.substring(5).trim();
      } else if (trimmed.startsWith('Frequency')) {
        const raw = split[1];
        if (raw) {
          device.frequency = `${raw.substring(0, 3)}.${raw.substring(3)}`;
        }
      } else if (trimmed.startsWith('States')) {
        const prevState = device.muteState;
        let newState = false;

        if (transmitter) {
          newState = split[1] === '1';
          device.rfMuteFlags = split[2] || '';
        } else {
          const flags = parseInt(split[1]) || 0;
          newState = (flags & 1) === 1;
        }

        device.muteState = newState;

        if (prevState !== newState) {
          const stateStr = newState ? 'Muted (1)' : 'Unmuted (0)';
          this.log('info', name + ' Mute state changed to: ' + stateStr);
        }
      } else if (transmitter && split[0] === 'Mute' && (split[1] === '0' || split[1] === '1')) {
        device.muteState = split[1] === '1';
      } else if (trimmed.startsWith('Sensitivity')) {
        device.sensitivity = split[1] || '---';
      } else if (trimmed.startsWith('Mode')) {
        device.mode = split[1] === '1' ? 'Stereo' : 'Mono';
      } else if (trimmed.startsWith('AfOut')) {
        device.afOut = split[1] || '---';
      } else if (trimmed.startsWith('Squelch')) {
        device.squelch = split[1] || '---';
      } else if (split[0].toUpperCase() === 'AF') {
        device.afLevel = split[1] || '0';
        if (transmitter) {
          device.afLevelRight = split[2] || '0';
          device.afPeakHold1 = split[3] || '0';
          device.afPeakHold2 = split[4] || '0';
        }
      } else if (trimmed.startsWith('RF1')) {
        device.rfMin1 = split[1] || '0';
        device.rfMax1 = split[2] || '0';
        device.rfLevel1 = split[2] || split[1] || '0';
      } else if (trimmed.startsWith('RF2')) {
        device.rfMin2 = split[1] || '0';
        device.rfMax2 = split[2] || '0';
        device.rfLevel2 = split[2] || split[1] || '0';
      } else if (trimmed.startsWith('Bat')) {
        device.battery = split[1] || '?';
      } else if (trimmed.startsWith('Msg')) {
        device.lastMessage = trimmed.substring(4).trim();
      }
    }
    this.updateVariableValues(name);
    if (device.muteState !== previousMute) this.checkFeedbacks('mute_state_' + name);
    if (device.rfLevel1 !== previousRf) this.checkFeedbacks('rf_level_' + name);
  }

  initVariables() {
    const variables = {};

    for (const name of this.deviceNames) {
      variables[name + '_device_name'] = { name: 'Device Name (' + name + ')' };
      variables[name + '_online'] = { name: 'Device online (0/1) (' + name + ')' };
      variables[name + '_rack_id'] = { name: 'Rack ID (' + name + ')' };
      variables[name + '_display_name'] = { name: 'Rack ID or device name (' + name + ')' };
      variables[name + '_frequency'] = { name: 'Frequency (' + name + ')' };
      variables[name + '_mute_state'] = { name: 'Mute State (' + name + ')' };
      variables[name + '_mute_number'] = { name: 'Mute (0/1) ' + name };
      variables[name + '_last_message'] = { name: 'Last Message (' + name + ')' };
      variables[name + '_af_level'] = { name: 'AF Level (' + name + ')' };

      if (this.deviceType(name) === 'EM') {
        variables[name + '_af_out'] = { name: 'AfOut Gain (' + name + ')' };
        variables[name + '_battery'] = { name: 'Battery (' + name + ')' };
        variables[name + '_battery_bars'] = { name: 'Battery bars (0–3, -1 if unavailable) (' + name + ')' };
        variables[name + '_encoder_mode'] = { name: 'Encoder mode (' + name + ')' };
        variables[name + '_squelch'] = { name: 'Squelch (' + name + ')' };
        variables[name + '_rf_level_1'] = { name: 'RF Level 1 (' + name + ')' };
        variables[name + '_rf_level_2'] = { name: 'RF Level 2 (' + name + ')' };
        variables[name + '_rf_min_1'] = { name: 'RF Min 1 (' + name + ')' };
        variables[name + '_rf_max_1'] = { name: 'RF Max 1 (' + name + ')' };
        variables[name + '_rf_min_2'] = { name: 'RF Min 2 (' + name + ')' };
        variables[name + '_rf_max_2'] = { name: 'RF Max 2 (' + name + ')' };
      }

      if (this.deviceType(name) === 'SR') {
        variables[name + '_af_level_right'] = { name: 'AF Level, SR input 2 (' + name + ')' };
        variables[name + '_af_peak_hold_1'] = { name: 'AF peak hold, SR input 1 (' + name + ')' };
        variables[name + '_af_peak_hold_2'] = { name: 'AF peak hold, SR input 2 (' + name + ')' };
        variables[name + '_rf_mute_flags'] = { name: 'SR RF Mute since last cycle (0/1/2) (' + name + ')' };
        variables[name + '_sensitivity'] = { name: 'Sensitivity (' + name + ')' };
        variables[name + '_mode'] = { name: 'Mode (' + name + ')' };
      }
    }

    this.lastPublishedVariables = {};
    this.setVariableDefinitions(variables);
  }

  updateVariableValues(slot) {
    const values = {};

    for (const name of slot ? [slot] : this.deviceNames) {
      const d = this.devices[name];
      if (!d) continue;

      values[name + '_device_name'] = d.deviceName || 'Unknown';
      const rackId = this.config[name + 'Id'];
      values[name + '_online'] = d.ip ? 1 : 0;
      values[name + '_rack_id'] = rackId || name.toUpperCase();
      values[name + '_display_name'] = rackId || (d.ip ? d.deviceName : name.toUpperCase());
      values[name + '_frequency'] = d.frequency || '---';
      values[name + '_mute_state'] = d.muteState ? 'Muted' : 'Unmuted';
      values[name + '_mute_number'] = Number(d.muteState);
      values[name + '_last_message'] = d.lastMessage || '---';
      values[name + '_af_level'] = d.afLevel || '0';

      if (this.deviceType(name) === 'EM') {
        values[name + '_af_out'] = d.afOut || '---';
        values[name + '_battery'] = d.battery || '?';
        const battery = Number(d.battery);
        values[name + '_battery_bars'] = Number.isFinite(battery)
          ? Number(battery >= 30) + Number(battery >= 60) + Number(battery >= 99)
          : -1;
        values[name + '_encoder_mode'] = this.encoderModes[name];
        values[name + '_squelch'] = d.squelch || '---';
        values[name + '_rf_level_1'] = d.rfLevel1 || '0';
        values[name + '_rf_level_2'] = d.rfLevel2 || '0';
        values[name + '_rf_min_1'] = d.rfMin1 || '0';
        values[name + '_rf_max_1'] = d.rfMax1 || '0';
        values[name + '_rf_min_2'] = d.rfMin2 || '0';
        values[name + '_rf_max_2'] = d.rfMax2 || '0';
      }

      if (this.deviceType(name) === 'SR') {
        values[name + '_af_level_right'] = d.afLevelRight;
        values[name + '_af_peak_hold_1'] = d.afPeakHold1;
        values[name + '_af_peak_hold_2'] = d.afPeakHold2;
        values[name + '_rf_mute_flags'] = d.rfMuteFlags;
        values[name + '_sensitivity'] = d.sensitivity || '---';
        values[name + '_mode'] = d.mode || '---';
      }
    }

    const changed = {};
    for (const [key, value] of Object.entries(values)) {
      if (this.lastPublishedVariables[key] !== value) changed[key] = value;
    }
    if (Object.keys(changed).length) {
      this.setVariableValues(changed);
      Object.assign(this.lastPublishedVariables, changed);
    }
  }

  initActions() {
    const actions = {};

    for (const name of this.deviceNames) {
      const transmitter = this.deviceType(name) === 'SR';
      actions['set_mute_' + name] = {
        name: (transmitter ? 'Set RF Mute' : 'Set Mute') + ' (' + name + ')',
        options: [
          {
            type: 'dropdown',
            label: 'Mute State',
            id: 'state',
            default: 'toggle',
            choices: [
              { id: 'toggle', label: 'Toggle' },
              { id: 'on', label: 'Mute On' },
              { id: 'off', label: 'Mute Off' }
            ]
          }
        ],
        callback: async (action) => {
          const device = this.devices[name];
          if (!device || !device.ip) {
            this.log('error', name + ' not connected');
            return;
          }
          const state = action.options.state;
          let value;
          if (state === 'toggle') {
            value = device.muteState ? '0' : '1';
          } else if (state === 'on') {
            value = '1';
          } else {
            value = '0';
          }
          if (transmitter) {
            this.sendCommand(name, 'Mute ' + value);
            return;
          }
          if (!(await this.sendActionCommand(name, 'Mute ' + value))) return;
          device.muteState = value === '1';
          this.updateVariableValues(name);
          this.checkFeedbacks('mute_state_' + name);
        }
      };

      actions['set_frequency_' + name] = {
        name: 'Set Frequency (' + name + ')',
        options: [
          {
            type: 'textinput',
            label: 'Frequency (MHz)',
            id: 'frequency',
            required: true,
            regex: /^\d{3}\.\d{3}$/
          }
        ],
        callback: async (action) => {
          const device = this.devices[name];
          if (!device || !device.ip) return;
          const freq = action.options.frequency.replace('.', '');
          if (!(await this.sendActionCommand(name, 'Frequency ' + freq))) return;
          device.frequency = action.options.frequency;
          this.updateVariableValues(name);
        }
      };

      actions['nudge_frequency_' + name] = {
        name: 'Nudge Frequency (' + name + ')',
        options: [
          {
            type: 'dropdown',
            label: 'Direction',
            id: 'direction',
            default: 'up',
            choices: [
              { id: 'up', label: 'Increase' },
              { id: 'down', label: 'Decrease' }
            ]
          },
          {
            type: 'dropdown',
            label: 'Number of device frequency steps',
            id: 'step',
            default: '1',
            choices: [
              { id: '1', label: '1 step' },
              { id: '5', label: '5 steps' },
              { id: '10', label: '10 steps' },
              { id: '25', label: '25 steps' },
              { id: '50', label: '50 steps' },
              { id: '100', label: '100 steps' }
            ]
          }
        ],
        callback: async (action) => {
          const device = this.devices[name];
          if (!device || !device.ip) return;
          const dir = action.options.direction === 'up' ? '' : '-';
          const step = action.options.step;
          if (!(await this.sendActionCommand(name, 'Frequency #' + dir + step))) return;
          setTimeout(() => this.sendCommand(name, 'Frequency\r'), 100);
        }
      };

      if (this.deviceType(name) === 'EM') {
        actions['set_af_out_' + name] = {
          name: 'Set AfOut (' + name + ')',
          options: [
            {
              type: 'dropdown',
              label: 'AfOut (dB)',
              id: 'afout',
              default: '0',
              choices: [
                { id: '-24', label: '-24 dB' },
                { id: '-21', label: '-21 dB' },
                { id: '-18', label: '-18 dB' },
                { id: '-15', label: '-15 dB' },
                { id: '-12', label: '-12 dB' },
                { id: '-9', label: '-9 dB' },
                { id: '-6', label: '-6 dB' },
                { id: '-3', label: '-3 dB' },
                { id: '0', label: '0 dB' },
                { id: '3', label: '+3 dB' },
                { id: '6', label: '+6 dB' },
                { id: '9', label: '+9 dB' },
                { id: '12', label: '+12 dB' },
                { id: '15', label: '+15 dB' },
                { id: '18', label: '+18 dB' },
                { id: '21', label: '+21 dB' },
                { id: '24', label: '+24 dB' }
              ]
            }
          ],
          callback: async (action) => {
            const device = this.devices[name];
            if (!device || !device.ip) return;
            if (!(await this.sendActionCommand(name, 'AfOut ' + action.options.afout))) return;
            device.afOut = action.options.afout;
            this.updateVariableValues(name);
          }
        };

        actions['nudge_af_out_' + name] = {
          name: 'Nudge AfOut (' + name + ')',
          options: [
            {
              type: 'dropdown',
              label: 'Direction',
              id: 'direction',
              default: 'up',
              choices: [
                { id: 'up', label: 'Increase (+3 dB)' },
                { id: 'down', label: 'Decrease (-3 dB)' }
              ]
            }
          ],
          callback: async (action) => {
            const direction = action.options.direction === 'down' ? '-1' : '1';
            const device = this.devices[name];
            if (this.sendCommand(name, 'AfOut #' + direction)) {
              setTimeout(() => {
                if (this.devices[name] === device) this.sendCommand(name, 'AfOut');
              }, 100);
              this.log('debug', name + ': sent AfOut #' + direction);
            }
          }
        };

        actions['set_squelch_' + name] = {
          name: 'Set Squelch (' + name + ')',
          options: [
            {
              type: 'dropdown',
              label: 'Squelch (dB)',
              id: 'squelch',
              default: '7',
              choices: [
                { id: '0', label: 'Off' },
                { id: '5', label: '5 dB' },
                { id: '7', label: '7 dB' },
                { id: '9', label: '9 dB' },
                { id: '11', label: '11 dB' },
                { id: '13', label: '13 dB' },
                { id: '15', label: '15 dB' },
                { id: '17', label: '17 dB' },
                { id: '19', label: '19 dB' },
                { id: '21', label: '21 dB' },
                { id: '23', label: '23 dB' },
                { id: '25', label: '25 dB' }
              ]
            }
          ],
          callback: async (action) => {
            const device = this.devices[name];
            if (!device || !device.ip) return;
            if (!(await this.sendActionCommand(name, 'Squelch ' + action.options.squelch))) return;
            device.squelch = action.options.squelch;
            this.updateVariableValues(name);
          }
        };

        actions['nudge_squelch_' + name] = {
          name: 'Nudge Squelch (' + name + ')',
          options: [
            {
              type: 'dropdown',
              label: 'Direction',
              id: 'direction',
              default: 'up',
              choices: [
                { id: 'up', label: 'Increase (+2 dB)' },
                { id: 'down', label: 'Decrease (-2 dB)' }
              ]
            }
          ],
          callback: async (action) => {
            const direction = action.options.direction === 'down' ? '-1' : '1';
            const device = this.devices[name];
            if (this.sendCommand(name, 'Squelch #' + direction)) {
              setTimeout(() => {
                if (this.devices[name] === device) this.sendCommand(name, 'Squelch');
              }, 100);
              this.log('debug', name + ': sent Squelch #' + direction);
            }
          }
        };
        actions['toggle_encoder_mode_' + name] = {
          name: 'Toggle AF Out / Squelch encoder mode (' + name + ')',
          options: [],
          callback: async () => {
            this.encoderModes[name] = this.encoderModes[name] === 'af_out' ? 'squelch' : 'af_out';
            this.updateVariableValues(name);
          }
        };

        actions['nudge_encoder_' + name] = {
          name: 'Adjust selected AF Out / Squelch (' + name + ')',
          options: actions['nudge_af_out_' + name].options.map((option) => ({
            ...option,
            choices: [{ id: 'up', label: 'Increase' }, { id: 'down', label: 'Decrease' }]
          })),
          callback: async (action) => {
            const parameter = this.encoderModes[name] === 'squelch' ? 'squelch' : 'af_out';
            await actions['nudge_' + parameter + '_' + name].callback(action);
          }
        };
      }

      if (this.deviceType(name) === 'SR') {
        actions['set_sensitivity_' + name] = {
          name: 'Set Sensitivity (' + name + ')',
          options: [
            {
              type: 'dropdown',
              label: 'Sensitivity (dB)',
              id: 'sensitivity',
              default: '-18',
              choices: [
                { id: '0', label: '0 dB' },
                { id: '-3', label: '-3 dB' },
                { id: '-6', label: '-6 dB' },
                { id: '-9', label: '-9 dB' },
                { id: '-12', label: '-12 dB' },
                { id: '-15', label: '-15 dB' },
                { id: '-18', label: '-18 dB' },
                { id: '-21', label: '-21 dB' },
                { id: '-24', label: '-24 dB' },
                { id: '-27', label: '-27 dB' },
                { id: '-30', label: '-30 dB' },
                { id: '-33', label: '-33 dB' },
                { id: '-36', label: '-36 dB' },
                { id: '-39', label: '-39 dB' },
                { id: '-42', label: '-42 dB' }
              ]
            }
          ],
          callback: async (action) => {
            this.sendCommand(name, 'Sensitivity ' + action.options.sensitivity);
          }
        };

        actions['nudge_sensitivity_' + name] = {
          name: 'Nudge IEM input sensitivity (' + name + ')',
          options: [{
            type: 'dropdown',
            label: 'Direction',
            id: 'direction',
            default: 'up',
            choices: [{ id: 'down', label: 'Decrease (-3 dB)' }, { id: 'up', label: 'Increase (+3 dB)' }],
          }],
          callback: async (action) => {
            this.sendCommand(name, 'Sensitivity #' + (action.options.direction === 'down' ? '-1' : '1'));
          },
        };

        actions['set_mode_' + name] = {
          name: 'Set Mode (' + name + ')',
          options: [
            {
              type: 'dropdown',
              label: 'Mode',
              id: 'mode',
              default: '1',
              choices: [
                { id: '0', label: 'Mono' },
                { id: '1', label: 'Stereo' }
              ]
            }
          ],
          callback: async (action) => {
            this.sendCommand(name, 'Mode ' + action.options.mode);
          }
        };

        actions['toggle_iem_mode_' + name] = {
          name: 'Toggle IEM Mono / Stereo (' + name + ')',
          options: [],
          callback: async () => {
            const mode = this.devices[name]?.mode;
            if (mode === 'Mono' || mode === 'Stereo') {
              this.sendCommand(name, mode === 'Mono' ? 'Mode 1' : 'Mode 0');
            } else {
              this.sendCommand(name, 'Mode');
            }
          },
        };
      }
    }

    this.setActionDefinitions(actions);
  }

  initPresets() {
    const { structure, presets } = getPresets(this.label, this.deviceNames, (slot) => this.deviceType(slot), this.onlineDeviceTypes);
    this.setPresetDefinitions(structure, presets);
  }

  initFeedbacks() {
    const self = this;
    const feedbacks = {};

    for (const name of this.deviceNames) {
      feedbacks['mute_state_' + name] = {
        type: 'boolean',
        name: 'Mute State (' + name + ')',
        description: 'Change style when mute is on/off',
        defaultStyle: { bgcolor: 0xff0000, color: 0xffffff },
        options: [
          {
            type: 'dropdown',
            label: 'Mute State',
            id: 'state',
            default: '1',
            choices: [
              { id: '1', label: 'Muted' },
              { id: '0', label: 'Unmuted' },
            ]
          }
        ],
        callback: function (feedback) {
          const device = self.devices[name];
          if (!device?.ip) return false;
          const isMuted = Number(device.muteState);
          const state = parseInt(feedback.options.state);
          return isMuted === state;
        }
      };

      feedbacks['rf_level_' + name] = {
        type: 'boolean',
        name: 'RF Level (' + name + ')',
        description: 'Change style when RF level is above threshold',
        defaultStyle: { bgcolor: 0x00ff00, color: 0x000000 },
        options: [
          {
            type: 'number',
            label: 'Threshold (%)',
            id: 'threshold',
            default: 20,
            min: 0,
            max: 100,
          }
        ],
        callback: function (feedback) {
          const device = self.devices[name];
          if (!device?.ip) return false;
          const level = parseInt(device.rfLevel1) || 0;
          return level >= feedback.options.threshold;
        }
      };
    }

    this.setFeedbackDefinitions(feedbacks);
  }

  deviceChoices(slot) {
    const choices = [{ id: '', label: 'Unassigned' }];
    const selected = this.config?.[slot + 'Device'];
    const devices = [...this.deviceCatalog].sort(([, left], [, right]) => left.name.localeCompare(right.name, undefined, { numeric: true }));
    for (const [id, device] of devices) {
      choices.push({ id, label: [device.name || 'Unnamed', device.mac || 'MAC unavailable', device.ip].join(' / ') });
    }
    if (selected && !this.deviceCatalog.has(selected)) {
      const saved = this.config.savedDevices?.[selected];
      const ip = selected.startsWith('ip:') ? selected.slice(3) : saved?.ip;
      choices.push({
        id: selected,
        label: [(this.hasDiscoverySnapshot ? 'Offline: ' : 'Checking: ') + (saved?.name || slot.toUpperCase()), selected.startsWith('ip:') ? 'MAC unavailable' : selected, ip || 'IP unknown'].join(' / '),
      });
    }
    return choices;
  }

  getConfigFields() {
    return [
      {
        type: 'dropdown',
        id: 'updateRate',
        label: 'Update Rate (ms)',
        width: 6,
        default: '500',
        choices: [
          { id: '200', label: 'Fast (200ms)' },
          { id: '500', label: 'Medium (500ms)' },
          { id: '1000', label: 'Slow (1000ms)' }
        ]
      },
      {
        type: 'checkbox',
        id: 'allowSubnetScan',
        label: 'Enable fallback subnet scan',
        description: 'Probe other hosts on the local subnet for units that do not answer WSM discovery. Leave off unless needed.',
        width: 12,
        default: false,
      },
      {
        type: 'number',
        id: 'slotCount',
        label: 'Number of device slots',
        width: 6,
        min: 1,
        max: MAX_SLOT_COUNT,
        default: DEFAULT_SLOT_COUNT,
        disableAutoExpression: true,
      },
      {
        type: 'textinput',
        id: 'manualProbeIp',
        label: 'Find a device by IPv4 address (optional)',
        description: 'Save and reopen this panel after a few seconds. If the device responds, it will appear in the Device lists.',
        width: 12,
        default: '',
        disableAutoExpression: true,
      },
      {
        type: 'static-text',
        id: 'deviceDiscoveryRefreshHint',
        label: '',
        value: 'If no devices are found, wait 30 seconds and refresh the page.',
        width: 12,
      },
      ...SLOT_NAMES.flatMap((name, index) => {
        const enabled = '$(options:slotCount) >= ' + (index + 1);
        return [
          {
            type: 'static-text',
            id: name + 'Separator',
            label: '──────── ' + name.toUpperCase() + ' ────────',
            value: '',
            width: 12,
            isVisibleExpression: enabled,
          },
          {
            type: 'dropdown',
            id: name + 'Device',
            label: 'Device',
            description: 'Select the base for this rack position. Selecting a base used in another slot swaps their assignments.',
            width: 8,
            default: '',
            disableAutoExpression: true,
            choices: this.deviceChoices(name),
            isVisibleExpression: enabled,
          },
          {
            type: 'dropdown',
            id: name + 'DeviceType',
            label: 'Device type',
            description: 'Filled automatically when identified. Select a different type to override it.',
            width: 4,
            default: this.config?.[name + 'DeviceType'] || 'EM',
            disableAutoExpression: true,
            choices: DEVICE_TYPES,
            isVisibleExpression: enabled,
          },
        ];
      }),
    ];
  }

  async configUpdated(config) {
    let parsed;
    try {
      parsed = configureDevices(config, this.config);
    } catch (error) {
      this.layoutError = error.message;
      this.updateStatus(InstanceStatus.BadConfig, this.layoutError);
      this.log('warn', this.layoutError);
      return;
    }

    const recovered = this.layoutError !== null;
    this.layoutError = null;
    if (!isDeepStrictEqual(config, parsed)) {
      this.saveConfig(parsed, undefined);
    }
    if (!recovered && isDeepStrictEqual(this.config, parsed)) return;
    if (!recovered && isDeepStrictEqual({ ...parsed, manualProbeIp: null }, { ...this.config, manualProbeIp: null })) {
      this.config = parsed;
      this.stopDiscovery();
      if (this.socketReady) this.startReadingIPs();
      return;
    }
    this.stopDiscovery();
    for (const interval of Object.values(this.pushIntervals)) clearInterval(interval);
    this.pushIntervals = {};
    this.config = parsed;
    this.initDevices();
    this.initVariables();
    this.initActions();
    this.initFeedbacks();
    this.initPresets();
    this.updateVariableValues();
    this.status = null;
    this.discoveryResults = null;
    this.discoveredIps = [];
    this.nextFullScan = 0;
    if (this.socketReady) {
      this.updateStatus(InstanceStatus.Connecting);
      this.startReadingIPs();
    }
  }

  stopDiscovery() {
    clearInterval(this.readInterval);
    this.scanController?.controller.abort();
    this.scanController = null;
  }

  async destroy() {
    for (const name of this.deviceNames) {
      if (this.pushIntervals[name]) {
        clearInterval(this.pushIntervals[name]);
      }
    }
    this.stopDiscovery();
    this.resolveDiscoverySocket();
    const socket = this.socket;
    const ready = this.socketReady;
    this.socket = null;
    this.socketReady = false;
    if (ready) socket.close();
    const discoverySocket = this.discoverySocket;
    const discoveryReady = this.discoverySocketReady;
    this.discoverySocket = null;
    this.discoverySocketReady = false;
    if (discoveryReady) discoverySocket.close();
    this.log('info', 'Module destroyed');
  }
}

module.exports = SennheiserEW;
