import type { TextStyle, ViewStyle } from "react-native";

export const colors = {
  canvas: "#F5F7F8",
  surface: "#FFFFFF",
  surfaceMuted: "#EEF2F1",
  ink: "#16201D",
  muted: "#66736E",
  faint: "#8B9692",
  line: "#D7DEDB",
  teal: "#087F70",
  tealStrong: "#06675C",
  tealSoft: "#DDF2ED",
  coral: "#C95343",
  coralSoft: "#F8E6E2",
  amber: "#A96C08",
  amberSoft: "#FFF0CF",
  blue: "#356FB6",
  blueSoft: "#E6EFFA",
  inverse: "#FFFFFF",
  scrim: "rgba(22, 32, 29, 0.42)"
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32
} as const;

export const radii = {
  sm: 4,
  md: 8,
  pill: 999
} as const;

export const typography = {
  title: { color: colors.ink, fontSize: 22, fontWeight: "700" } satisfies TextStyle,
  heading: { color: colors.ink, fontSize: 17, fontWeight: "700" } satisfies TextStyle,
  body: { color: colors.ink, fontSize: 15, lineHeight: 21 } satisfies TextStyle,
  label: { color: colors.ink, fontSize: 13, fontWeight: "600" } satisfies TextStyle,
  caption: { color: colors.muted, fontSize: 12, lineHeight: 17 } satisfies TextStyle
} as const;

export const shadow = {
  shadowColor: "#0D211B",
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.08,
  shadowRadius: 8,
  elevation: 2
} satisfies ViewStyle;
