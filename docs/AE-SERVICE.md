# BLE Service 0x00AE — Reverse-Engineering Findings

Status: **identified, not unlocked**.

## Purpose and legal framing

This document records interoperability research conducted under the
exception in EU Directive 2009/24/EC Article 6 (transposed to German
law as § 69e UrhG, equivalent provisions in other EU member states; in
the US, 17 USC §1201(f) for interoperability). The goal is making an
independently developed program (this Homey app) work correctly with
the iDotMatrix BLE pixel display that the end user already owns.

Material described here was extracted from the iDotMatrix Android app
(`com.tech.idotmatrix`, version 2.1.1, freely distributed via Google
Play and mirrors such as APKPure) using static analysis. No technical
protection measure was circumvented; the encryption key sits in
plain-text bytes in the published app binary.

This project is not affiliated with iDotMatrix, Heaton, Jieli, or any
related vendor. The findings are published so that other independent
implementations targeting interoperability can build on them, in line
with the practice of established open-source smart-home projects
(Home Assistant, ESPHome, etc.) that routinely document equivalent
material for other vendors.

## What we know

- **Service UUID**: `0000ae00-0000-1000-8000-00805f9b34fb`
- **Write characteristic** `ae01` (write-without-response)
- **Notify characteristic** `ae02` (notifications)
- **Purpose**: Firmware-over-the-air (OTA) update channel, **not** display
  control. Display control uses `0x00FA` and is fully functional in this
  app without touching `0x00AE`.

## Source-code identification (from `com.tech.idotmatrix` 2.1.1)

The Android app references this service via:

```java
// com.heaton.baselib.ble.BleManager
public static final UUID UUID_OTA_SERVICE = UUID.fromString(
  "0000ae00-0000-1000-8000-00805F9B34FB");
```

It is wired through the **Jieli OTA SDK** (`com.jieli.jl_bt_ota.*`) — the
BLE chip in iDotMatrix is a Jieli part, and this is the vendor's standard
OTA stack.

## Cryptography

### Confirmed parameters

- **Algorithm**: `AES/CBC/PKCS7Padding`
- **Key (ASCII)**: `Jy47rzJAgKMfrcc92PamyyukQqB7wmFu`
- **Key (Hex, 32 bytes → AES-256)**:
  `4a793437727a4a41674b4d66726363393250616d7979756b51714237776d4675`
- **IV (ASCII, claimed)**: `0000000000000000` (16 × 0x30, not 16 × 0x00)
- **Key location**: `com.heaton.baselib.utils.AESUtils.createCustomKey()`
  ```java
  return new SecretKeySpec(
    "Jy47rzJAgKMfrcc92PamyyukQqB7wmFu".getBytes(), ALGORITHM);
  ```

### What is unsolved

Direct AES-256-CBC of the input bytes with the published key + ASCII-zero IV
does **not** match the device's responses. The Stage-3 probe found
`SMALL_ROTATION` (each input produces 2-3 distinct outputs that cycle), which
implies the plaintext fed to the cipher contains a **session-dependent
component** — a sequence counter, the captured nonce, or similar — that we
have not located yet.

The encryption sits **above** `cn.com.heaton.blelibrary.ble.BleRequestImpl.writeOtaData(addr, bArr)`;
the caller passes already-encrypted bytes. The unsolved piece is therefore
the caller's plaintext-construction logic, somewhere in the
`com.jieli.jl_bt_ota` package or the `CloudEncipher` helper class.

## Probe history

All probe samples sent to ae01 are non-destructive — they do not alter
display state and the device recovers fine.

| Stage | Flow card | Runtime | What it does |
|---|---|---|---|
| 1 | Probe 0x00AE service | ~15 s | 35 fingerprint patterns to discover the trigger byte (0x00) |
| 2 | Deep probe 0x00AE | ~5 s | Nonce uniqueness + auth-shape attempts |
| 3 | Map 0x00AE response space | ~70 s | 256-input sweep — found 235/256 two-byte inputs respond |
| 4 | 0x00AE determinism + avalanche | ~25 s | Confirmed AES-class (50.6 % avalanche), classified as SMALL_ROTATION |
| Key | Test candidate AE key | ~3 s | Tries a user-supplied key against the device with 24 cipher-mode variants |

## Continuing the investigation (notes for future work)

In jadx, the next targets are:

1. **Callers of `BleRequestImpl.writeOtaData()`** — search the call sites
   to find the plaintext-construction code.
2. **`CloudEncipher.encrypt()`** — likely the wrapper that prepends a
   session header before calling `AESUtils.encrypt`.
3. **Jieli SDK internals** — `com.jieli.jl_bt_ota.JL_BLEControllerHelper`
   or similar usually orchestrates the OTA session and owns the counter.

Once the exact plaintext shape is known, paste the key + IV into the
**Test candidate AE key** Flow card and a match should appear. From there,
implementing OTA upload would amount to porting that plaintext +
encryption logic to JS — a few hundred lines.

## Recommendation

For day-to-day use of an iDotMatrix display from Homey, **none of this is
required**. The app already covers everything the display can render via
the unencrypted `0x00FA` channel. Pursue OTA only if you specifically want
to push firmware updates from Homey.
