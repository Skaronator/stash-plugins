# OSSM Interactive Plugin

This plugin adds OSSM support for interactive scenes by replacing the default Handy client with a Web Bluetooth OSSM client when enabled.

## Requirements

- A Chromium-based browser with Web Bluetooth support
- Stash opened from `https://...` or `http://localhost...`
- An OSSM advertising over BLE with the standard OSSM service

## Installation

1. Copy the `ossm-interactive` directory into your Stash `plugins` directory.
2. Reload plugins from `Settings > Plugins`.
3. In the plugin settings, enable `Enable OSSM playback`.
4. Click `Connect OSSM` in the plugin settings section and select your device in the browser prompt.

## Usage

- Scenes that already have funscripts and are marked interactive will play through OSSM after the device is connected.
- The existing Stash `Funscript offset` interface setting still applies and is used as a millisecond offset for OSSM playback.
- If you enable `OSSM latency compensation`, the plugin writes to the OSSM latency characteristic and schedules commands to match the funscript timing.

## Notes

- Device selection is browser-local because Web Bluetooth permissions are granted by the browser, not by the Stash server.
- Reloading the page clears the live BLE connection. Reconnect from the plugin settings when needed.
