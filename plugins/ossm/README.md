# OSSM

This plugin adds OSSM support to Stash's interactive playback flow by implementing a Stash UI interactive client over Web Bluetooth.

## What it does

- Connects to an OSSM device from the browser.
- Fetches the scene funscript that Stash already serves.
- Streams `stream:<position>:<time>` BLE commands to the OSSM in sync with the Stash scene player.
- Provides a control page at `/plugin/ossm` for connection state, offsets, buffer, and device tuning.

## How to use it

1. Install or copy this plugin into your Stash plugins directory.
2. Reload plugins in Stash.
3. Open `/plugin/ossm` in Stash.
4. In `Settings -> Interface`, set the Handy connection key to `ossm`.
5. Open an interactive scene and allow the browser to pair with your OSSM device.

The plugin only takes over interactive playback when the connection key is exactly `ossm`.

## Requirements

- A browser with Web Bluetooth support.
- An OSSM device advertising the documented BLE service.
- A Stash scene with an associated funscript.

## Notes

- The plugin does not depend on any existing plugin code in this repository.
- The built-in Handy client remains available when the connection key is anything other than `ossm`.
