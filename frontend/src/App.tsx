import { CacheProvider } from "@emotion/react";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { rtlCache } from "./theme/rtl";
import { theme } from "./theme/theme";
import { HealthCheck } from "./pages/HealthCheck";

export default function App() {
  return (
    <CacheProvider value={rtlCache}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <HealthCheck />
      </ThemeProvider>
    </CacheProvider>
  );
}
