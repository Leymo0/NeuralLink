**NeuralLink 0.6.8**: fixes a game crash on the main menu

- **Fixed:** the game could crash ("Cyberpunk 2077 has flatlined") if Peri used focus (Space) or Override (F) while the host was still on the main menu. On the main menu the game hands mods a half-built V, and the mod tried to slow down time on it.
- The mod now waits until a save is actually loaded before touching the game. On the main menu, loading screens and the pause menu, chat and pings still work; hacks, focus and Override say *"Not in the game right now"*.
- Pausing (Esc) during focus or Override now switches slow-motion off cleanly.

**Update:** close the game, then click **Install / Update** on the Host screen (it updates the mod in the game folder too).

Bundled third-party mods: [Cyber Engine Tweaks](https://github.com/maximegmd/CyberEngineTweaks) and [redscript](https://github.com/jac3km4/redscript) (MIT).
