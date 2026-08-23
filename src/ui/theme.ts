export type ThemeMode = "dark" | "light";

export interface Theme {
  readonly mode: ThemeMode;
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

const themes: Record<ThemeMode, Theme> = {
  dark: {
    mode: "dark",
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
    mode: "light",
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
};

export function resolveTheme(environment: NodeJS.ProcessEnv = process.env): Theme {
  const requested = environment.ALFACODE_THEME?.toLowerCase();
  if (requested === "dark" || requested === "light") return themes[requested];
  return themes[inferThemeMode(environment.COLORFGBG)];
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
