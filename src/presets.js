const COLORS = {
  background: 0x000000,
  white: 0xffffff,
  cyan: 0x00e5ff,
  green: 0x00ff00,
  yellow: 0xffff00,
  red: 0xff0000,
};

const RF_COLORS = [[0, COLORS.red], [55, COLORS.yellow], [85, 0x40ff40]];
const AF_COLORS = [[0, COLORS.green], [65, COLORS.yellow], [90, COLORS.red]];
const SYSTEM_SECTIONS = [
  { type: 'EM', id: 'microphones', name: 'Microphone systems' },
  { type: 'SR', id: 'iem', name: 'IEM systems' },
];

const expression = (value) => ({ value, isExpression: true });
const text = (id, value, y, height, color = COLORS.white) => ({
  id, type: 'text', text: value, x: 2, y, width: 96, height, color, opacity: 100,
  halign: 'center', valign: 'center', fontsize: 96, fontsizeAllowShrink: true,
});

function gauge(id, value, y, colors) {
  return {
    id, type: 'gauge', value: expression(value), x: 6, y, width: 88, height: 13, opacity: 100,
    min: 0, max: 100, orientation: 'horizontal', roundedEnds: true, fillEnabled: true,
    trackStyle: 'transparent', trackAmount: 40, multiColour: true,
    stops: colors.map(([value, color]) => ({ value, color, gradient: false })),
  };
}

function button(name, elements, steps = [{ down: [], up: [] }]) {
  return {
    type: 'layered', name, canvas: { decoration: 'none', showStatusIcons: 'none' },
    elements: [{ type: 'box', color: COLORS.background, x: 0, y: 0, width: 100, height: 100, opacity: 100 }, ...elements],
    steps, feedbacks: [],
  };
}

function rotaryStep(actionId) {
  return {
    down: [],
    up: [],
    rotate_left: [{ actionId, options: { direction: 'down' } }],
    rotate_right: [{ actionId, options: { direction: 'up' } }],
  };
}

const box = (id, x, y, width, height, color) => ({
  id, type: 'box', x, y, width, height, color, opacity: 100,
});
const when = (element, condition) => ({ ...element, enabled: expression(condition) });

function batterySegments(variable) {
  const bars = variable('battery_bars');
  return [0, 1, 2].flatMap((index) => {
    const id = 'battery_' + (index + 1);
    const x = 6 + 30 * index;
    return [
      box(id + '_empty', x, 23, 26, 12, 0x303030),
      when(box(id, x, 23, 26, 12, index === 0 ? COLORS.yellow : COLORS.green), bars + ' > ' + index),
    ];
  });
}

function demoPresets(type, presets) {
  const slot = type === 'EM' ? 'ew1' : 'ew2';
  const example = getPresets('iem-demo', [slot], () => type);
  const section = example.structure.find((entry) => entry.definitions.length);
  const values = {
    display_name: 'DEMO', online: 1, mute_number: 0, frequency: '542.350',
    af_level: 67, af_level_right: 49, rf_level_1: 85, rf_level_2: 72,
    squelch: 11, af_out: -12, battery_bars: 2, encoder_mode: 'af_out',
    mode: 'Stereo', sensitivity: -18,
  };
  const replace = (value, expressionMode) => typeof value === 'string'
    ? value.replace(/\$\(iem-demo:ew[12]_(\w+)\)/g, (_, key) =>
      expressionMode ? JSON.stringify(values[key]) : String(values[key]))
    : value;
  const ids = section.definitions[0].presets.map((id) => {
    const demoId = 'demo_' + id;
    const preset = example.presets[id];
    presets[demoId] = button('Demo · ' + preset.name.split(' · ').slice(1).join(' · '),
      preset.elements.slice(1).map((element) => Object.fromEntries(Object.entries(element).map(([key, value]) => [
        key, value?.isExpression === true ? expression(replace(value.value, true)) : replace(value, false),
      ]))));
    return demoId;
  });
  return {
    id: 'demo', name: 'Demo', type: 'simple', presets: ids,
    description: 'Sample readings. These buttons do not control hardware.',
  };
}

function getPresets(label, slots, getDeviceType, onlineTypes) {
  const presets = {};
  const groups = { EM: [], SR: [] };
  for (const slot of slots) {
    const receiver = getDeviceType(slot) === 'EM';
    const variable = (key) => '$(' + label + ':' + slot + '_' + key + ')';
    const online = variable('online') + ' == 1';
    const muted = variable('mute_number') + ' == 1';
    presets[slot + '_status'] = button(slot.toUpperCase() + ' · Status · Name, frequency, mute and connection', [
      text('name', variable('display_name'), 2, 33),
      text('frequency', variable('frequency'), 36, 30, COLORS.cyan),
      when(text('muted', 'Muted', 68, 28, COLORS.red), online + ' && ' + muted),
      when(text('ok', receiver ? 'OK@' : 'OK', 68, 28, COLORS.green), online + ' && ' + variable('mute_number') + ' == 0'),
      when(text('offline', 'OFFLINE', 68, 28, 0xb0b0b0), variable('online') + ' == 0'),
    ]);

    const ids = [slot + '_status'];
    if (receiver) {
      const sqlMode = variable('encoder_mode') + ' == "squelch"';
      const afMode = variable('encoder_mode') + ' == "af_out"';
      const rf = (id, value, x) => ({
        ...gauge(id, value, 27, RF_COLORS), x, width: 13, height: 66, orientation: 'vertical',
      });
      const rfMeters = [
        text('rf', 'RF 1 / 2', 0, 24, COLORS.cyan),
        rf('rf1', variable('rf_level_1'), 7),
        rf('rf2', variable('rf_level_2'), 35),
        {
          id: 'squelch_marker', type: 'line', opacity: 100, fromX: 27, toX: 27,
          fromY: expression('93 - ' + variable('squelch') + ' * 2.3'), toY: 93,
          borderWidth: 5, borderColor: COLORS.white, borderPosition: 'center',
          enabled: expression(variable('squelch') + ' > 0'),
        },
      ];
      const sqlReadout = [
        { ...text('sql_label', 'SQL', 32, 22), x: 51, width: 47 },
        { ...text('sql', variable('squelch'), 54, 34), x: 51, width: 47 },
      ];
      presets[slot + '_rf'] = button(slot.toUpperCase() + ' · RF 1/2 + SQL · Turn to adjust Squelch', [
        ...rfMeters,
        when(box('sql_active', 51, 29, 47, 61, 0x00596c), sqlMode),
        ...sqlReadout,
      ], [rotaryStep('nudge_squelch_' + slot)]);
      presets[slot + '_out'] = button(slot.toUpperCase() + ' · OUT · Live AF level, turn to adjust AF Out', [
        text('out_label', 'OUT', 0, 23, COLORS.yellow),
        text('out_value', variable('af_out') + ' dB', 25, 45),
        gauge('af', variable('af_level'), 78, AF_COLORS),
      ], [rotaryStep('nudge_af_out_' + slot)]);
      const batteryKnown = variable('battery_bars') + ' >= 0';
      presets[slot + '_af'] = button(slot.toUpperCase() + ' · AF + Battery · Audio level, charge and output gain', [
        when(text('battery_label', 'BAT', 0, 23, COLORS.cyan), batteryKnown),
        when(text('battery_unknown', 'BAT ?', 0, 23, COLORS.cyan), variable('battery_bars') + ' < 0'),
        ...batterySegments(variable),
        text('af_label', 'AF', 37, 22, COLORS.green),
        gauge('af', variable('af_level'), 59, AF_COLORS),
        when(box('af_active', 2, 73, 96, 27, 0x715500), afMode),
        text('level', 'OUT ' + variable('af_out'), 73, 27),
      ]);
      presets[slot + '_encoder'] = button(slot.toUpperCase() + ' · Dual encoder · Press to switch AF Out / SQL', [
        text('switch_hint', 'PRESS TO SWITCH', 2, 27),
        { ...text('knob_modes', 'OUT / SQL', 34, 28, 0xb0b0b0), x: 2, width: 52 },
        when({ ...text('knob_value', variable('af_out') + ' dB', 31, 35, COLORS.yellow),
          x: 54, width: 44 }, afMode),
        when({ ...text('sql_value', variable('squelch') + ' dB', 31, 35, COLORS.cyan),
          x: 54, width: 44 }, sqlMode),
        when(box('out_selected', 3, 64, 19, 4, COLORS.yellow), afMode),
        when(box('sql_selected', 34, 64, 19, 4, COLORS.cyan), sqlMode),
        text('rotate_hint', 'ROTATE TO CHANGE', 72, 27),
      ], [{
        down: [{ actionId: 'toggle_encoder_mode_' + slot, options: {} }],
        up: [],
        rotate_left: [{ actionId: 'nudge_encoder_' + slot, options: { direction: 'down' } }],
        rotate_right: [{ actionId: 'nudge_encoder_' + slot, options: { direction: 'up' } }],
      }]);
      ids.push(slot + '_rf', slot + '_out', slot + '_af', slot + '_encoder');
    } else {
      presets[slot + '_iem'] = button(slot.toUpperCase() + ' · IEM input · Stereo AF meters', [
        text('input_1', 'AF 1', 0, 23, COLORS.cyan),
        gauge('af_1', variable('af_level'), 25, AF_COLORS),
        text('input_2', 'AF 2', 43, 23, COLORS.cyan),
        gauge('af_2', variable('af_level_right'), 70, AF_COLORS),
      ]);
      presets[slot + '_iem_sens'] = button(slot.toUpperCase() + ' · IEM sensitivity · Turn to adjust', [
        text('sens_label', 'IEM SENS', 4, 30, COLORS.cyan),
        text('sensitivity', variable('sensitivity') + ' dB', 37, 54),
      ], [rotaryStep('nudge_sensitivity_' + slot)]);
      presets[slot + '_iem_mode'] = button(slot.toUpperCase() + ' · IEM mode · Press for Mono / Stereo', [
        text('mode_label', 'IEM MODE', 7, 30, COLORS.cyan),
        text('mode', variable('mode'), 39, 52),
      ], [{ down: [{ actionId: 'toggle_iem_mode_' + slot, options: {} }], up: [] }]);
      presets[slot + '_iem_mute'] = button(slot.toUpperCase() + ' · IEM RF Mute · Press to toggle carrier', [
        text('mute_label', 'IEM RF', 7, 30, COLORS.cyan),
        when(text('rf_off', 'MUTED', 40, 47, COLORS.red), online + ' && ' + muted),
        when(text('rf_on', 'ON', 40, 47, COLORS.green), online + ' && ' + variable('mute_number') + ' == 0'),
        when(text('rf_offline', 'OFFLINE', 40, 47, 0xb0b0b0), variable('online') + ' == 0'),
      ], [{ down: [{ actionId: 'set_mute_' + slot, options: { state: 'toggle' } }], up: [] }]);
      ids.push(slot + '_iem', slot + '_iem_sens', slot + '_iem_mode', slot + '_iem_mute');
    }
    const type = receiver ? 'EM' : 'SR';
    groups[type].push({ id: slot, name: slot.toUpperCase() + ' · ' + type, type: 'simple', presets: ids });
  }
  const structure = SYSTEM_SECTIONS.map(({ type, id, name }) => {
    const definitions = groups[type];
    if (onlineTypes && !onlineTypes.has(type)) definitions.push(demoPresets(type, presets));
    return { id, name, definitions };
  });
  return { structure, presets };
}

module.exports = { getPresets };
