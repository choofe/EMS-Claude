import { createTheme } from "@mui/material/styles";

/**
 * Phase 1 scope: a minimal, functional theme (RTL + Persian typography
 * wired up correctly) rather than a finished visual identity — the real
 * UI/UX pass is Phase 11 per the phase plan. Colors and density here are
 * deliberately plain placeholders, not a design decision.
 */
export const theme = createTheme({
  direction: "rtl",
  typography: {
    fontFamily: ['"Vazirmatn"', "Tahoma", "Arial", "sans-serif"].join(","),
  },
  palette: {
    mode: "light",
    primary: {
      main: "#2f6f4f",
    },
  },
});
