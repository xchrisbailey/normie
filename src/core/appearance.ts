// How the app looks besides its colors: the text's face and size, how tall rows are, how wide the column is, and
// whether it moves. Kept in settings.json next to the theme. Pure.
export const FONTS = ['sans', 'serif', 'mono'] as const;
export type FontChoice = (typeof FONTS)[number];
/** Text sizes in px; 13 is the size the app is drawn at. */
export const TEXT_SIZES = [12, 13, 14, 15, 16] as const;
export type TextSize = (typeof TEXT_SIZES)[number];
export const DENSITIES = ['compact', 'comfortable', 'roomy'] as const;
export type Density = (typeof DENSITIES)[number];
/** A row's height in px at each density. */
export const ROW_HEIGHT: Record<Density, number> = { compact: 36, comfortable: 44, roomy: 52 };
export const WIDTHS = ['narrow', 'standard', 'wide'] as const;
export type ColumnWidth = (typeof WIDTHS)[number];
/** The column's width in px. */
export const COLUMN_WIDTH: Record<ColumnWidth, number> = { narrow: 600, standard: 720, wide: 900 };

export interface Appearance {
  font: FontChoice;
  size: TextSize;
  density: Density;
  width: ColumnWidth;
  /** Animations off even when the system allows them. */
  reduceMotion: boolean;
}

export const DEFAULT_APPEARANCE: Appearance = { font: 'sans', size: 13, density: 'comfortable', width: 'standard', reduceMotion: false };

const oneOf = <T extends string | number>(options: ReadonlyArray<T>, v: unknown, fallback: T): T => options.find((o) => o === v) ?? fallback;

/** Appearance from settings.json (or a renderer's request): each part that's missing or unknown is the default. */
export function appearanceFrom(v: unknown): Appearance {
  const d = DEFAULT_APPEARANCE;
  if (typeof v !== 'object' || v === null) {
    return d;
  }
  return {
    font: oneOf(FONTS, 'font' in v ? v.font : undefined, d.font),
    size: oneOf(TEXT_SIZES, 'size' in v ? v.size : undefined, d.size),
    density: oneOf(DENSITIES, 'density' in v ? v.density : undefined, d.density),
    width: oneOf(WIDTHS, 'width' in v ? v.width : undefined, d.width),
    reduceMotion: 'reduceMotion' in v && typeof v.reduceMotion === 'boolean' ? v.reduceMotion : d.reduceMotion,
  };
}
