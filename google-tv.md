# Google TV Remote

Control Google TV and Android TV devices Provides comprehensive control of Google TV / Android TV devices via network. Uses the Android TV Remote protocol v2 (same as Google TV mobile app). Supports discovery, pairing, media control, app management, and more. Common use cases: - Control: "Turn off the TV", "Set volume to 50" - Media: "Play/pause the current content" - Apps: "Launch Netflix", "Open YouTube" - Navigation: "Press home", "Go back" Example: connect({ ip: "192.168.1.100" })  // Will prompt for pairing code if needed Configuration: - credentials_file: Path to store TV credentials (optional, default: "google-tv-credentials.json") Dependencies are auto-installed on first run.

> **37 tools** · Workflow Photon · v1.0.0 · MIT

**Platform Features:** `generator` `elicitation` `streaming` `stateful` `channels`

## ⚙️ Configuration


| Variable | Required | Type | Description |
|----------|----------|------|-------------|
| `GOOGLE_T_V_CREDENTIALS_FILE` | No | string | Path to store TV credentials (optional, default: "google-tv-credentials.json") |



### Setup Instructions

- credentials_file: Path to store TV credentials (optional, default: "google-tv-credentials.json")
Dependencies are auto-installed on first run.


## 📋 Quick Reference

| Method | Description |
|--------|-------------|
| `discover` | Discover Google TV / Android TV devices on the network using mDNS |
| `connect` ⚡ | Connect to a Google TV / Android TV device Uses generator pattern with ask/emit yields: - emit: status updates during connection - ask: pairing code input when needed |
| `disconnect` | Disconnect from the TV |
| `status` | Get current connection status |
| `list` | List discovered and saved TVs |
| `forget` | Delete saved credentials for a TV |
| `volume` | Get/set volume level |
| `mute` | Toggle mute |
| `on` | Turn TV on (wake from sleep) |
| `off` | Turn TV off (put to sleep) |
| `power` | Toggle power |
| `app` | Launch an app via deep link |
| `launch` | Launch popular streaming apps |
| `play` | Play media |
| `pause` | Pause media |
| `playPause` | Toggle play/pause |
| `stop` | Stop media |
| `next` | Skip to next |
| `previous` | Skip to previous |
| `rewind` | Rewind |
| `forward` | Fast forward |
| `home` | Go to home screen |
| `back` | Go back |
| `select` | Select / Enter / OK |
| `up` | Navigate up |
| `down` | Navigate down |
| `left` | Navigate left |
| `right` | Navigate right |
| `menu` | Open menu |
| `settings` | Open settings |
| `info` | Show info/details |
| `channelUp` | Channel up |
| `channelDown` | Channel down |
| `input` | Switch TV input source |
| `button` | Send remote button press or list supported buttons |
| `number` | Send a number (0-9) |
| `remoteUI` | Show interactive TV remote control UI |


## 🔧 Tools


### `discover`

Discover Google TV / Android TV devices on the network using mDNS


| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `timeout` | any | No | Discovery timeout in seconds |





---


### `connect` ⚡

Connect to a Google TV / Android TV device Uses generator pattern with ask/emit yields: - emit: status updates during connection - ask: pairing code input when needed


| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ip` | string | Yes | TV IP address (required for first connection) |
| `name` | string | No | Optional friendly name for the TV |





---


### `disconnect`

Disconnect from the TV





---


### `status`

Get current connection status





---


### `list`

List discovered and saved TVs


| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `refresh` | any | No | If true, re-discover TVs on network |





---


### `forget`

Delete saved credentials for a TV


| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ip` | string | Yes | TV IP address |





---


### `volume`

Get/set volume level


| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `level` | any | Yes | Volume level (0-100), "+N" to increase by N, "-N" to decrease by N, or omit to get current |





---


### `mute`

Toggle mute


| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `mute` | any | Yes | True to mute, false to unmute (optional - omit to toggle) |





---


### `on`

Turn TV on (wake from sleep)





---


### `off`

Turn TV off (put to sleep)





---


### `power`

Toggle power





---


### `app`

Launch an app via deep link


| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | Yes | App deep link URL (e.g., "https://www.netflix.com", "https://www.youtube.com") |





---


### `launch`

Launch popular streaming apps


| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | 'netflix' | 'youtube' | 'disney' | 'prime' | 'hulu' | 'hbo' | 'spotify' | 'plex' | Yes | App name: netflix, youtube, disney, prime, hulu, hbo, spotify |





---


### `play`

Play media





---


### `pause`

Pause media





---


### `playPause`

Toggle play/pause





---


### `stop`

Stop media





---


### `next`

Skip to next





---


### `previous`

Skip to previous





---


### `rewind`

Rewind





---


### `forward`

Fast forward





---


### `home`

Go to home screen





---


### `back`

Go back





---


### `select`

Select / Enter / OK





---


### `up`

Navigate up





---


### `down`

Navigate down





---


### `left`

Navigate left





---


### `right`

Navigate right





---


### `menu`

Open menu





---


### `settings`

Open settings





---


### `info`

Show info/details





---


### `channelUp`

Channel up





---


### `channelDown`

Channel down





---


### `input`

Switch TV input source





---


### `button`

Send remote button press or list supported buttons


| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `button` | any | Yes | Button name (omit or use 'all' to list all supported buttons)
   *
   * Navigation: HOME, BACK, MENU, UP, DOWN, LEFT, RIGHT, SELECT, ENTER
   * Media: PLAY, PAUSE, PLAY_PAUSE, STOP, NEXT, PREVIOUS, REWIND, FORWARD
   * Volume: VOLUME_UP, VOLUME_DOWN, MUTE
   * Power: POWER, SLEEP, WAKEUP
   * TV: INPUT, CHANNEL_UP, CHANNEL_DOWN, INFO, GUIDE, SETTINGS
   * Colors: RED, GREEN, YELLOW, BLUE
   * Numbers: NUM_0 through NUM_9 |





---


### `number`

Send a number (0-9)


| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `number` | number | Yes | The number to send (0-9) |





---


### `remoteUI`

Show interactive TV remote control UI





---





## 🏗️ Architecture

```mermaid
flowchart TD
    subgraph google_tv["📦 Google Tv"]
        START([▶ Start])
        N0[📢 Connecting to ${ip}...]
        START --> N0
        N1[📢 Using saved credentials]
        N0 --> N1
        N2[📢 Starting pairing process...]
        N1 --> N2
        N3[⏳ progress]
        N2 --> N3
        N4[📢 TV is showing a pairing code]
        N3 --> N4
        N5[⏳ progress]
        N4 --> N5
        N6{✏️ text}
        N5 --> N6
        N7[📢 Sending pairing code...]
        N6 --> N7
        N8[⏳ progress]
        N7 --> N8
        N9[⏳ progress]
        N8 --> N9
        N10[🎉 Connected and paired!]
        N9 --> N10
        N11[⏳ progress]
        N10 --> N11
        N12[⏳ progress]
        N11 --> N12
        N13[🎉 Connected!]
        N12 --> N13
        SUCCESS([✅ Success])
        N13 --> SUCCESS
    end
```


## 📥 Usage

```bash
# Install from marketplace
photon add google-tv

# Get MCP config for your client
photon info google-tv --mcp
```

## 📦 Dependencies


```
androidtv-remote@^1.0.7
```

---

MIT · v1.0.0 · Photon
