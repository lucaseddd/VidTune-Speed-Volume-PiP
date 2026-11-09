# VidTune — Video Speed Controller & Volume Booster

**A browser extension for video speed control, volume boost, and Picture-in-Picture.** Adjust playback from 0.1× to 16×, make quiet videos louder, and manage audio and site settings from one compact popup.

<table width="100%" cellspacing="0" cellpadding="8">
  <tr>
    <td width="50%"><strong>Speed control</strong><br>Adjust videos from 0.1× to 16×.</td>
    <td width="50%"><strong>Volume boost</strong><br>Boost or mute audio, switch to mono, or set volume per tab.</td>
  </tr>
  <tr>
    <td width="50%"><strong>Picture-in-Picture</strong><br>Move supported videos into a floating window.</td>
    <td width="50%"><strong>Your setup</strong><br>Choose 2, 5, or 10 controls; save site settings and use A/D shortcuts.</td>
  </tr>
</table>

<div align="center">
  <a href="https://microsoftedge.microsoft.com/addons/detail/vidtune-%E2%80%94-modular-control/iocecgnikgeoainkjndpejfgblgnkpmo">Microsoft Edge Add-ons</a> · <a href="https://addons.mozilla.org/en-US/firefox/addon/vidtune/">Firefox Add-ons</a> · <sub>Chrome · planned</sub> · <sub>Opera · planned</sub> · <a href="PRIVACY.md">Privacy</a>
</div>

## Install VidTune

**Recommended:** Install directly from your browser's extension store for the quickest setup and automatic updates. VidTune is available for Microsoft Edge and Firefox.

For the latest downloadable files, open the release directly:

- [VidTune 0.81 — latest release](https://github.com/lucaseddd/VidTune-Speed-Volume-PiP/releases/tag/v0.81)
- [VidTune 0.8.3](https://github.com/lucaseddd/VidTune-Speed-Volume-PiP/releases/tag/v0.8.3)
- [VidTune 0.8.2](https://github.com/lucaseddd/VidTune-Speed-Volume-PiP/releases/tag/v0.8.2)

The latest release includes a **Firefox XPI installer** and a **source ZIP**. Install the XPI in Firefox; use the source archive to inspect or build the project. For Chromium browsers, install from their extension store when available; the Chromium ZIP is a store/build package, not a signed CRX installer.

## Main features

- **Video speed:** Set playback from 0.1× to 16× with presets, a custom value, or the **A** and **D** keys. Press **Q** to return to 1×.
- **Volume boost:** Raise video volume up to 300%, mute it, or use a separate level for each tab.
- **Player volume:** After enabling boost, the player's volume and mute controls scale the amplified audio. Playback and speed changes preserve the player level.
- **Mono audio:** Blend left and right audio channels and play the same mix through both sides.
- **Picture-in-Picture:** Move a video to a floating window when the browser and player support it.
- **Site preferences:** Remember a speed or volume level for a website.
- **Custom layouts:** Choose 2, 5, or 10 controls. Smart Organize groups related tools for easier scanning.
- **Adaptive controls:** The 320-pixel-wide panel grows and shrinks to fit the selected tools. The installed version sits beside VidTune, keyboard hints share the playback speed heading, and compact volume presets share the volume heading. Tab-only volume follows new videos within that tab.

## Changelog

### 0.81

- Reorganized the popup: the version appears beside the VidTune name, speed shortcuts share the Playback Speed heading, and compact volume presets share the Volume Boost heading.
- Made the popup height adapt to the selected tools so controls remain visible without a scrollbar or clipped content.
- Kept tab-only volume settings active when navigating to another video in the same tab.
- Fixed volume boost so native player volume and mute controls continue working without delayed jumps or loss of amplification.
- Improved Windows packaging so Firefox XPI files are created as valid ZIP archives.
- Added regression coverage for player volume behavior, tab-scoped settings, and compact popup layouts.
- Removed the Pin control while its always-on-top behavior is deferred.

## Preview

<table width="100%" cellspacing="0" cellpadding="2">
  <tr>
    <td width="50%" align="center">
      <a href="presentation/screenshots/default-smart-organize.png"><img src="presentation/screenshots/default-smart-organize.png" alt="VidTune popup with five controls and Smart Organize enabled" width="250" height="403"></a><br>
      <sub><b>Everyday controls</b><br>5 tools with Smart Organize</sub>
    </td>
    <td width="50%" align="center">
      <a href="presentation/screenshots/layout-10-tools.png"><img src="presentation/screenshots/layout-10-tools.png" alt="VidTune popup with ten customizable controls" width="250" height="403"></a><br>
      <sub><b>Full control</b><br>10 tools in one compact layout</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center">
      <a href="presentation/screenshots/settings-speed-shortcuts.png"><img src="presentation/screenshots/settings-speed-shortcuts.png" alt="VidTune speed and keyboard shortcut settings" width="390"></a><br>
      <sub><b>Speed and shortcuts</b><br>Set speed steps, presets, and keys</sub>
    </td>
    <td width="50%" align="center">
      <a href="presentation/screenshots/settings-site-controls.png"><img src="presentation/screenshots/settings-site-controls.png" alt="VidTune website-specific speed and volume settings" width="390"></a><br>
      <sub><b>Site controls</b><br>Save speed and volume by website</sub>
    </td>
  </tr>
</table>

More screenshots: [speed controls](presentation/01-playback-speed.png) · [volume boost](presentation/02-volume-boost.png) · [Smart Organize](presentation/03-smart-organize.png)

## Compatibility

VidTune is compatible with Microsoft Edge, Google Chrome, Opera, Brave, and Vivaldi. Firefox is supported separately. Some protected videos, restricted browser pages, or players that block audio processing may limit speed or volume controls.

## Build from source

Requires Node.js 20 or later.

~~~sh
npm ci
npm run build
npm run package
~~~

The package command creates the Firefox XPI, the Chromium store/build ZIP, and a source ZIP in the release folder.

## Privacy

Settings stay in your browser. VidTune does not use analytics. See the [privacy policy](PRIVACY.md) for details about permissions and audio processing.
