const { createSocket } = require('node:dgram');
const { execFile } = require('node:child_process');
const { readFile } = require('node:fs/promises');
const { networkInterfaces } = require('node:os');
const { isIPv4 } = require('node:net');
const { promisify } = require('node:util');

const run = promisify(execFile);

function normalizeMac(value) {
  if (typeof value !== 'string') return null;
  const octets = value.trim().toLowerCase().split(/[:-]/);
  if (octets.length !== 6 || !octets.every((octet) => /^[0-9a-f]{1,2}$/.test(octet))) return null;
  return octets.map((octet) => octet.padStart(2, '0')).join(':');
}

function ipv4Number(address) {
  return address.split('.').reduce((sum, octet) => sum * 256 + Number(octet), 0);
}

function scanTargets() {
  const targets = new Set();
  const interfaces = networkInterfaces();
  const selected = Object.values(interfaces).flat();
  const localAddresses = new Set(selected.map((entry) => entry.address));
  for (const entry of selected) {
    if (entry.internal || entry.family !== 'IPv4' || !entry.cidr) continue;
    const prefix = Number(entry.cidr.split('/')[1]);
    if (prefix < 24 || prefix > 30) continue;
    const size = 2 ** (32 - prefix);
    const start = Math.floor(ipv4Number(entry.address) / size) * size;
    for (let offset = 1; offset < size - 1; offset++) {
      const host = start + offset;
      const ip = [24, 16, 8, 0].map((bits) => (host >>> bits) & 255).join('.');
      if (!localAddresses.has(ip)) targets.add(ip);
    }
  }
  return [...targets];
}

async function readNeighbors() {
  const neighbors = new Map();
  const record = (ip, rawMac) => {
    const mac = normalizeMac(rawMac);
    if (!isIPv4(ip) || !mac || mac === '00:00:00:00:00:00') return;
    neighbors.set(ip, neighbors.has(ip) && neighbors.get(ip) !== mac ? null : mac);
  };

  const options = { timeout: 1500, windowsHide: true };
  if (process.platform === 'linux') {
    try {
      // Use the kernel's IPv4 neighbor table directly on CompanionPi.
      const table = await readFile('/proc/net/arp', 'utf8');
      for (const line of table.split('\n').slice(1)) {
        const [ip, , flags, mac] = line.trim().split(/\s+/);
        if ((Number(flags) & 0x2) !== 0) record(ip, mac);
      }
      return neighbors;
    } catch {
      const { stdout } = await run('ip', ['-4', 'neigh', 'show'], options);
      for (const line of stdout.split('\n')) {
        const match = line.match(/^([\d.]+) dev (\S+) lladdr (\S+)/);
        if (match && !/\b(?:FAILED|INCOMPLETE)\b/.test(line)) record(match[1], match[3]);
      }
      return neighbors;
    }
  }

  const { stdout } = await run('arp', [process.platform === 'darwin' ? '-an' : '-a'], options);
  for (const line of stdout.split('\n')) {
    const match = process.platform === 'win32'
      ? line.match(/^\s*([\d.]+)\s+(\S+)\s+/)
      : line.match(/\(([\d.]+)\) at (\S+) on (\S+)/);
    if (match) record(match[1], match[2]);
  }
  return neighbors;
}

const WSM_PORT = 8133;
const WSM_GROUP = '224.0.0.251';

function discoveryRequest() {
  const packet = Buffer.alloc(1035);
  const command = Buffer.from('[servicecommand]devinfo\r\n');
  packet.writeUInt32LE(0x20060712);
  packet.writeUInt16LE(command.length, 6);
  command.copy(packet, 8);
  packet.fill(1, 1032);
  return packet;
}

async function probeWsm() {
  const interfaces = networkInterfaces();
  const selected = Object.values(interfaces).flat();
  const addresses = new Set(selected
    .filter((entry) => entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address));
  const packet = discoveryRequest();

  await Promise.all([...addresses].map((address) => new Promise((resolve) => {
    const socket = createSocket('udp4');
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      socket.close();
      resolve();
    };
    socket.once('error', close);
    socket.bind(0, address, () => {
      try {
        socket.setMulticastInterface(address);
        socket.send(packet, WSM_PORT, WSM_GROUP, close);
      } catch {
        close();
      }
    });
  })));
}

function parseAnnouncement(packet, remote) {
  const text = packet.toString('ascii');
  const model = text.match(/Model=([A-Z0-9-]+(?: [A-Z0-9-]+)*?)(?=\s{2,}|\s+(?:ID|IDX|IPA)=|\0)/i)?.[1];
  const identifier = text.match(/(?:^|\s)ID=([0-9a-f]{12})(?=\s|\0|$)/i)?.[1];
  const ip = text.match(/(?:^|\s)IPA=([\d.]+)/i)?.[1];
  if (!model || !identifier || !isIPv4(ip) || ip !== remote.address) return null;
  const type = model.match(/^(EM|SR)(?=[\d\s]|IEM)/i)?.[1].toUpperCase();
  const mac = normalizeMac(identifier.match(/../g).join(':'));
  if (!type || mac === '00:00:00:00:00:00') return null;
  return { type, mac, ip, model };
}

module.exports = { normalizeMac, scanTargets, readNeighbors, WSM_PORT, WSM_GROUP, discoveryRequest, probeWsm, parseAnnouncement };
