#!/usr/bin/env node
/**
 * Builds assets/install-spinner.gif, the image Squirrel shows while it
 * installs.
 *
 * Without a `loadingGif` electron-winstaller ships its own placeholder: a
 * 268x167 mint-green rectangle with a couple of stray marks in one corner. It
 * is the first thing anyone sees of Sertum, and it says nothing.
 *
 * The mark already contains a spinner. Its ring is six segments, five light
 * and one amber, so stepping the amber one around the ring animates it with
 * no new artwork and nothing that can drift from the icon.
 *
 * Dimensions match the placeholder exactly, because Squirrel sizes its window
 * to this image and there is no reason to change that geometry.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const dest = path.join(root, 'assets', 'install-spinner.gif');

const WIDTH = 268;
const HEIGHT = 167;
const MARK = 108;
const LIGHT = '#f4f6fa';
const AMBER = '#f2c44f';
const BACKDROP = '#12161a';

/** The ring, clockwise from the upper right. Coordinates are the icon's. */
const SEGMENTS = [
  'M 580 250 L 720 331',
  'M 772 432 L 772 592',
  'M 720 693 L 580 774',
  'M 444 774 L 304 693',
  'M 252 592 L 252 432',
  'M 304 331 L 444 250',
];

/** One frame, with `lit` naming the segment carrying the accent. */
function frameSvg(lit) {
  const paths = SEGMENTS.map(
    (d, i) =>
      `<path d="${d}" stroke="${i === lit ? AMBER : LIGHT}" ` +
      `${i === lit ? '' : 'opacity="0.55" '}/>`,
  ).join('\n    ');
  // The viewBox crops to the ring: the rounded tile belongs on an app icon,
  // not behind a progress animation.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="228 226 568 572">
  <g fill="none" stroke-width="54" stroke-linecap="square">
    ${paths}
  </g>
</svg>`;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sertum-spinner-'));
const frames = SEGMENTS.map((_, i) => {
  const svg = path.join(tmp, `f${i}.svg`);
  const png = path.join(tmp, `f${i}.png`);
  fs.writeFileSync(svg, frameSvg(i));
  execFileSync('magick', [
    '-background', 'none',
    svg,
    '-resize', `${MARK}x${MARK}`,
    png,
  ], { stdio: 'ignore' });

  const framed = path.join(tmp, `c${i}.png`);
  execFileSync('magick', [
    '-size', `${WIDTH}x${HEIGHT}`,
    `xc:${BACKDROP}`,
    png,
    '-gravity', 'center',
    '-composite',
    '-depth', '8',
    `PNG32:${framed}`,
  ], { stdio: 'ignore' });
  return framed;
});

execFileSync('magick', [
  '-delay', '11',
  '-loop', '0',
  ...frames,
  '-layers', 'optimize',
  dest,
], { stdio: 'ignore' });

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`wrote ${path.relative(root, dest)} (${WIDTH}x${HEIGHT}, ${frames.length} frames)`);
