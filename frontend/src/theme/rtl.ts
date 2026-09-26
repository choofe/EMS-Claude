import createCache from "@emotion/cache";
import rtlPlugin from "stylis-plugin-rtl";
import { prefixer } from "stylis";

/**
 * Emotion cache that runs MUI's CSS-in-JS output through stylis-plugin-rtl,
 * so component styles (padding-left/right, margins, flex-direction, etc.)
 * are automatically mirrored for RTL — this is the piece that makes MUI's
 * native RTL support actually work, not just the theme's `direction: "rtl"`
 * flag on its own.
 */
export const rtlCache = createCache({
  key: "mui-rtl",
  stylisPlugins: [prefixer, rtlPlugin],
});
