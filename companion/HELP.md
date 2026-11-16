# Sennheiser Evolution Wireless

This connection controls rack units that support the Sennheiser Media Control Protocol on UDP 53212.

## Find and assign devices

1. Set **Number of device slots** to the number of rack positions you need. Let discovery run for a few seconds.
2. Choose a **Device** in each slot. Discovery refreshes in the background every 12 seconds. Reopen the connection settings to see newly discovered devices. If the browser still shows the earlier list, reload the page. The list shows the device name, MAC and current IP. The chosen device keeps its slot by MAC when DHCP changes or when the device is offline. Selecting a device already in another slot swaps the two positions.
3. **Device type** displays the detected type, either **EM (Receiver / Mic)** or **SR (Transmitter / IEM)**. Choosing the other value saves a manual override for that assignment.
4. If a device is missing, enter its IPv4 address in **Find a device by IPv4 address**, save, wait for the probe and reopen the settings. A device must answer Media Control commands on UDP 53212 to appear. When a MAC cannot be verified, an IPv4-only choice follows that address.

The module uses WSM multicast discovery. An optional fallback subnet scan is off by default. Existing slot assignments from older versions are imported automatically, including offline assignments.

On Linux the module reads the kernel IPv4 neighbor table directly and falls back to iproute2's `ip` command. On macOS and Windows it uses the system `arp` command. WSM and Companion can compete for local UDP 8133 if both run on the same host.


## Stream Deck+ encoders

Place **EWn · Dual encoder** in the encoder row. Press the encoder to switch the slot's adjustment mode. The matching RF or AF button highlights the selected parameter. Turning the knob adjusts AF Out by 3 dB or Squelch by 2 dB. Place RF and AF presets from the same slot as the encoder. Replace all three controls when upgrading an older layout to enable the shared mode indication.

The white mark between the two RF bars shows the current Squelch setting. Battery is shown in three segments. An unknown battery value is shown as **BAT ?**.


For separate controls, **EWn · OUT** shows the configured output gain in dB and the receiver's live AF meter. On a rotary position it adjusts AF Out by 3 dB per turn action. **EWn · RF 1/2 + SQL** shows both antenna levels and the Squelch marker. On a rotary position it adjusts Squelch by 2 dB per turn action. Both also work as display-only presets on ordinary keys.

**EWn · Status** shows the device name, frequency, mute state and whether the unit is online. Hover over any preset in Companion to see what it does.

## IEM transmitters

For an SR slot, **IEM input** shows AF 1 and AF 2, **IEM sensitivity** reads the configured input sensitivity and adjusts it by 3 dB per rotary step (-42 to 0 dB), and **IEM mode** changes Mono/Stereo on press. **IEM RF Mute** switches the transmitter carrier off or on. Settings on these presets follow replies from the transmitter.

Presets are grouped under **Microphone systems** and **IEM systems**. Each section has its own **Demo** group when no device of that type is online. A detected receiver hides only the microphone demo, and a detected IEM transmitter hides only the IEM demo. Demo buttons use sample readings and have no actions.
