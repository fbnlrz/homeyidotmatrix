# iDotMatrix — Reverse-engineering reference

Everything we learned about iDotMatrix-branded BLE pixel displays while
building this Homey integration. Verified primarily on `IDM-BC5C5F` (32×32,
firmware shipping in 2026-Q2); most of it applies to 16×16 and 64×64
variants too. Sources cross-checked against
[derkalle4/python3-idotmatrix-library](https://github.com/derkalle4/python3-idotmatrix-library)
and [8none1/idotmatrix](https://github.com/8none1/idotmatrix).

---

## 1. Hardware

| Component  | Notes |
|---|---|
| BLE chip  | Jieli — `com.jieli.jl_bt_ota.*` references in the Android APK confirm this |
| Display  | 16×16 / 32×32 / 64×64 RGB LED matrix |
| Microphone  | Built-in, used for the **music-sync** dancing-figure animation |
| Piezo / buzzer  | Plays a short beep on power-up only; **no known BLE opcode** to trigger it remotely. Soft-reset (`reset_device`) re-runs the boot sequence and produces the beep |
| Battery  | Present in most variants — exact capability not exposed over BLE |
| Power-on glyph  | Reports its name and runs a small init animation |

---

## 2. BLE topology

### Advertisement

- Local name pattern: `IDM-<6 hex chars>` (e.g. `IDM-BC5C5F`)
- Advertises service `0x00FA`
- No pairing / bonding required (Just-Works connection)
- Negotiated MTU on this firmware: **517 bytes** (per nRF Connect)

### Services

| Service UUID | Short | Purpose |
|---|---|---|
| `000000fa-0000-1000-8000-00805f9b34fb` | `0x00FA` | **Display control** — fully unlocked, what this app uses |
| `0000ae00-0000-1000-8000-00805f9b34fb` | `0xAE00` | **OTA firmware update** — AES-256-CBC encrypted, see `docs/AE-SERVICE.md` |

> Important quirk: Homey BLE returns the FA service's short UUID as `00fa` —
> note byte order (`000000fa…`, not `0000fa00…`) compared to the AE service.

### Characteristics on `0x00FA`

| Char UUID | Short | Properties | Purpose |
|---|---|---|---|
| `0000fa02-…` | `0xFA02` | write, write-without-response | Send commands |
| `0000fa03-…` | `0xFA03` | notify | Per-command ack |

### Characteristics on `0xAE00`

| Char UUID | Short | Properties | Purpose |
|---|---|---|---|
| `0000ae01-…` | `0xAE01` | write-without-response | OTA frames (encrypted) |
| `0000ae02-…` | `0xAE02` | notify | OTA responses |

---

## 3. Acknowledgement pattern

Every command written to `fa02` produces a notification on `fa03` of the form
`0x05 0x00 <cmd> <subcmd> 0x01` within ~300 ms.

For example, **screen-off** (`05 00 07 01 00`) produces ack `05 00 07 01 01`.

Image and GIF uploads use a different ack pattern — `[01, 00, 03, 00, 01]`
during the chunk stream and `[01, 00, 03, 00, 03]` when the upload is fully
received. This app's BLE client gates chunked image / GIF transfers on these
acks.

---

## 4. Opcodes (display-control, `fa02`)

All opcodes are byte arrays sent verbatim. Multi-byte numeric fields are
little-endian unless noted. `clamp()` notes describe the device's accepted
range — values outside that may silently fail.

### 4.1 Power

| Command | Bytes |
|---|---|
| Screen on  | `05 00 07 01 01` |
| Screen off  | `05 00 07 01 00` |

### 4.2 Brightness (5–100 %)

`05 00 04 80 NN` where `NN` is the percentage. Values < 5 are clamped to 5.

### 4.3 Flip 180°

`05 00 06 80 0|1` — second byte controls the flip flag.

### 4.4 Freeze / unfreeze

`04 00 03 0|1` — freezes the current frame.

### 4.5 Set time (required before clock / countdown / chronograph)

`0b 00 01 80 yy mm dd dow hh mm ss` — `yy` is year mod 100; `dow` is the
day-of-week with Sunday → 7 mapping (Mon=1, …, Sun=7).

### 4.6 Clock

`08 00 06 01 styleByte rr gg bb`

`styleByte = (style & 7) | (visibleDate ? 0x80 : 0) | (hour24 ? 0x40 : 0)`

Style 0..7 are vendor-defined "clock face" layouts.

### 4.7 Countdown

`07 00 08 80 mode mm ss`

| `mode` | Effect |
|---|---|
| 0  | Disable |
| 1  | Start with given mm:ss |
| 2  | Pause |
| 3  | Restart from same mm:ss |

### 4.8 Chronograph (stopwatch)

`05 00 09 80 mode`

| `mode` | Effect |
|---|---|
| 0  | Reset to 0:00:00 |
| 1  | Start |
| 2  | Pause |
| 3  | Continue |

### 4.9 Scoreboard

`08 00 0a 80 a_lo a_hi b_lo b_hi`

Each counter is a 16-bit big-endian value clamped to 0…999. Note that
although the value is big-endian conceptually, the bytes are sent in
`lo-hi` order on the wire — see python ref `Scoreboard.setMode`.

### 4.10 Fullscreen solid color

`07 00 02 02 r g b`

### 4.11 Built-in effects (device-side animation)

`[length, 0, 03, 02, style, 90, rgb_count, r1,g1,b1, … r7,g7,b7]`

`length = 6 + rgb_count*3`. `rgb_count` is 2…7. The colors feed the effect
generator on-device.

| Style | Effect |
|---|---|
| 0  | Horizontal rainbow |
| 1  | Random color pixels (changing) |
| 2  | Random white pixels on a changing color background |
| 3  | Vertical rainbow |
| 4  | Diagonal rainbow (up-right) |
| 5  | Diagonal rainbow (down-right) |
| 6  | Random colored pixels |

### 4.12 DIY mode (enter before image upload)

`05 00 04 01 mode` — mode `1` selects pixel-art drawing mode.

### 4.13 Music sync (microphone reactive)

| Command | Bytes |
|---|---|
| Start  | `06 00 00 02 type 01` |
| Stop   | `06 00 00 02 00 00` |

`type` selects the visualization variant (1 = dancing stick figure).
The device drives the animation from its built-in mic — no audio data
is transmitted over BLE in either direction.

There is also an unused `setMicType(t)` opcode in the Python reference
(`06 00 0b 80 type`) — never sent by the Android app.

### 4.14 Reset

Two writes in sequence:

```
04 00 03 80
05 00 04 80 50
```

This forces the display back to defaults and re-runs the boot animation
(including the piezo beep).

### 4.15 Text packet

The text opcode is a 16-byte header + 14-byte metadata + N×68-byte
per-character blocks.

**Header**

```
[total_len(2 LE), 03, 00, 00, packet_len(4 LE), crc32(4 LE), 00, 00, 12]
```

- `total_len` = header + packet length
- `packet_len` = metadata length + bitmap stream length
- `crc32` = zlib CRC32 of the packet bytes only (not the header)
- Trailing 12 is constant

**Metadata** (14 bytes)

```
[num_chars(2 LE), 00, 01, mode, speed, color_mode, r, g, b, bg_mode, bg_r, bg_g, bg_b]
```

| Mode | Effect |
|---|---|
| 0 | Replace |
| 1 | Marquee (right-to-left) |
| 2 | Reverse marquee (left-to-right) |
| 3 | Vertical rise |
| 4 | Vertical lower |
| 5 | Blink |
| 6 | Fade |
| 7 | Tetris |
| 8 | Fill |

| Color mode | Effect |
|---|---|
| 0 | White (RGB ignored) |
| 1 | Solid RGB |
| 2-5 | Built-in rainbow variants (RGB ignored) |

**Per-character block** (4 + 64 bytes per char)

```
05 ff ff ff           ← separator
<64 bytes>            ← 16×32 monochrome bitmap, LSB-first by column
```

Each character's bitmap is 16 columns × 32 rows, packed as 2 bytes per row
(LSB of byte 0 = leftmost pixel). Larger fonts simply use 16-wide / 32-tall
glyphs.

#### Mirror-text protocol notes

For viewing through a camera that horizontally flips its preview (e.g.
selfie / camera background), this app applies two transforms:

1. Flip each glyph's bitmap horizontally (pixel at column `x` → `15 - x`).
2. Swap marquee modes 1 ↔ 2 so the scroll direction also reverses.

The **character order is NOT reversed** — the mirror itself handles that.
Reversing the string too would over-correct.

### 4.16 Image upload (PNG, single static frame)

1. Send `buildDiyMode(1)` first
2. Then a concatenated payload of per-chunk records

Per-chunk record (concatenated into one big buffer):

```
idk_bytes(2 LE) | [00, 00, flag] | png_len(4 LE) | <PNG chunk data ≤ 4096 B>
```

- `idk = pngLen + chunkCount` (LE int16)
- `flag = 0` for the first chunk, `2` for every subsequent chunk
- The whole concatenated buffer is then MTU-chunked at the BLE layer
  (this app uses 200 B chunks — safe for any peer's MTU)

The device buffers BLE writes until it has `png_len` bytes after the last
header, then decodes the PNG and renders it.

### 4.17 GIF upload (animated)

Per-chunk frame (each chunk is one BLE-level write):

```
[size_lo, size_hi, 01, 00, flag, total_len(4 LE), crc32(4 LE), 05, 00, 13]
| <GIF bytes ≤ 4096 B per chunk>
```

- `size_lo/hi` = total chunk size (header + payload)
- `flag = 0` for first chunk, `2` for subsequent
- `total_len` = full GIF file length
- `crc32` = zlib CRC32 of the GIF file

The device reassembles all chunks, verifies the CRC, then decodes the
animated GIF.

---

## 5. Image / GIF sizing

The device only **shows** what fits in its physical pixel matrix. It does
not resize uploaded images on its own — anything bigger than the matrix
gets cropped to the top-left corner. This app pre-resizes everything to
the configured pixel size (default 32×32) before upload:

- **Static images**: Jimp → resize (`contain` / `cover` / `stretch` /
  `center`) → PNG (`colorType: 2` no alpha, `deflateLevel: 9`) → upload
- **Animated GIFs**: `omggif` per-frame nearest-neighbor scaling, global
  palette quantization (≤ 256 colors), re-encode → upload

---

## 6. RSSI

Reads via `peripheral.updateRssi()` on Homey BLE. Typical values:

| RSSI | Interpretation |
|---|---|
| -45 dBm or higher  | Excellent (same room, close range) |
| -60 dBm  | Good |
| -75 dBm  | Marginal — write errors start appearing |
| -85 dBm or lower  | Connection unstable / drops |

This app samples every 30 s and shows the last hour as a graph in the
settings page.

---

## 7. OTA service (`0xAE00`) — separately documented

See [`docs/AE-SERVICE.md`](AE-SERVICE.md) for the reverse-engineering
findings, including:

- The 32-byte AES-256 key extracted from
  `com.heaton.baselib.utils.AESUtils.createCustomKey()` in the Android APK
- AES/CBC/PKCS7Padding confirmed
- The unsolved per-session plaintext header that prevented matching the
  device's responses byte-for-byte
- Legal framing under EU Software Directive Art. 6 / § 69e UrhG

> **TL;DR**: We identified the algorithm and key but did not finish the
> handshake. Display control via `0x00FA` is independent and fully
> functional; OTA over BLE is not currently implemented in this app.

---

## 8. Implementation notes for this app

| Concern | What we do |
|---|---|
| Discovery  | Scan with the service UUID filter; fall back to unfiltered + name prefix `IDM-` if Homey's filter rejects it |
| Reconnect  | Persistent loop with 1/2/5/10/30 s backoff, last value repeating forever — survives multi-hour power-offs |
| Silent-death detection | Heartbeat sends a no-op brightness opcode every 60 s; if no fa03 ack within ~3 s the link is declared dead and the reconnect loop runs |
| Chunk size  | 200 B BLE writes — works on any peer, well under the negotiated 517 |
| Image ack-gating  | Each app-level chunk waits for the `01 00 03 00 01` ack on fa03 before the next chunk is sent (default on for stability) |
| Cache  | Image pipeline keeps a 32 MB LRU keyed on `SHA-256(buffer + options)` — repeat plays of the same image are instant |

---

## 9. Useful resources

- [`derkalle4/python3-idotmatrix-library`](https://github.com/derkalle4/python3-idotmatrix-library) — Python reference implementation (this app's protocol is byte-compatible)
- [`8none1/idotmatrix`](https://github.com/8none1/idotmatrix) — additional protocol notes
- [`t-var-s/pixel-art-32`](https://github.com/t-var-s/pixel-art-32) — 32×32 pixel-art GIF collection
- [`lospec.com/gallery`](https://lospec.com/gallery) — searchable pixel-art gallery
- [`pixilart.com`](https://pixilart.com) — animated-GIF community gallery
- [`opengameart.org`](https://opengameart.org) — game sprites & assets in matching sizes

---

## 10. Known gaps

- OTA over the `0xAE00` service is not implemented (see § 7).
- The `setJoint` opcode in the Python ref (`05 00 0c 80 mode`) does
  something — purpose unclear; this app does not expose it.
- The `getDeviceLocation` opcode (`06 4c 4f 43 41 54 45 00 …` →
  ASCII "LOCATE") is hinted at but requires `0xAE00`-style encryption.
- The 6-digit `setPassword` opcode (`08 00 04 02 01 …`) exists; not
  exposed because mis-setting it could lock the display.
- The piezo buzzer cannot be commanded directly — only via soft-reset.

---

*Generated as part of the `com.idotmatrix` Homey app.
Source: <https://github.com/fbnlrz/homeyidotmatrix>. License: Unlicense.*
