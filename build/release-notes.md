**NeuralLink 0.6.5** — smoother, steadier stream

- **Stream quality** setting on the Host screen: **1080p 60** (default), **1080p 30**, or **720p 60**. The picture is capped at that size instead of sending the host's full screen resolution (1440p / ultrawide / 4K), which is much lighter to compress.
- **H.264 video** — usually compressed by the graphics card on Windows, leaving the CPU for Cyberpunk (before: VP8 on the CPU).
- **Starts sharp**: the connection now starts at a sensible speed instead of showing a blurry picture for the first 10–20 seconds, and doesn't collapse to potato quality on a small hiccup.
- **Smooth playback** for Peri: a tiny ~150 ms buffer that hides a shaky connection (Join screen; untick for lowest delay).
- **Live stats** on both sides: resolution · fps · codec · speed · ping — and on the host, whether the stream is *held back by this PC* or *by the internet*, so you know which setting to change.

### Update
Both of you: **Install / Update** (Host) or **Check for updates** (home screen).

Bundled third-party mods: [Cyber Engine Tweaks](https://github.com/maximegmd/CyberEngineTweaks) and [redscript](https://github.com/jac3km4/redscript) (MIT).
