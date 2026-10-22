**NeuralLink 0.6.2** — safer self-updates

- Updating NeuralLink now shows the installer window instead of running hidden. If NeuralLink is still closing, Windows asks to retry instead of failing silently (which could leave NeuralLink unable to open).
- Only one NeuralLink runs at a time; opening it again brings the existing window forward.
- Update problems are written to `%APPDATA%\NeuralLink\update.log`.

### If NeuralLink won't open after an update
Close any NeuralLink in Task Manager, download **NeuralLink-Setup-0.6.2.exe** below and run it. Your settings are kept.

Bundled third-party mods: [Cyber Engine Tweaks](https://github.com/maximegmd/CyberEngineTweaks) and [redscript](https://github.com/jac3km4/redscript) (MIT).
