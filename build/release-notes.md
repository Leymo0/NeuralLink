**NeuralLink 0.6.4** — Cyberpunk patch 2.5

- **Install / Update** now finds **Cyber Engine Tweaks 1.38.0** (CET renamed its download file with this release, so older NeuralLink versions silently kept the old CET) and **redscript 0.5.32** — both needed for patch 2.5.
- If NeuralLink can't get the latest CET/redscript, it now says so clearly instead of quietly installing the built-in copy.
- The built-in copies (used when offline) are now CET 1.38.0 and redscript 0.5.32.

### After updating
Host → **Install / Update** with Cyberpunk closed. The green line should say **CET 1.38.0 · redscript 0.5.32**.
If redscript says "Failed to load the original script cache": delete `r6\cache\final.redscripts.bk`, verify game files in Steam, then Install / Update again.

Bundled third-party mods: [Cyber Engine Tweaks](https://github.com/maximegmd/CyberEngineTweaks) and [redscript](https://github.com/jac3km4/redscript) (MIT).
