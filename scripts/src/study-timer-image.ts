import { readFile } from "node:fs/promises";
import opentype, { type Font } from "opentype.js";
import sharp from "sharp";
import {
  getStudyTimerTheme,
  type StudyTimerThemeKey,
} from "./study-timer-themes.js";

const imageWidth = 1_200;
const imageHeight = 560;
const lobsterFontUrl = new URL("../assets/fonts/Lobster-Regular.ttf", import.meta.url);
const edgeZones = [
  { minX: 34, maxX: 180, minY: 45, maxY: 510 },
  { minX: 1_020, maxX: 1_166, minY: 45, maxY: 510 },
  { minX: 220, maxX: 430, minY: 28, maxY: 88 },
  { minX: 770, maxX: 980, minY: 28, maxY: 88 },
  { minX: 235, maxX: 965, minY: 488, maxY: 526 },
] as const;

let fontPromise: Promise<Font> | null = null;

function loadLobsterFont() {
  if (!fontPromise) {
    fontPromise = readFile(lobsterFontUrl).then((buffer) => {
      const fontBytes = buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      );
      return opentype.parse(fontBytes);
    });
  }
  return fontPromise;
}

function seededRandom(seedText: string) {
  let state = 2_166_136_261;
  for (const character of seedText) {
    state ^= character.codePointAt(0) ?? 0;
    state = Math.imul(state, 16_777_619);
  }
  state >>>= 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function starPath(points = 5) {
  const vertices = Array.from({ length: points * 2 }, (_, index) => {
    const radius = index % 2 === 0 ? 1 : 0.43;
    const angle = -Math.PI / 2 + (index * Math.PI) / points;
    return `${(Math.cos(angle) * radius).toFixed(3)},${(
      Math.sin(angle) * radius
    ).toFixed(3)}`;
  });
  return `M${vertices.join(" L")} Z`;
}

function renderMotif(
  motif: string,
  primary: string,
  highlight: string,
  background: string,
) {
  const thin = `stroke="${primary}" stroke-width=".12" stroke-linecap="round" stroke-linejoin="round" fill="none"`;
  switch (motif) {
    case "stars":
      return `<path d="${starPath()}" fill="${primary}"/><circle cx=".72" cy="-.56" r=".12" fill="${highlight}"/>`;
    case "crescent":
      return `<circle r=".82" fill="${primary}"/><circle cx=".36" cy="-.2" r=".76" fill="${background}"/><circle cx="-.56" cy=".76" r=".11" fill="${highlight}"/>`;
    case "leaves":
      return `<path d="M-.92 .42 C-.8-.4-.1-.9.42-.82 C.48-.14-.04.65-.92.42Z" fill="${primary}"/><path d="M-.78 .35 Q-.13-.05.34-.7" ${thin}/><path d="M.02 .86 C-.02.22.53-.34 1-.28 C.98.24.59.85.02.86Z" fill="${highlight}"/><path d="M.11 .76 Q.52.19.91-.2" ${thin}/>`;
    case "sun-rays":
      return `<g ${thin}>${Array.from({ length: 8 }, (_, index) => `<path d="M0-.7V-1" transform="rotate(${index * 45})"/>`).join("")}</g><circle r=".58" fill="${highlight}" stroke="${primary}" stroke-width=".08"/>`;
    case "waves":
      return `<path d="M-1-.22 Q-.55-.76 0-.22 T1-.22" ${thin}/><path d="M-1 .23 Q-.55-.31 0 .23 T1 .23" stroke="${highlight}" stroke-width=".16" stroke-linecap="round" fill="none"/><path d="M-1 .67 Q-.55 .13 0 .67 T1 .67" ${thin}/>`;
    case "flowers":
      return `<g fill="${primary}">${Array.from({ length: 5 }, (_, index) => `<ellipse cx="0" cy="-.48" rx=".28" ry=".5" transform="rotate(${index * 72})"/>`).join("")}</g><circle r=".25" fill="${highlight}"/>`;
    case "butterflies":
      return `<path d="M0 .04 C-.2-.15-.98-.9-.98-.12 C-.98.35-.46.54-.08.34 C-.62.82-.24 1 0 .48 C.24 1 .62.82.08.34 C.46.54.98.35.98-.12 C.98-.9.2-.15 0 .04Z" fill="${primary}"/><path d="M0 .05V.72" ${thin}/><circle cx="-.62" cy="-.13" r=".11" fill="${highlight}"/><circle cx=".62" cy="-.13" r=".11" fill="${highlight}"/>`;
    case "code":
      return `<path d="M-.22-.72 L-.78 0 -.22 .72 M.22-.72 L.78 0 .22 .72 M.16-.92 L-.16 .92" ${thin}/><circle cx="-.78" cy="0" r=".1" fill="${highlight}"/><circle cx=".78" cy="0" r=".1" fill="${highlight}"/>`;
    case "lightning":
      return `<path d="M.12-1 L-.62 .08 -.1 .08 -.34 1 .66-.28 .12-.28Z" fill="${primary}"/><path d="M-.72-.74h.28 M.58.62h.26" ${thin}/>`;
    case "diamonds":
      return `<path d="M0-1 L.72 0 0 1 -.72 0Z" fill="${primary}"/><path d="M0-.68 L.45 0 0 .68 -.45 0Z" fill="${highlight}"/><path d="M-.72 0H.72 M0-1V1" ${thin}/>`;
    case "ice-crystals":
      return `<g ${thin}><path d="M0-1V1 M-.87-.5L.87.5 M-.87.5L.87-.5"/><path d="M0-.58L-.19-.38 M0-.58L.19-.38 M0 .58L-.19 .38 M0 .58L.19 .38 M-.5-.29L-.25-.3 M-.5-.29L-.43-.04 M.5 .29L.25 .3 M.5 .29L.43 .04 M-.5 .29L-.25 .3 M-.5 .29L-.43 .04 M.5-.29L.25-.3 M.5-.29L.43-.04"/></g><circle r=".12" fill="${highlight}"/>`;
    case "flames":
      return `<path d="M0 1 C-.82.62-.79-.04-.37-.42 C-.36-.03-.13.03-.1-.52 C-.07-.9.17-1 .23-1 C.21-.45.98-.11.83.49 C.76.78.42 1 0 1Z" fill="${primary}"/><path d="M.03 .7 C-.3 .45-.24.13-.05-.08 C.03.12.25.18.28.42 C.3.55.18.68.03.7Z" fill="${highlight}"/>`;
    case "matrix":
      return `<g fill="${primary}"><rect x="-.78" y="-.82" width=".16" height=".28" rx=".06"/><rect x="-.42" y="-.42" width=".16" height=".38" rx=".06"/><rect x="-.06" y="-.9" width=".16" height=".46" rx=".06"/><rect x=".3" y="-.55" width=".16" height=".32" rx=".06"/><rect x=".65" y="-.8" width=".16" height=".6" rx=".06"/><rect x="-.62" y=".13" width=".16" height=".54" rx=".06"/><rect x="-.22" y=".18" width=".16" height=".66" rx=".06"/><rect x=".2" y=".1" width=".16" height=".42" rx=".06"/><rect x=".61" y=".17" width=".16" height=".68" rx=".06"/></g><circle cx="-.37" cy=".78" r=".1" fill="${highlight}"/>`;
    case "desert":
      return `<circle cx=".47" cy="-.37" r=".38" fill="${highlight}"/><path d="M-1 .38 Q-.42-.03.06 .34 T1 .2 V1H-1Z" fill="${primary}"/><path d="M-1 .64 Q-.36 .28.18 .65 T1 .54" stroke="${highlight}" stroke-width=".1" fill="none"/>`;
    case "racing-squares":
      return `<g>${Array.from({ length: 3 }, (_, row) => Array.from({ length: 3 }, (_, col) => (row + col) % 2 === 0 ? `<rect x="${-0.72 + col * 0.48}" y="${-0.72 + row * 0.48}" width=".48" height=".48" fill="${primary}"/>` : `<rect x="${-0.72 + col * 0.48}" y="${-0.72 + row * 0.48}" width=".48" height=".48" fill="${highlight}"/>`).join("")).join("")}</g>`;
    case "tools":
      return `<path d="M-.8-.7 A.43.43 0 0 0-.18-.15 L.48.52 A.2.2 0 1 0 .76.24 L.09-.43 A.43.43 0 0 0-.47-.93 L-.22-.67 -.51-.38Z" fill="${primary}"/><path d="M.34-.82 L.89-.27 .6.02 .05-.53Z" fill="${highlight}"/><circle cx=".74" cy="-.39" r=".12" fill="${primary}"/>`;
    case "targets":
      return `<circle r=".88" ${thin}/><circle r=".57" stroke="${highlight}" stroke-width=".13" fill="none"/><circle r=".23" fill="${primary}"/><path d="M0-1V-.7 M1 0H.7 M0 1V.7 M-1 0H-.7" ${thin}/>`;
    case "fireworks":
      return `<g ${thin}>${Array.from({ length: 10 }, (_, index) => `<path d="M0-.42V-1" transform="rotate(${index * 36})"/>`).join("")}</g><circle r=".18" fill="${highlight}"/><circle cx=".74" cy=".6" r=".12" fill="${primary}"/>`;
    case "carnival":
      return `<path d="M-.78-.65 L-.45-.9 -.22-.5 -.52-.23Z" fill="${primary}"/><rect x=".23" y="-.83" width=".32" height=".72" rx=".1" transform="rotate(28 .39-.47)" fill="${highlight}"/><circle cx="-.53" cy=".58" r=".19" fill="${highlight}"/><path d="M.14 .28 L.72 .48 .36 .94Z" fill="${primary}"/>`;
    default:
      return `<path d="${starPath()}" fill="${primary}"/>`;
  }
}

function renderEdgeDecorations(
  theme: NonNullable<ReturnType<typeof getStudyTimerTheme>>,
) {
  const random = seededRandom(theme.key);
  return Array.from({ length: 25 }, (_, index) => {
    const zone = edgeZones[index % edgeZones.length]!;
    const x = zone.minX + random() * (zone.maxX - zone.minX);
    const y = zone.minY + random() * (zone.maxY - zone.minY);
    const size = 10 + random() * 11;
    const rotation = Math.round(random() * 360);
    const opacity = (0.48 + random() * 0.28).toFixed(2);
    return `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${rotation}) scale(${size.toFixed(1)})" opacity="${opacity}">${renderMotif(theme.motif, theme.primary, theme.highlight, theme.background)}</g>`;
  }).join("");
}

function centerTextPath(font: Font, text: string, fontSize: number, baseline: number) {
  const width = font.getAdvanceWidth(text, fontSize);
  const x = (imageWidth - width) / 2;
  return font.getPath(text, x, baseline, fontSize).toPathData(2);
}

function renderBookIcon(color: string, detailColor: string) {
  return `<g transform="translate(1108 56)" fill="none" stroke="${color}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="M0 4C-14-4-29-6-43-1V35C-28 30-13 33 0 42C13 33 28 30 43 35V-1C29-6 14-4 0 4Z" fill="${detailColor}" fill-opacity=".26"/><path d="M0 4V42M-33 7C-24 5-15 8-8 12M33 7C24 5 15 8 8 12"/></g>`;
}

export async function renderStudyTimerImage(
  themeKey: StudyTimerThemeKey,
  timeRemaining: string,
) {
  const theme = getStudyTimerTheme(themeKey);
  if (!theme) throw new Error(`Unknown study timer theme: ${themeKey}`);
  if (!/^\d{1,4}:\d{2}$/.test(timeRemaining)) {
    throw new Error("The study timer image received an invalid time value.");
  }

  const font = await loadLobsterFont();
  const titlePath = centerTextPath(font, "TIMER", 50, 105);
  const timeFontSize = timeRemaining.length >= 7 ? 132 : 150;
  const timePath = centerTextPath(font, timeRemaining, timeFontSize, 350);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${imageWidth}" height="${imageHeight}" viewBox="0 0 ${imageWidth} ${imageHeight}"><defs><clipPath id="rounded"><rect width="${imageWidth}" height="${imageHeight}" rx="38"/></clipPath></defs><g clip-path="url(#rounded)"><rect width="${imageWidth}" height="${imageHeight}" fill="${theme.background}"/><ellipse cx="84" cy="278" rx="125" ry="230" fill="${theme.highlight}" opacity=".16"/><ellipse cx="1116" cy="275" rx="112" ry="220" fill="${theme.highlight}" opacity=".18"/>${renderEdgeDecorations(theme)}${renderBookIcon(theme.primary, theme.highlight)}<path d="${titlePath}" transform="translate(0 2)" fill="${theme.highlight}" opacity=".55"/><path d="${titlePath}" fill="${theme.text}"/><path d="${timePath}" transform="translate(0 7)" fill="${theme.highlight}" opacity=".72"/><path d="${timePath}" fill="${theme.text}"/></g></svg>`;
  return sharp(Buffer.from(svg))
    .png({ compressionLevel: 9 })
    .toBuffer();
}