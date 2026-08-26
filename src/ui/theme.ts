export type ThemeMode = "dark" | "light";
export type ThemeName = "dark" | "light" | "dark-daltonized" | "light-daltonized" | "nova";

export interface Theme {
  readonly name: ThemeName;
  readonly mode: ThemeMode;
  readonly colorblindSafe: boolean;
  readonly accent: string;
  readonly accentSoft: string;
  readonly secondary: string;
  readonly secondarySoft: string;
  readonly text: string;
  readonly muted: string;
  readonly faint: string;
  readonly surface: string;
  readonly surfaceRaised: string;
  readonly border: string;
  readonly success: string;
  readonly warning: string;
  readonly danger: string;
  readonly code: string;
}

export interface ThemeCatalogEntry {
  readonly name: ThemeName;
  readonly label: string;
  readonly description: string;
  readonly theme: Theme;
}

const themes: Record<ThemeName, Theme> = {
  dark: {
    name: "dark",
    mode: "dark",
    colorblindSafe: false,
    accent: "#2DD4BF",
    accentSoft: "#5EEAD4",
    secondary: "#A78BFA",
    secondarySoft: "#C4B5FD",
    text: "#F4F4F5",
    muted: "#A1A1AA",
    faint: "#71717A",
    surface: "#27272A",
    surfaceRaised: "#3F3F46",
    border: "#52525B",
    success: "#4ADE80",
    warning: "#FBBF24",
    danger: "#FB7185",
    code: "#67E8F9",
  },
  light: {
    name: "light",
    mode: "light",
    colorblindSafe: false,
    accent: "#0F766E",
    accentSoft: "#115E59",
    secondary: "#6D28D9",
    secondarySoft: "#5B21B6",
    text: "#18181B",
    muted: "#52525B",
    faint: "#71717A",
    surface: "#E4E4E7",
    surfaceRaised: "#D4D4D8",
    border: "#A1A1AA",
    success: "#15803D",
    warning: "#A16207",
    danger: "#BE123C",
    code: "#0E7490",
  },
  // Colorblind-friendly ("daltonized") variants. Hues are drawn from the
  // Okabe–Ito color-universal-design palette (Okabe & Ito, 2008), which is
  // engineered to stay distinguishable under protanopia, deuteranopia, and
  // tritanopia. success/warning/danger deliberately avoid the classic
  // red-vs-green pairing (blue-green vs vermillion/amber instead); the
  // accent/secondary hues follow the same sky-blue / reddish-purple family
  // as the palette's other reference colors. Only lightness/saturation is
  // adjusted between the dark and light variant, for background contrast.
  "dark-daltonized": {
    name: "dark-daltonized",
    mode: "dark",
    colorblindSafe: true,
    accent: "#56B4E9",
    accentSoft: "#8ED0F2",
    secondary: "#CC79A7",
    secondarySoft: "#E0A8C8",
    text: "#F4F4F5",
    muted: "#A1A1AA",
    faint: "#71717A",
    surface: "#27272A",
    surfaceRaised: "#3F3F46",
    border: "#52525B",
    success: "#3FDBB0",
    warning: "#F5DC4A",
    danger: "#FF8F4D",
    code: "#8FD6EE",
  },
  "light-daltonized": {
    name: "light-daltonized",
    mode: "light",
    colorblindSafe: true,
    accent: "#0072B2",
    accentSoft: "#005A8C",
    secondary: "#A3527D",
    secondarySoft: "#8C3F68",
    text: "#18181B",
    muted: "#52525B",
    faint: "#71717A",
    surface: "#E4E4E7",
    surfaceRaised: "#D4D4D8",
    border: "#A1A1AA",
    success: "#007A5E",
    warning: "#A66A00",
    danger: "#B34700",
    code: "#005F8C",
  },
  // Astronomical red/gold palette — AlfaCode's default look on dark terminals. accent (flame-red)
  // and danger (hot rose-red) are deliberately different red hues so an error is never visually
  // confusable with the brand color; secondary (solar yellow) is meant to be used more sparingly
  // than accent so the overall balance reads "red field, yellow glow" rather than a hazard stripe.
  nova: {
    name: "nova",
    mode: "dark",
    colorblindSafe: false,
    accent: "#FF4757",
    accentSoft: "#FF7A85",
    secondary: "#FFC93C",
    secondarySoft: "#FFDD7A",
    text: "#F5F1EA",
    muted: "#9B93A8",
    faint: "#655D74",
    surface: "#14101E",
    surfaceRaised: "#231C33",
    border: "#3D3450",
    success: "#4FE3B0",
    warning: "#FF9F1C",
    danger: "#F0466E",
    code: "#B9A3E3",
  },
};

export const themeNames: readonly ThemeName[] = ["dark", "light", "dark-daltonized", "light-daltonized", "nova"];

const themeLabels: Record<ThemeName, string> = {
  dark: "Dark",
  light: "Light",
  "dark-daltonized": "Dark · Daltonized",
  "light-daltonized": "Light · Daltonized",
  nova: "Nova",
};

const themeDescriptions: Record<ThemeName, string> = {
  dark: "Default dark palette",
  light: "Default light palette",
  "dark-daltonized": "Colorblind-friendly dark palette (Okabe–Ito hues)",
  "light-daltonized": "Colorblind-friendly light palette (Okabe–Ito hues)",
  nova: "Astronomical red/gold palette — AlfaCode's default look",
};

export const themeCatalog: readonly ThemeCatalogEntry[] = themeNames.map((name) => ({
  name,
  label: themeLabels[name],
  description: themeDescriptions[name],
  theme: themes[name],
}));

export function getTheme(name: ThemeName): Theme {
  return themes[name];
}

export function isThemeName(value: string): value is ThemeName {
  return (themeNames as readonly string[]).includes(value);
}

export function resolveThemeName(environment: NodeJS.ProcessEnv = process.env): ThemeName {
  const requested = environment.ALFACODE_THEME?.toLowerCase();
  if (requested !== undefined && isThemeName(requested)) return requested;
  // Dark terminals default to the nova palette; plain "dark" remains fully selectable via
  // /theme or ALFACODE_THEME=dark. Light terminals are unaffected — nova has no light variant.
  return inferThemeMode(environment.COLORFGBG) === "dark" ? "nova" : "light";
}

export function resolveTheme(environment: NodeJS.ProcessEnv = process.env): Theme {
  return themes[resolveThemeName(environment)];
}

export function inferThemeMode(colorFgBg: string | undefined): ThemeMode {
  const background = colorFgBg?.split(";").at(-1);
  if (background === undefined || !/^\d+$/.test(background)) return "dark";
  const ansiColor = Number.parseInt(background, 10);
  return ansiColor === 0 || ansiColor === 8 || (ansiColor >= 232 && ansiColor <= 243) ? "dark" : "light";
}

export function supportsMotion(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.ALFACODE_REDUCED_MOTION !== "1"
    && environment.CI === undefined
    && environment.TERM !== "dumb";
}
