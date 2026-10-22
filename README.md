# NeuralLink — one V, two brains

Co-op for Cyberpunk 2077 where he plays and **Peri lives in his head**.

- **Host** (plays the game): opens a room and gets a 6-letter code.
- **Peri** (joins): sees and hears his game live, cutscenes included. Uploads **his real
  quickhacks** to anyone on his screen with mouse + keyboard, pings spots, slows time while aiming (focus),
  and types messages that pop up top-right in his HUD next to Peri's icon.

```
HOST PC                                            PERI'S PC
Cyberpunk + CET mod + PeriLink.reds                NeuralLink → JOIN
      ▲ inbox.txt / state.json                           │
NeuralLink → HOST ── screen + sound ────────────────────▶│
      ▲                       ── his deck + RAM ────────▶│
      └──────────── hacks / pings / messages ◀───────────┘
           (direct peer-to-peer; the room code is how you find each other)
```

## How hacking works

Peri uses **his** cyberdeck through the game's own quickhack code:

- Peri's hotbar shows the quickhacks **he has equipped**, with their real RAM cost.
- Uploads use **his RAM**, upload times, ICE, cooldowns, crafted tiers and perks —
  exactly like he'd hacked himself. When he upgrades, Peri's hacks get better.
- Hacks he can't afford right now are dimmed. If one fails (not enough RAM, target
  immune, upload already running…) Peri gets the game's reason.
- **Only Peri can hack** is on by default: if he tries to upload a quickhack himself,
  the game says "Only Peri can hack." He can untick it on the Host screen.
- He needs a **cyberdeck** equipped (not a Sandevistan — they share a slot).
  

---

## Ultimate: OVERRIDE (F)

For **6 seconds** time slows to 10% and a **radar map** replaces Peri's view: V in the middle (facing up)
and every hackable thing within 40 m around him — people, civilians, cameras, turrets — even behind him
or behind walls.

- Hover a name → **1–8** uploads that quickhack, **left-click** the selected one, **right-click** opens
  the full hack menu (devices always open their menu).
- Hacks cost **no RAM** while it lasts.
- Costs V **10% of his health**, but never takes him below 10% — it can't kill him.
- **60 s cooldown** (shown on Peri's bar and in his HUD).
- Plays Peri's voice line on his PC when it starts (volume + test button on the Host screen).

Tuning: `ultDuration`, `ultCooldown`, `ultRadius`, `ultHurtPercent`, `ultHealthFloor` at the top of
`mod/CoopOperator/init.lua`.

## Experimental: Peri's own cyberdeck

Tick **EXPERIMENTAL — Peri brings her own cyberdeck** on the Host screen. Then, whenever he is
**not** wearing a cyberdeck (e.g. he runs a Sandevistan), Peri still gets hacks:

- **People:** a starter deck of quickhacks (Ping, Reboot Optics, Overheat, Short Circuit,
  Cripple Movement, Weapon Glitch, Contagion, Memory Wipe, Synapse Burnout — whichever exist in
  his game version).
- **Devices:** every quickhack the device offers (cameras, turrets, doors…).
- **Peri's own RAM** (yellow bar, "PERI RAM"): max = 4 + 0.3 × his level, refills 1 RAM every
  2 seconds. His RAM is never touched.
- When he equips a cyberdeck again, Peri automatically switches back to **his** real deck.

Tuning lives at the top of `mod/CoopOperator/init.lua` (`vramBase`, `vramPerLevel`, `vramRegen`).
Some hacks may behave a bit differently without a real deck behind them — that's why it's experimental.

## 1. His PC — one-time setup

1. **Back up his save** (just in case): `Win + R` → `%USERPROFILE%\Saved Games\CD Projekt Red\Cyberpunk 2077`
   → copy that folder to the Desktop.
2. **Update Cyberpunk** to the latest version.
3. Download **`NeuralLink-Setup-x.y.z.exe`** from the [latest release](https://github.com/Leymo0/NeuralLink/releases/latest)
   and run it → Next → Install. A NeuralLink icon appears on the desktop. **This is the only time you run the setup.**
   (Windows may say "Windows protected your PC" because the installer isn't signed:
   click **More info → Run anyway**.)
4. Open **NeuralLink** → **HOST**. If the game folder isn't found, click **Choose…** and pick the
   folder that contains `bin` (Steam → right-click Cyberpunk → Manage → Browse local files).
5. Close Cyberpunk if it's open, then click **Install / Update**. This installs
   Cyber Engine Tweaks, redscript and the NeuralLink mod into the game.
6. In Cyberpunk: Settings → Video → Windowed Mode → **Borderless**. Turn off the Discord, Steam and
   Xbox Game Bar *overlays* (voice chat still works).
7. Start the game. CET asks for a menu key the first time — click **Unbound**, press e.g. `F1`.
   No red redscript popup = everything loaded.
8. He needs a **cyberdeck** equipped for Peri to hack.

If the game says something about missing Visual C++: install "Microsoft Visual C++ Redistributable
(x64)" from Microsoft and try again.

## 2. Peri's PC — one-time setup

Run the same setup once → open NeuralLink → **JOIN** → set name and icon (saved).

## Updating (both of you)

Never reinstall — just click:

- **Him:** NeuralLink → **HOST** → **Install / Update** (with Cyberpunk closed). It updates NeuralLink
  itself, then grabs the latest **Cyber Engine Tweaks** and **redscript** from their GitHub releases
  and puts everything into the game. When it's done it says **✓ Updated**.
  If NeuralLink itself had a new version, it closes, updates, reopens and finishes by itself.
- **Peri:** home screen → **Check for updates**.
- No internet / GitHub down? It uses the CET and redscript copies built into NeuralLink.


## 3. Every time you play

1. **He** starts Cyberpunk and loads his save.
2. **He** opens NeuralLink → **HOST** → picks his screen →
   **Start room** → sends Peri the code.
3. **Peri** opens NeuralLink → **JOIN** → code → **Jack in** → **F11** for fullscreen.

### Peri's controls (rebind them on the Join screen)

| Key | Does |
|---|---|
| **1 – 8** | Upload his quickhack from that slot to the enemy under your mouse |
| *(just pointing)* | The hotbar shows each hack's **real cost on the target under your mouse** (green), "–" if it doesn't work there |
| **Left-click** | Upload the selected quickhack where you click (click a slot in the bar to select it). Clicking a **device** (camera, turret, door…) opens its hack menu |
| **Right-click** | Scan: open the game's hack menu for whatever is under the mouse (NPC or device). Pick with **1–9** or click; **Esc** closes |
| **Hold Space** | Focus: time slows to 10% and **every target on his screen gets a name tag**. Hover a name → 1–8 / left-click to hack it, right-click for its menu. Drains a 6-second meter that refills when you let go |
| **Q** / middle-click | Ping: "LOOK" marker on his screen |
| **F** | **ULTIMATE: OVERRIDE** — see below |
| **Enter** | Type a message → appears top-right in his HUD |
| **Tab** (while typing) | Switch icon for this message (or click an icon in the chat box) |
| **F11** | Fullscreen |

How slow focus is: `focusDilation` at the top of `mod/CoopOperator/init.lua` (0.1 = 10% speed).

You can target things **behind glass, behind cover, or pinged through walls** — anything
inside his view. (Turn off with `throughWalls = false` at the top of `mod/CoopOperator/init.lua`.)

If your NeuralLink closes by accident, just open it and join again with the same code —
the room lets you back in and replaces your old connection.

## Testing alone

You can run both sides on one PC (you have the game too): open NeuralLink twice,
HOST in one, JOIN in the other with the code.

## If something doesn't work

- **"No room with that code"** → typo, or the room was closed.
- **"Could not connect" after 20s** → your internet connections can't reach each other directly.
  Needs a relay (TURN) server in `%APPDATA%\NeuralLink\settings.json` → `turnServers` (both PCs).
- **Black screen for Peri** → Host picks the whole screen instead of the game window.
- **Peri hears an echo** → host wears headphones, or unticks "Share game sound".
- **"Hacking offline — PeriLink not installed"** → redscript missing, or it couldn't compile
  `PeriLink.reds` (redscript shows an error popup when the game starts — send a screenshot).
- **"No quickhacks equipped"** → he needs a cyberdeck with quickhacks slotted.
- **"No target there" every time** → the screen-matching part needs a tweak (marked `VERIFY` in
  `mod/CoopOperator/init.lua`).
- **Name shows but no icon in game** → this CET version lacks the drawing functions the icon uses;
  the window falls back to the name.
- **Arabic messages** need an Arabic-capable font set in CET's settings.

## Files

- `mod/CoopOperator/` — the CET mod (window, messages, focus, targeting)
- `mod/r6/scripts/PeriLink/PeriLink.reds` — real quickhacks + the "only Peri can hack" lock
- `assets/icons/` — Peri's icons (the in-game versions are in `mod/CoopOperator/icons.lua`)

## Releasing a new version (for Peri)

1. Bump `"version"` in `package.json` (e.g. 0.4.1) and update `build/release-notes.md`.
2. Commit, then push a tag with the same number: `git tag v0.4.1 && git push origin main v0.4.1`.
3. GitHub Actions builds the installer and publishes the release. Everyone gets it with **Install / Update**.
